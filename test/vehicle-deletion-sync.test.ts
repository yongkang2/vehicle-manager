import { test } from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { Business } from '../server/business.js'
import { LocalStore } from '../server/store.js'
import { BusinessSync, atomicFile } from '../server/sync.js'
import { SharedBusinessSnapshot } from '../server/deletions.js'
import { TeamDirectory } from '../server/team.js'
import type { Actor, BusinessRecord, VehicleDeletePreview, VehicleDeleteRequest, VehicleDeletion } from '../shared/business.js'

test('snapshot publishing retains the latest thirty and never removes the current head', async () => {
  const directory = await fs.mkdtemp(path.join(tmpdir(), 'vehicle-snapshot-retention-')), shared = path.join(directory, 'shared')
  await fs.mkdir(shared)
  const store = new LocalStore(path.join(directory, 'local')), business = new Business(store)
  let snapshot: SharedBusinessSnapshot | null = null
  try {
    snapshot = await SharedBusinessSnapshot.open(business, shared, 'retention-team', atomicFile)
    for (let index = 0; index < 35; index++) await snapshot.publish('retention-team', 1)
    const files = await fs.readdir(path.join(shared, 'business', 'snapshots'))
    const head = JSON.parse(await fs.readFile(path.join(shared, 'business', 'HEAD.json'), 'utf8')) as { revision: string }
    assert.equal(files.length, 30)
    assert.ok(files.includes(`${head.revision}.sqlite`))
  } finally { await snapshot?.close(); store.db.close(); await fs.rm(directory, { recursive: true, force: true }) }
})

async function fixture() {
  const directory = await fs.mkdtemp(path.join(tmpdir(), 'vehicle-deletion-sync-')), shared = path.join(directory, 'shared')
  await fs.mkdir(shared)
  const clients = ['alpha', 'beta'].map(name => {
    const store = new LocalStore(path.join(directory, name)), business = new Business(store), teams = new TeamDirectory()
    return { store, business, teams, sync: new BusinessSync(business, teams), identity: { deviceId: store.deviceId, deviceName: name, localUserId: name, displayName: name }, actor: null as Actor | null }
  })
  const [alpha, beta] = clients, team = await alpha.teams.create(shared, 'Deletion test', alpha.identity)
  const request = await beta.teams.join(shared, team.id, beta.identity)
  const approved = await alpha.teams.approve(shared, team.id, alpha.identity, request.requests[0].id, 'admin', null, 'Approved test client')
  for (const client of clients) client.actor = { id: approved.bindings.find(binding => binding.deviceId === client.identity.deviceId)!.memberId, name: client.identity.displayName, role: 'admin', deviceId: client.store.deviceId }
  const synchronize = async (index: number) => {
    const state = await clients[index].sync.synchronize(shared, team.id, clients[index].identity)
    return state
  }
  const head = async () => JSON.parse(await fs.readFile(path.join(shared, 'business', 'HEAD.json'), 'utf8')) as { protocol: number; revision: string; sequence: number }
  const seed = async (archived = true, pullArchive = true) => {
    const car = alpha.business.write({ kind: 'vehicle', data: { vin: 'TEST0000000000001', status: 'available', physicalLocation: 'Workshop' }, actor: alpha.actor!, reason: 'Register vehicle' })
    const children: BusinessRecord[] = []
    for (const kind of ['part', 'modification', 'equipment'] as const) children.push(alpha.business.write({ kind, vehicleId: car.id, data: { name: kind === 'part' ? 'VCU' : kind, ...(kind === 'part' ? { category: 'controller' } : {}) }, actor: alpha.actor!, reason: 'Create child' }))
    const bytes = Buffer.from('Retained original file'), key = await alpha.business.blob(bytes)
    for (const kind of ['report', 'attachment'] as const) children.push(alpha.business.write({ kind, vehicleId: car.id, data: { name: `${kind}.bin`, checksum: key, size: bytes.length }, actor: alpha.actor!, reason: 'Retain original', internal: true }))
    assert.equal((await synchronize(0)).phase, 'ready'); assert.equal((await synchronize(1)).phase, 'ready')
    if (archived) {
      const current = alpha.business.get(car.id)
      alpha.business.write({ id: car.id, kind: 'vehicle', data: current.data, version: current.version, archived: true, actor: alpha.actor!, reason: 'Archive before deletion' })
      assert.equal((await synchronize(0)).phase, 'ready')
      if (pullArchive) assert.equal((await synchronize(1)).phase, 'ready')
    }
    return { id: car.id, children, bytes, key }
  }
  const preview = (id: string, index = 0) => clients[index].sync.deletePreview(shared, team.id, clients[index].identity, clients[index].actor!, id)
  const deletionRequest = (value: VehicleDeletePreview): VehicleDeleteRequest => ({ previewToken: value.token, version: value.version, vin: value.vin, confirmation: 'DELETE', reason: 'Remove test vehicle', requestId: randomUUID() })
  const remove = (id: string, request: VehicleDeleteRequest, index = 0) => clients[index].sync.deleteVehicle(shared, team.id, clients[index].identity, clients[index].actor!, id, request)
  const close = async () => { for (const client of clients) { await client.sync.settle(); client.store.db.close() }; await fs.rm(directory, { recursive: true, force: true }) }
  return { directory, shared, clients, team, synchronize, head, seed, preview, deletionRequest, remove, close }
}

