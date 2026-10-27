import { test } from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { ZipArchive } from 'archiver'
import unzipper from 'unzipper'
import { Business } from '../server/business.js'
import { LocalStore } from '../server/store.js'
import { BusinessSync } from '../server/sync.js'
import { TeamDirectory } from '../server/team.js'
import { VehiclePhotos } from '../server/vehicle-photos.js'
import { createBackup, restoreBackup } from '../server/backup.js'
import { parsePhotoAttachmentId } from '../shared/vehicle-photo.js'
import type { Actor, BusinessRecord, Fields } from '../shared/business.js'

const png = () => Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==', 'base64')
async function fixture() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'vehicle-photo-sync-')), shared = path.join(directory, 'shared')
  await fs.mkdir(shared)
  const clients = ['alpha', 'beta'].map(name => {
    const store = new LocalStore(path.join(directory, name)), business = new Business(store), teams = new TeamDirectory()
    return { store, business, photos: new VehiclePhotos(business), teams, sync: new BusinessSync(business, teams), identity: { deviceId: store.deviceId, deviceName: name, localUserId: name, displayName: name }, actor: null as Actor | null }
  })
  const [alpha, beta] = clients, team = await alpha.teams.create(shared, 'Vehicle photo test team', alpha.identity)
  const requested = await beta.teams.join(shared, team.id, beta.identity)
  const approved = await alpha.teams.approve(shared, team.id, alpha.identity, requested.requests[0].id, 'admin', null, 'Approve photo test client')
  for (const client of clients) client.actor = { id: approved.bindings.find(binding => binding.deviceId === client.store.deviceId)!.memberId, name: client.identity.displayName, deviceId: client.store.deviceId, role: 'admin' }
  const synchronize = (index: number) => clients[index].sync.synchronize(shared, team.id, clients[index].identity)
  const converge = async () => {
    for (const index of [0, 1, 0]) {
      const state = await synchronize(index)
      assert.equal(state.phase, 'ready'); assert.equal(state.pending, 0); assert.deepEqual(state.conflicts, [])
    }
  }
  const seed = async (photo = true) => {
    const car = alpha.business.write({ kind: 'vehicle', data: { vin: 'TEST0000000000001', status: 'available' }, actor: alpha.actor!, reason: 'Register photo test vehicle' })
    if (photo) await alpha.photos.upload(car.id, { name: 'original.png', bytes: png() }, car.version, 'Choose original photo', alpha.actor!)
    await converge()
    return alpha.business.get(car.id)
  }
  const edit = (index: number, id: string, fields: Fields, archived?: boolean) => {
    const client = clients[index], current = client.business.get(id)
    return client.business.write({ id, kind: 'vehicle', data: { ...current.data, ...fields }, version: current.version, actor: client.actor!, reason: 'Update photo test vehicle', ...(archived === undefined ? {} : { archived }) })
  }
  const close = async () => { for (const client of clients) client.store.db.close(); await fs.rm(directory, { recursive: true, force: true }) }
  return { directory, shared, clients, teamId: team.id, seed, edit, synchronize, converge, close }
}

for (const order of [[0, 1], [1, 0]]) {
  test(`new cover and unrelated vehicle edit merge in sync order ${order.join(',')}`, async () => {
    const context = await fixture()
    try {
      const car = await context.seed(), alpha = context.clients[0]
      const replacement = await alpha.photos.upload(car.id, { name: 'replacement.png', bytes: png() }, alpha.business.get(car.id).version, 'Replace shared photo', alpha.actor!)
      context.edit(1, car.id, { owner: 'Independent owner edit' })
      for (const index of order) assert.equal((await context.synchronize(index)).phase, 'ready')
      await context.converge()
      for (const client of context.clients) {
        assert.equal(client.business.get(car.id).data.owner, 'Independent owner edit')
        assert.equal(client.business.get(car.id).data.photoAttachmentId, replacement.attachment.id)
        assert.deepEqual((await client.photos.read(car.id)).bytes, png())
        assert.equal(client.business.list('attachment', car.id).length, 2)
      }
      const head = JSON.parse(await fs.readFile(path.join(context.shared, 'business', 'HEAD.json'), 'utf8'))
      assert.equal(head.protocol, 1)
    } finally { await context.close() }
  })
}