test('online archived-vehicle deletion publishes protocol 2 atomically, cascades all children, retains history/blobs and permits a new UUID for the same VIN', async () => {
  const context = await fixture()
  try {
    const seeded = await context.seed(), [alpha, beta] = context.clients
    const prior = await context.head(), historyCount = alpha.business.history(seeded.id).length
    assert.equal(prior.protocol, 1)
    const preview = await context.preview(seeded.id)
    assert.deepEqual(preview.counts, { vehicle: 1, part: 1, modification: 1, equipment: 1, report: 1, attachment: 1 })
    assert.equal(preview.protocolUpgrade, true)
    const request = context.deletionRequest(preview), receipt = await context.remove(seeded.id, request)
    assert.equal(receipt.localSynced, true)
    assert.equal(receipt.recordIds.length, 6); assert.deepEqual(receipt.fileKeys, [seeded.key])
    assert.equal((await context.head()).protocol, 2)
    assert.equal((await context.head()).sequence, prior.sequence + 1)
    assert.equal(alpha.business.list().length, 0)
    assert.equal(alpha.business.history(seeded.id).length, historyCount + 1)
    assert.ok(alpha.business.history(seeded.id).some(change => change.action === 'vehicle.deleted' && change.reason === request.reason))
    assert.deepEqual(await alpha.business.readBlob(seeded.key), seeded.bytes)
    assert.deepEqual(await fs.readFile(path.join(context.shared, 'business', 'blobs', seeded.key)), seeded.bytes)
    assert.equal((await context.synchronize(1)).phase, 'ready')
    assert.equal(beta.business.list().length, 0); assert.equal(beta.store.deletionRows()[0].id, receipt.id)
    assert.throws(() => beta.business.get(seeded.children[0].id), { code: 'VEHICLE_DELETED' })
    const replacement = alpha.business.write({ kind: 'vehicle', data: { vin: receipt.vin, status: 'available' }, actor: alpha.actor!, reason: 'Register replacement identity' })
    assert.notEqual(replacement.id, seeded.id)
    await context.synchronize(0); await context.synchronize(1)
    assert.deepEqual(beta.business.list().map(row => row.id), [replacement.id])
    assert.equal((await context.head()).protocol, 2)
  } finally { await context.close() }
})

test('stale offline edits and newly created children are quarantined without losing payloads/history or permitting conflict resurrection', async () => {
  const context = await fixture()
  try {
    const seeded = await context.seed(true, false), beta = context.clients[1], current = beta.business.get(seeded.id)
    beta.business.write({ id: seeded.id, kind: 'vehicle', data: { ...current.data, owner: 'Offline driver' }, version: current.version, actor: beta.actor!, reason: 'Offline edit' })
    const child = beta.business.write({ kind: 'equipment', vehicleId: seeded.id, data: { name: 'Offline logger' }, actor: beta.actor!, reason: 'Offline child' })
    const pending = beta.store.db.prepare("SELECT payload FROM outbox WHERE state='pending' ORDER BY seq").all().map(row => JSON.parse(String(row.payload)))
    const preview = await context.preview(seeded.id)
    await context.remove(seeded.id, context.deletionRequest(preview))
    const state = await context.synchronize(1)
    assert.equal(state.phase, 'ready'); assert.equal(state.pending, 0); assert.equal(state.quarantined, 2); assert.deepEqual(state.conflicts, [])
    assert.equal(beta.business.list().length, 0)
    assert.deepEqual(beta.store.quarantineRows().map(row => row.operation.id).sort(), pending.map(row => row.id).sort())
    assert.ok(beta.store.quarantineRows().some(row => row.operation.recordId === child.id && row.operation.desired.data.name === 'Offline logger'))
    assert.ok(beta.business.history(seeded.id).some(change => change.reason === 'Offline edit'))
    assert.ok(beta.business.history(seeded.id).some(change => change.reason === 'Offline child'))
    await assert.rejects(beta.sync.resolve(context.shared, context.team.id, beta.identity, beta.actor!, seeded.id, 'old-token', {}, 'Attempt resurrection'), { code: 'VEHICLE_DELETED' })
    assert.throws(() => beta.business.write({ kind: 'equipment', vehicleId: seeded.id, data: { name: 'New child' }, actor: beta.actor!, reason: 'Blocked child' }), { code: 'VEHICLE_DELETED' })
  } finally { await context.close() }
})