for (const choice of ['local', 'shared']) {
  test(`competing photo references remain a real conflict resolved with ${choice}`, async () => {
    const context = await fixture()
    try {
      const car = await context.seed(), [alpha, beta] = context.clients
      const chosen = await Promise.all(context.clients.map(client => client.photos.upload(car.id, { name: `${client.identity.deviceName}.png`, bytes: png() }, client.business.get(car.id).version, 'Choose competing cover', client.actor!)))
      assert.equal((await context.synchronize(0)).phase, 'ready')
      const state = await context.synchronize(1), conflict = state.conflicts[0]
      assert.equal(state.phase, 'conflict'); assert.equal(conflict.recordId, car.id)
      assert.deepEqual(conflict.fields, ['photoAttachmentId'])
      await assert.rejects(beta.sync.resolve(context.shared, context.teamId, beta.identity, beta.actor!, car.id, 'stale-token', { photoAttachmentId: choice }, 'Invalid conflict decision'), { code: 'CONFLICT_CHANGED' })
      assert.equal((await beta.sync.resolve(context.shared, context.teamId, beta.identity, beta.actor!, car.id, conflict.token, { photoAttachmentId: choice }, 'Choose verified cover')).phase, 'ready')
      await context.converge()
      const winningId = chosen[choice === 'local' ? 1 : 0].attachment.id
      for (const client of [alpha, beta]) {
        assert.equal(client.business.get(car.id).data.photoAttachmentId, winningId)
        assert.equal((await client.photos.read(car.id)).attachmentId, winningId)
        assert.equal(client.business.list('attachment', car.id).length, 3)
      }
    } finally { await context.close() }
  })
}

for (const order of [[0, 1], [1, 0]]) {
  test(`clearing a legacy missing cover does not create a false conflict with matching archives in order ${order.join(',')}`, async () => {
    const context = await fixture()
    try {
      const car = await context.seed(false), beta = context.clients[1]
      for (const client of context.clients) assert.equal(Object.hasOwn(client.business.get(car.id).data, 'photoAttachmentId'), false)
      context.edit(0, car.id, {}, true)
      beta.photos.remove(car.id, beta.business.get(car.id).version, 'Explicitly clear absent cover', beta.actor!)
      context.edit(1, car.id, {}, true)
      for (const index of order) assert.equal((await context.synchronize(index)).phase, 'ready')
      await context.converge()
      for (const client of context.clients) {
        assert.equal(client.business.get(car.id).archived, true)
        assert.equal(parsePhotoAttachmentId(client.business.get(car.id).data.photoAttachmentId), '')
      }
    } finally { await context.close() }
  })
}

test('a blank photo normalization cannot silently undo a concurrent vehicle archive', async () => {
  const context = await fixture()
  try {
    const car = await context.seed(false), beta = context.clients[1]
    context.edit(0, car.id, {}, true)
    beta.photos.remove(car.id, beta.business.get(car.id).version, 'Clear blank local photo', beta.actor!)
    assert.equal((await context.synchronize(0)).phase, 'ready')
    const state = await context.synchronize(1), conflict = state.conflicts[0]
    assert.equal(state.phase, 'conflict')
    assert.deepEqual(conflict.fields, ['_archived'])
    await beta.sync.resolve(context.shared, context.teamId, beta.identity, beta.actor!, car.id, conflict.token, { _archived: 'shared' }, 'Keep shared archive status')
    await context.converge()
    for (const client of context.clients) assert.equal(client.business.get(car.id).archived, true)
  } finally { await context.close() }
})