test('already published operations are acknowledged before applying deletion markers instead of being quarantined', async () => {
  const context = await fixture()
  try {
    const seeded = await context.seed(), beta = context.clients[1]
    const operation = beta.store.db.prepare('SELECT id FROM outbox ORDER BY seq DESC LIMIT 1').get()
    assert.equal(operation, undefined)
    // Alpha missed acknowledgement of its archive operation, which is already in master.applied.
    const alpha = context.clients[0], archive = alpha.store.db.prepare('SELECT id FROM outbox ORDER BY seq DESC LIMIT 1').get()!
    const preview = await context.preview(seeded.id)
    await context.remove(seeded.id, context.deletionRequest(preview))
    alpha.store.db.prepare("UPDATE outbox SET state='pending' WHERE id=?").run(archive.id)
    assert.equal((await context.synchronize(0)).quarantined, 0)
    assert.equal(alpha.store.db.prepare('SELECT state FROM outbox WHERE id=?').get(archive.id)!.state, 'sent')
  } finally { await context.close() }
})

test('deletion requires archive first, an unchanged actor-bound preview, exact confirmation and reason', async t => {
  const context = await fixture()
  try {
    const seeded = await context.seed(false), alpha = context.clients[0]
    await assert.rejects(context.preview(seeded.id), { code: 'VEHICLE_NOT_ARCHIVED' })
    const current = alpha.business.get(seeded.id)
    alpha.business.write({ id: seeded.id, kind: 'vehicle', data: current.data, version: current.version, archived: true, actor: alpha.actor!, reason: 'Archive' })
    await context.synchronize(0); await context.synchronize(1)
    const preview = await context.preview(seeded.id), request = context.deletionRequest(preview)
    await assert.rejects(context.remove(seeded.id, { ...request, confirmation: 'delete' }), { code: 'DELETE_CONFIRMATION_REQUIRED' })
    await assert.rejects(context.remove(seeded.id, { ...request, reason: '  ' }), { code: 'REASON_REQUIRED' })
    await assert.rejects(context.remove(seeded.id, { ...request, vin: 'TEST0000000000002' }), { code: 'DELETE_PREVIEW_CHANGED' })
    const beta = context.clients[1]
    await assert.rejects(alpha.sync.deleteVehicle(context.shared, context.team.id, beta.identity, beta.actor!, seeded.id, request), { code: 'DELETE_PREVIEW_CHANGED' })
    const timestamp = Date.now(); t.mock.method(Date, 'now', () => timestamp + 5 * 60 * 1000 + 1)
    await assert.rejects(context.remove(seeded.id, request), { code: 'DELETE_PREVIEW_EXPIRED' })
    t.mock.restoreAll()
  } finally { await context.close() }
})

test('local target pending operations are rejected before preview refresh can publish or discard them', async () => {
  const context = await fixture()
  try {
    const seeded = await context.seed(), alpha = context.clients[0], current = alpha.business.get(seeded.id), prior = await context.head()
    alpha.business.write({ id: seeded.id, kind: 'vehicle', data: current.data, version: current.version, archived: false, actor: alpha.actor!, reason: 'Pending restore' })
    await assert.rejects(context.preview(seeded.id), { code: 'DELETE_PENDING_CHANGES' })
    assert.equal(alpha.sync.status().pending, 1); assert.deepEqual(await context.head(), prior)
  } finally { await context.close() }
})

test('a changed canonical child invalidates the preview even when the parent local version is unchanged', async () => {
  const context = await fixture()
  try {
    const seeded = await context.seed(), preview = await context.preview(seeded.id), beta = context.clients[1]
    const part = beta.business.get(seeded.children[0].id)
    beta.business.write({ id: part.id, kind: part.kind, vehicleId: part.vehicleId, data: { ...part.data, notes: 'Changed by administrator restore' }, version: part.version, archived: true, actor: beta.actor!, reason: 'Restore changed child', maintenance: 'restore' })
    assert.equal((await context.synchronize(1)).phase, 'ready')
    assert.equal(context.clients[0].business.get(seeded.id).version, preview.version)
    await assert.rejects(context.remove(seeded.id, context.deletionRequest(preview)), { code: 'DELETE_PREVIEW_CHANGED' })
  } finally { await context.close() }
})

test('committed request retries survive service restart, remain idempotent, and reject changed request bodies or revoked administrators', async () => {
  const context = await fixture()
  try {
    const seeded = await context.seed(), preview = await context.preview(seeded.id), request = context.deletionRequest(preview), receipt = await context.remove(seeded.id, request)
    const alpha = context.clients[0], head = await context.head()
    alpha.sync = new BusinessSync(alpha.business, alpha.teams)
    const retried = await context.remove(seeded.id, request)
    assert.equal(retried.id, receipt.id); assert.equal(retried.localSynced, true); assert.deepEqual(await context.head(), head)
    await assert.rejects(context.remove(seeded.id, { ...request, reason: 'Different request' }), { code: 'DELETE_REQUEST_MISMATCH' })
    await context.clients[1].teams.changeMember(context.shared, context.team.id, context.clients[1].identity, alpha.actor!.id, 'member', true, 'Revoke privilege')
    await assert.rejects(context.remove(seeded.id, request), { code: 'ADMIN_REQUIRED' })
  } finally { await context.close() }
})

test('failure before HEAD publication leaves the archived vehicle intact and permits a safe request retry', async t => {
  const context = await fixture()
  try {
    const seeded = await context.seed(), preview = await context.preview(seeded.id), request = context.deletionRequest(preview), prior = await context.head()
    const rename = fs.rename
    t.mock.method(fs, 'rename', async (source, target) => { if (String(target).endsWith('HEAD.json')) throw new Error('Injected publication failure'); return rename(source, target) })
    await assert.rejects(context.remove(seeded.id, request), { code: 'SHARE_IO_ERROR' })
    t.mock.restoreAll()
    assert.deepEqual(await context.head(), prior)
    assert.equal(context.clients[0].business.get(seeded.id).archived, true)
    assert.equal(context.clients[0].store.deletionRows().length, 0)
    assert.equal((await context.remove(seeded.id, request)).localSynced, true)
  } finally { await context.close() }
})

test('lost HEAD rename acknowledgement is verified from canonical storage and returns the committed receipt', async t => {
  const context = await fixture()
  try {
    const seeded = await context.seed(), preview = await context.preview(seeded.id), request = context.deletionRequest(preview), prior = await context.head()
    const rename = fs.rename
    t.mock.method(fs, 'rename', async (source, target) => { await rename(source, target); if (String(target).endsWith('HEAD.json')) throw new Error('Injected lost acknowledgement') })
    const receipt = await context.remove(seeded.id, request)
    t.mock.restoreAll()
    assert.equal(receipt.localSynced, true); assert.equal(receipt.requestId, request.requestId)
    assert.equal((await context.head()).sequence, prior.sequence + 1)
    assert.equal(context.clients[0].business.list().length, 0)
    assert.equal((await context.remove(seeded.id, request)).id, receipt.id)
  } finally { await context.close() }
})

test('a local refresh failure after publication reports the durable receipt and hides the vehicle until an idempotent retry refreshes it', async t => {
  const context = await fixture()
  try {
    const seeded = await context.seed(), preview = await context.preview(seeded.id), request = context.deletionRequest(preview), alpha = context.clients[0]
    t.mock.method(alpha.store, 'applyDeletions', () => { throw new Error('Injected local failure') })
    const receipt = await context.remove(seeded.id, request)
    assert.equal(receipt.localSynced, false); assert.equal((await context.head()).protocol, 2)
    assert.equal(alpha.business.list().length, 0)
    assert.throws(() => alpha.business.get(seeded.id), { code: 'VEHICLE_DELETED' })
    assert.ok(alpha.store.db.prepare('SELECT id FROM records WHERE id=?').get(seeded.id))
    t.mock.restoreAll()
    const retried = await context.remove(seeded.id, request)
    assert.equal(retried.id, receipt.id); assert.equal(retried.localSynced, true)
    assert.equal(alpha.store.db.prepare('SELECT id FROM records WHERE id=?').get(seeded.id), undefined)
  } finally { await context.close() }
})