type Manifest = { format: number; records: BusinessRecord[]; deletions?: unknown[]; quarantinedOperations?: unknown[]; [key: string]: unknown }
async function rewriteBackup(bytes: Buffer, mutate: (manifest: Manifest) => void): Promise<Buffer> {
  const original = await unzipper.Open.buffer(bytes), archive = new ZipArchive({ zlib: { level: 6 } }), chunks: Buffer[] = []
  const complete = new Promise<Buffer>((resolve, reject) => { archive.on('data', (chunk: Buffer) => chunks.push(chunk)); archive.once('error', reject); archive.once('end', () => resolve(Buffer.concat(chunks))) })
  for (const entry of original.files) {
    const content = await entry.buffer()
    if (entry.path === 'manifest.json') { const manifest = JSON.parse(content.toString()) as Manifest; mutate(manifest); archive.append(JSON.stringify(manifest), { name: entry.path }) }
    else archive.append(content, { name: entry.path })
  }
  void archive.finalize()
  return complete
}
async function backupFixture() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'vehicle-photo-backup-'))
  const stores = ['source', 'target'].map(name => new LocalStore(path.join(directory, name)))
  const clients = stores.map(store => { const business = new Business(store); return { store, business, photos: new VehiclePhotos(business) } })
  const actor: Actor = { id: 'admin', name: 'Photo backup tester', role: 'admin', deviceId: stores[0].deviceId }
  const create = (client: typeof clients[number], vin = 'TEST0000000000001') => client.business.write({ kind: 'vehicle', data: { vin, status: 'available' }, actor, reason: 'Register backup test vehicle' })
  const sent = () => { for (const store of stores) store.db.exec("UPDATE outbox SET state='sent'") }
  const close = async () => { for (const store of stores) store.db.close(); await fs.rm(directory, { recursive: true, force: true }) }
  return { clients, actor, create, sent, close }
}

test('format 2 backups preserve the cover reference, original bytes and history, not personal settings', async () => {
  const context = await backupFixture()
  try {
    const [source, target] = context.clients, car = context.create(source)
    const photo = await source.photos.upload(car.id, { name: 'backup.png', bytes: png() }, car.version, 'Choose backed-up cover', context.actor)
    source.store.set('vehicleTablePreferences:private-local-account', { privateSentinel: 'DO-NOT-BACKUP-PERSONAL-COLUMNS', visible: ['vehicle', 'owner', 'actions'] })
    const bytes = await createBackup(source.business, 'photo-team'), archive = await unzipper.Open.buffer(bytes)
    const manifest = JSON.parse((await archive.files.find(file => file.path === 'manifest.json')!.buffer()).toString())
    assert.equal(manifest.format, 3)
    assert.equal(manifest.records.find((record: BusinessRecord) => record.id === car.id).data.photoAttachmentId, photo.attachment.id)
    assert.equal(JSON.stringify(manifest).includes('DO-NOT-BACKUP-PERSONAL-COLUMNS'), false)
    const result = await restoreBackup(target.business, bytes, 'photo-team', context.actor, 'Restore selected photo')
    assert.equal(result.changed, 2)
    assert.equal(target.business.get(car.id).data.photoAttachmentId, photo.attachment.id)
    assert.deepEqual((await target.photos.read(car.id)).bytes, png())
    assert.ok(target.business.history(car.id).some(change => change.reason === 'Choose backed-up cover' && change.after.photoAttachmentId === photo.attachment.id))
    assert.equal(target.store.get('vehicleTablePreferences:private-local-account'), null)
  } finally { await context.close() }
})

for (const format of [1, 2]) {
  test(`format ${format} backups without photo metadata explicitly clear an existing cover`, async () => {
    const context = await backupFixture()
    try {
      const [source, target] = context.clients, car = context.create(source)
      const oldBackup = await createBackup(source.business, 'photo-team')
      const bytes = await rewriteBackup(oldBackup, manifest => { manifest.format = format; if (format === 1) { delete manifest.deletions; delete manifest.quarantinedOperations } })
      await restoreBackup(target.business, bytes, 'photo-team', context.actor, 'Initial legacy restore')
      const current = target.business.get(car.id), uploaded = await target.photos.upload(car.id, { name: 'newer.png', bytes: png() }, current.version, 'Newer local cover', context.actor)
      context.sent()
      await restoreBackup(target.business, bytes, 'photo-team', context.actor, 'Restore pre-photo backup', [uploaded.attachment.id])
      assert.equal(target.business.get(car.id).data.photoAttachmentId, '')
      await assert.rejects(target.photos.read(car.id), { code: 'PHOTO_NOT_FOUND' })
      assert.equal(target.business.get(uploaded.attachment.id).archived, true)
      assert.deepEqual(await target.business.readBlob(String(uploaded.attachment.data.checksum)), png())
    } finally { await context.close() }
  })
}