test('maintenance drains admitted asynchronous workflows and rejects newly arriving writes before checking target pending state', async () => {
  const context = await fixture()
  try {
    const seeded = await context.seed(), alpha = context.clients[0]
    let release!: () => void, entered!: () => void
    const ready = new Promise<void>(resolve => { entered = resolve }), barrier = new Promise<void>(resolve => { release = resolve })
    const workflow = alpha.store.runWrite(async () => {
      entered(); await barrier
      const current = alpha.business.get(seeded.id)
      alpha.business.write({ id: seeded.id, kind: 'vehicle', data: current.data, version: current.version, archived: false, actor: alpha.actor!, reason: 'Admitted workflow completes' })
    })
    await ready
    const preview = context.preview(seeded.id)
    const rejected = assert.rejects(preview, { code: 'DELETE_PENDING_CHANGES' })
    await assert.rejects(alpha.store.runWrite(() => undefined), { code: 'MAINTENANCE_IN_PROGRESS' })
    release(); await workflow; await rejected
  } finally { await context.close() }
})

test('authorized restored deletion markers publish protocol 2 without deleting live rows and retain historical receipt sequence', async () => {
  const context = await fixture()
  try {
    await context.seed(false)
    const alpha = context.clients[0], id = randomUUID(), marker: VehicleDeletion = { id: randomUUID(), requestId: randomUUID(), vehicleId: id, vin: 'TEST0000000000009', recordIds: [id], fileKeys: [], actor: alpha.actor!, reason: 'Historical deletion', deletedAt: new Date().toISOString(), revision: randomUUID(), sequence: 99 }
    alpha.store.applyDeletions([marker]); alpha.store.set('pendingDeletionImports', [{ deletion: marker, actor: alpha.actor! }])
    assert.equal((await context.synchronize(0)).phase, 'ready')
    assert.equal((await context.head()).protocol, 2)
    assert.deepEqual(alpha.store.get('pendingDeletionImports'), [])
    await context.synchronize(1)
    assert.equal(context.clients[1].store.deletionFor(id)!.sequence, 99)
  } finally { await context.close() }
})

test('restored marker imports require current administrator authorization and cannot erase canonical live vehicles', async () => {
  const context = await fixture()
  try {
    const seeded = await context.seed(false), [alpha, beta] = context.clients, prior = await context.head()
    const marker: VehicleDeletion = { id: randomUUID(), requestId: randomUUID(), vehicleId: seeded.id, vin: 'TEST0000000000001', recordIds: [seeded.id], fileKeys: [], actor: alpha.actor!, reason: 'Imported marker', deletedAt: new Date().toISOString(), revision: randomUUID(), sequence: 1 }
    alpha.store.set('pendingDeletionImports', [{ deletion: marker, actor: alpha.actor! }])
    assert.equal((await context.synchronize(0)).error, 'BACKUP_DELETION_CONFLICT')
    assert.deepEqual(await context.head(), prior)
    const absent = { ...marker, vehicleId: randomUUID() }; absent.recordIds = [absent.vehicleId]
    alpha.store.set('pendingDeletionImports', [{ deletion: absent, actor: beta.actor! }])
    await alpha.teams.changeMember(context.shared, context.team.id, alpha.identity, beta.actor!.id, 'member', true, 'Revoke import privilege')
    assert.equal((await context.synchronize(0)).error, 'ADMIN_REQUIRED')
    assert.deepEqual(await context.head(), prior)
  } finally { await context.close() }
})

test('published deletion uses protocol 2 and rejects a locally observed downgrade', async () => {
  const context = await fixture()
  try {
    const seeded = await context.seed(), preview = await context.preview(seeded.id)
    await context.remove(seeded.id, context.deletionRequest(preview))
    const head = await context.head()
    // The old client rejects this exact protocol field before loading or publishing its SQLite work copy.
    assert.notEqual(head.protocol, 1)
    const master = new DatabaseSync(path.join(context.shared, 'business', 'snapshots', `${head.revision}.sqlite`), { readOnly: true })
    try { assert.equal(master.prepare('SELECT COUNT(*) AS total FROM vehicle_deletions').get()!.total, 1) } finally { master.close() }
    await fs.writeFile(path.join(context.shared, 'business', 'HEAD.json'), JSON.stringify({ ...head, protocol: 1 }))
    assert.equal((await context.synchronize(0)).error, 'BUSINESS_ROLLBACK')
  } finally { await context.close() }
})