for (const invalid of ['missing', 'cross-vehicle', 'nonimage', 'metadata', 'path'] as const) {
  test(`backup rejects ${invalid} cover references before records, queues, settings or blobs are changed`, async () => {
    const context = await backupFixture()
    try {
      const [source, target] = context.clients, car = context.create(source), other = context.create(source, 'TEST0000000000002')
      const photo = await source.photos.upload(car.id, { name: 'photo.png', bytes: png() }, car.version, 'Original cover', context.actor)
      const ordinaryBytes = Buffer.from('%PDF-1.4 not an image'), ordinaryKey = await source.business.blob(ordinaryBytes)
      const ordinary = source.business.write({ kind: 'attachment', vehicleId: car.id, data: { name: 'not-image.pdf', checksum: ordinaryKey, size: ordinaryBytes.length, purpose: 'vehiclePhoto', mime: 'image/png', width: 1, height: 1 }, actor: context.actor, reason: 'Test non-image reference', internal: true })
      const backup = await createBackup(source.business, 'photo-team')
      const bytes = await rewriteBackup(backup, manifest => {
        const vehicle = manifest.records.find(record => record.id === car.id)!, attachment = manifest.records.find(record => record.id === photo.attachment.id)!
        if (invalid === 'missing') vehicle.data.photoAttachmentId = randomUUID()
        else if (invalid === 'cross-vehicle') attachment.vehicleId = other.id
        else if (invalid === 'nonimage') vehicle.data.photoAttachmentId = ordinary.id
        else if (invalid === 'metadata') attachment.data.width = 2
        else vehicle.data.photoAttachmentId = 'https://example.com/p.png'
      })
      const before = target.business.list(), beforeSettings = target.store.db.prepare('SELECT * FROM settings ORDER BY key').all()
      await assert.rejects(restoreBackup(target.business, bytes, 'photo-team', context.actor, 'Reject invalid photo reference'), error => error instanceof Error && 'code' in error && ['INVALID_BACKUP', 'INVALID_INPUT'].includes(String(error.code)))
      assert.deepEqual(target.business.list(), before)
      assert.equal(target.store.db.prepare('SELECT COUNT(*) AS total FROM outbox').get()!.total, 0)
      assert.equal(target.store.db.prepare('SELECT COUNT(*) AS total FROM changes').get()!.total, 0)
      assert.deepEqual(target.store.db.prepare('SELECT * FROM settings ORDER BY key').all(), beforeSettings)
      await assert.rejects(fs.access(path.join(target.store.directory, 'blobs')))
    } finally { await context.close() }
  })
}

test('a deleted vehicle quarantines a newly uploaded offline cover operation and preserves its original file', async () => {
  const context = await fixture()
  try {
    const car = await context.seed(), [alpha, beta] = context.clients
    const offline = await beta.photos.upload(car.id, { name: 'offline.png', bytes: png() }, beta.business.get(car.id).version, 'Offline replacement to preserve', beta.actor!)
    context.edit(0, car.id, {}, true)
    assert.equal((await context.synchronize(0)).phase, 'ready')
    const preview = await alpha.sync.deletePreview(context.shared, context.teamId, alpha.identity, alpha.actor!, car.id)
    await alpha.sync.deleteVehicle(context.shared, context.teamId, alpha.identity, alpha.actor!, car.id, { previewToken: preview.token, version: preview.version, vin: String(car.data.vin), confirmation: 'DELETE', reason: 'Delete archived vehicle', requestId: randomUUID() })
    const synchronized = await context.synchronize(1)
    assert.equal(synchronized.pending, 0); assert.equal(synchronized.quarantined, 2)
    assert.throws(() => beta.business.get(car.id), { code: 'VEHICLE_DELETED' })
    const preserved = beta.store.quarantineRows().find(entry => entry.operation.recordId === offline.attachment.id)!
    assert.equal(preserved.operation.desired.data.name, 'offline.png')
    assert.deepEqual(preserved.operation.files, [offline.attachment.data.checksum])
    assert.deepEqual(await beta.business.readBlob(String(offline.attachment.data.checksum)), png())
    const archived = await unzipper.Open.buffer(await createBackup(beta.business, context.teamId))
    assert.ok(archived.files.some(file => file.path === `blobs/${offline.attachment.data.checksum}`))
    assert.equal(beta.business.list().length, 0)
  } finally { await context.close() }
})
