import { test } from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { randomUUID } from 'node:crypto'
import { Business } from '../server/business.js'
import { BusinessSync } from '../server/sync.js'
import { LocalStore } from '../server/store.js'
import { AppError, TeamDirectory } from '../server/team.js'
import { ConfigurationRevisions } from '../server/configuration-revisions.js'
import { SharedBusinessSnapshot } from '../server/deletions.js'
import { Modifications } from '../server/modifications.js'
import { createBackup, previewBackup, restoreBackup } from '../server/backup.js'
import { applyRestore, restoreReceipts } from '../server/restore-operations.js'
import { abandonModificationRestore, exportModificationRestore } from '../server/modification-recovery.js'
import unzipper from 'unzipper'
import type { ModificationImport } from '../shared/modifications.js'
import type { ModificationContext } from '../server/modifications.js'
import type { Actor, BusinessRecord, Change } from '../shared/business.js'
import type { ModificationFile, ModificationMutation, ModificationPopulateRequest, ModificationView } from '../shared/modifications.js'

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vm-modification-service-')), shared = path.join(root, 'share')
  await fs.mkdir(shared)
  const clients = ['admin', 'member'].map(name => {
    const store = new LocalStore(path.join(root, name)), business = new Business(store), teams = new TeamDirectory(), sync = new BusinessSync(business, teams)
    const identity = { deviceId: store.deviceId, deviceName: name, localUserId: name, displayName: name }
    return { store, business, teams, sync, identity, modifications: new Modifications(business, sync), context: null as ModificationContext | null }
  })
  const [admin, member] = clients, team = await admin.teams.create(shared, 'Fictional modification team', admin.identity)
  const joined = await member.teams.join(shared, team.id, member.identity)
  const approved = await admin.teams.approve(shared, team.id, admin.identity, joined.requests[0].id, 'member', null, 'Approve fictional member')
  for (const client of clients) {
    const actorRecord = approved.members.find(row => row.id === approved.bindings.find(binding => binding.deviceId === client.identity.deviceId)!.memberId)!
    const actor: Actor = { id: actorRecord.id, name: actorRecord.name, role: actorRecord.role, deviceId: client.identity.deviceId }
    client.context = { directory: shared, teamId: team.id, identity: client.identity, actor, syncEnabled: true, online: true, scopeKey: client.identity.localUserId }
  }
  const cars = [1, 2, 3].map(number => admin.business.write({ kind: 'vehicle', data: { name: `Fictional ${number}`, vin: `TEST000000000000${number}`, status: 'available', complianceLevel: 'Eu7' }, actor: admin.context!.actor, reason: 'Create fictional vehicle' }))
  const modification = admin.business.write({ kind: 'modification', vehicleId: cars[0].id, data: { name: 'Fictional retrofit', description: 'Supplier change', requestor: '  External requester  ', lead: '  Test lead  ', installedAt: '2026-04-01', removedAt: '', notes: 'Retain original dates' }, actor: admin.context!.actor, reason: 'Record fictional work' })
  const synchronize = async (index = 0) => { const state = await clients[index].sync.synchronize(shared, team.id, clients[index].identity); assert.equal(state.error, null); assert.equal(state.phase, 'ready'); return state }
  await synchronize(); await synchronize(1)
  const enable = async () => { await admin.modifications.enable(admin.context!, { requestId: randomUUID(), reason: 'Team clients upgraded' }); await synchronize(1) }
  const head = async () => fs.readFile(path.join(shared, 'business', 'HEAD.json'), 'utf8')
  const close = async () => { for (const client of clients) { await client.sync.settle(); client.store.db.close() }; await fs.rm(root, { recursive: true, force: true }) }
  return { root, shared, team, clients, admin, member, cars, modification, synchronize, enable, head, close }
}
const mutation = (view: ModificationView, reason = 'Fictional modification change'): ModificationMutation => ({ requestId: randomUUID(), version: view.record.version, groupVersion: view.groupVersion, reason })
const populate = (view: ModificationView, cars: BusinessRecord[], mode: 'oneTime' | 'linked'): ModificationPopulateRequest => ({ ...mutation(view), mode, targets: cars.map(car => ({ vehicleId: car.id, expectedVin: String(car.data.vin) })) })
const rejects = (code: string) => (error: unknown) => (error as { code?: string }).code === code
const fieldsOf = (view: ModificationView) => Object.fromEntries(Object.entries(view.record.data).filter(([key]) => !['attachments', 'groupId'].includes(key)))

test('offline standalone edits cannot overwrite a membership created by another client', async () => {
  const f = await fixture()
  try {
    await f.enable()
    const { admin, member } = f, old = member.business.get(f.modification.id)
    member.business.write({ id: old.id, kind: 'modification', vehicleId: old.vehicleId, data: { ...old.data, lead: 'Offline independent edit' }, version: old.version, actor: member.context!.actor, reason: 'Offline edit before promotion' })
    const bytes = Buffer.from('Retain a discarded standalone upload in history')
    const uploaded = await member.modifications.upload(old.id, { ...mutation(member.modifications.detail(old.id)), name: 'discarded-upload.txt', bytes }, member.context!)
    const file = uploaded.modification!.files.find(entry => entry.id === uploaded.fileId)!
    await admin.modifications.populate(old.id, populate(admin.modifications.detail(old.id), [f.cars[1]], 'linked'), admin.context!)
    const state = await member.sync.synchronize(f.shared, f.team.id, member.identity)
    assert.equal(state.phase, 'conflict')
    const conflict = JSON.parse(String(member.store.db.prepare('SELECT payload FROM conflicts WHERE record_id=?').get(old.id)!.payload))
    assert(conflict.fields.includes('_modificationLink'))
    const choices = Object.fromEntries(conflict.fields.map((field: string) => [field, 'local']))
    await assert.rejects(member.sync.resolve(f.shared, f.team.id, member.identity, member.context!.actor, old.id, conflict.token, choices, 'Do not overwrite linked data'), rejects('MODIFICATION_LINKED'))
    await member.sync.resolve(f.shared, f.team.id, member.identity, member.context!.actor, old.id, conflict.token, Object.fromEntries(conflict.fields.map((field: string) => [field, 'shared'])), 'Keep shared membership; retain prior edit history')
    assert.equal(member.modifications.detail(old.id).mode, 'linked')
    assert.equal(member.modifications.detail(old.id).record.data.lead, 'Test lead')
    assert(member.store.db.prepare('SELECT payload FROM changes WHERE record_id=?').all(old.id).some(row => String(row.payload).includes('Offline independent edit')))
    assert.deepEqual(await fs.readFile(path.join(f.shared, 'business', 'blobs', file.checksum)), bytes)
    await f.synchronize()
    const backup = await unzipper.Open.buffer(await createBackup(admin.business, f.team.id))
    assert.deepEqual(await backup.files.find(entry => entry.path === `blobs/${file.checksum}`)!.buffer(), bytes)
  } finally { await f.close() }
})

test('managed restore publishes its complete graph once and retains a stale overlay for review without rolling back HEAD', async () => {
  const f = await fixture()
  try {
    await f.enable()
    const { admin, member } = f
    await admin.modifications.upload(f.modification.id, { ...mutation(admin.modifications.detail(f.modification.id)), name: 'restored.txt', bytes: Buffer.from('Retain original restore file') }, admin.context!)
    const linked = await admin.modifications.populate(f.modification.id, populate(admin.modifications.detail(f.modification.id), [f.cars[1]], 'linked'), admin.context!)
    const bytes = await createBackup(admin.business, f.team.id)
    const edit = async (lead: string) => { const view = admin.modifications.detail(f.modification.id); return admin.modifications.edit(view.record.id, { ...mutation(view), data: { ...fieldsOf(view), lead } }, admin.context!) }
    await edit('Later configuration')
    const restore = async () => {
      const preview = await previewBackup(admin.business, bytes, f.team.id)
      return applyRestore(admin.business, { requestId: randomUUID(), bytes, teamId: f.team.id, actor: admin.context!.actor, reason: 'Restore saved shared modification', archiveRecordIds: [], previewFingerprint: preview.fingerprint, confirmDroppedFields: false })
    }
    await restore()
    assert.equal(admin.store.get<ModificationImport[]>('pendingModificationImports')!.length, 1)
    await f.synchronize()
    assert.deepEqual(admin.store.get('pendingModificationImports'), [])
    const firstHead = await f.head()
    await f.synchronize()
    assert.equal(await f.head(), firstHead)
    await f.synchronize(1)
    assert.equal(member.modifications.detail(linked.recordIds[0]).record.data.lead, 'Test lead')
    await edit('Before conflicting restore')
    await f.synchronize(1)
    const receipt = await restore()
    const otherView = member.modifications.detail(linked.recordIds[0])
    await member.modifications.edit(otherView.record.id, { ...mutation(otherView), data: { ...fieldsOf(otherView), lead: 'Concurrent canonical change' } }, member.context!)
    const currentHead = await f.head(), failed = await admin.sync.synchronize(f.shared, f.team.id, admin.identity)
    assert.equal(failed.error, 'MODIFICATION_RESTORE_CONFLICT')
    assert.equal(await f.head(), currentHead)
    const abandonedForwardIds = new Set(admin.store.get<ModificationImport[]>('pendingModificationImports')!.flatMap(entry => entry.forwardChanges || []).map(change => change.id))
    assert(abandonedForwardIds.size > 0)
    const zip = await unzipper.Open.buffer(await exportModificationRestore(admin.business, receipt.requestId))
    assert(zip.files.some(file => file.path.startsWith('blobs/')))
    const originalPayload = JSON.parse((await zip.files.find(file => file.path === 'retained-restore.json')!.buffer()).toString())
    assert.equal(originalPayload.entries[0].records.find((row: BusinessRecord) => row.kind === 'modificationGroup').data.lead, 'Test lead')
    const third = admin.business.get(f.cars[2].id)
    admin.business.write({ id: third.id, kind: 'vehicle', data: { ...third.data, physicalLocation: 'Unrelated pending edit' }, version: third.version, actor: admin.context!.actor, reason: 'Keep unrelated work' })
    await abandonModificationRestore(admin.business, admin.sync, admin.teams, admin.context!, receipt.requestId, 'Retain desired payload and review latest group')
    assert.equal(await f.head(), currentHead)
    assert.deepEqual(admin.store.get('pendingModificationImports'), [])
    assert.equal(admin.modifications.detail(f.modification.id).record.data.lead, 'Concurrent canonical change')
    assert.equal(admin.business.get(third.id).data.physicalLocation, 'Unrelated pending edit')
    assert.equal(restoreReceipts(admin.business).find(row => row.requestId === receipt.requestId)!.error, 'MODIFICATION_RESTORE_REVIEW_REQUIRED')
    const retainedBackup = await unzipper.Open.buffer(await createBackup(admin.business, f.team.id))
    const retainedManifest = JSON.parse((await retainedBackup.files.find(file => file.path === 'manifest.json')!.buffer()).toString())
    assert.equal(retainedManifest.abandonedModificationImports.length, 1)
    assert.deepEqual((await exportModificationRestore(admin.business, receipt.requestId)).subarray(0, 2), Buffer.from('PK'))
    await f.synchronize()
    assert.equal(admin.sync.status().pending, 0)
    const published = await SharedBusinessSnapshot.open(admin.business, f.shared, f.team.id, async () => { throw new Error('Read-only shared inspection') })
    try { assert(published.db.prepare('SELECT id FROM changes').all().every(row => !abandonedForwardIds.has(String(row.id)))) } finally { await published.close() }
    for (const id of abandonedForwardIds) assert.equal(JSON.parse(String(admin.store.db.prepare('SELECT payload FROM changes WHERE id=?').get(id)!.payload)).action, 'modification.restoreRetained')
  } finally { await f.close() }
})

test('activation permissions, text-only legacy compatibility and independent file bytes/metadata', async () => {
  const f = await fixture()
  try {
    const { admin, member } = f, initial = admin.modifications.detail(f.modification.id)
    assert.equal(initial.record.data.requestor, 'External requester'); assert.equal(initial.record.data.lead, 'Test lead')
    await assert.rejects(member.modifications.enable(member.context!, { requestId: randomUUID(), reason: 'Denied member activation' }), rejects('ADMIN_REQUIRED'))
    await assert.rejects(admin.modifications.enable({ ...admin.context!, syncEnabled: false }, { requestId: randomUUID(), reason: 'Paused activation' }), rejects('CONFIRM_RESUME'))
    await assert.rejects(admin.modifications.upload(initial.record.id, { ...mutation(initial), name: 'request.txt', bytes: Buffer.from('not enabled') }, admin.context!), rejects('MODIFICATION_NOT_ENABLED'))
    await f.enable()
    assert.equal(admin.store.get('businessProtocol'), 5)
    const catalog = new ConfigurationRevisions(admin.business, admin.sync).catalog()
    assert.equal(catalog.enabled, false); assert.equal(catalog.policyEnabled, false)
    const bytes = Buffer.from('中文\r\nOriginal modification request\r\n'), request = { ...mutation(initial), name: 'REQUEST.TXT', bytes }
    const saved = await admin.modifications.upload(initial.record.id, request, admin.context!)
    assert.equal(saved.modification!.files.length, 1); assert.equal(saved.modification!.files[0].name, 'REQUEST.TXT')
    const download = await admin.modifications.download(initial.record.id, saved.fileId!, admin.context!)
    assert.deepEqual(download.bytes, bytes); assert.equal(download.name, 'REQUEST.TXT')
    const again = await admin.modifications.upload(initial.record.id, request, admin.context!)
    assert.equal(again.fileId, saved.fileId); assert.equal(admin.modifications.detail(initial.record.id).files.length, 1)
    await assert.rejects(admin.modifications.upload(initial.record.id, { ...request, bytes: Buffer.from('changed payload') }, admin.context!), rejects('MODIFICATION_REQUEST_MISMATCH'))
    const view = admin.modifications.detail(initial.record.id)
    await f.synchronize(); await f.synchronize(1)
    await assert.rejects(member.modifications.archiveFile(view.record.id, saved.fileId!, { ...mutation(member.modifications.detail(view.record.id)), archived: true }, member.context!), rejects('ADMIN_REQUIRED'))
    const archived = await admin.modifications.archiveFile(view.record.id, saved.fileId!, { ...mutation(view), archived: true }, admin.context!)
    assert.equal(archived.modification!.files[0].archived, true)
    assert.deepEqual((await admin.modifications.download(view.record.id, saved.fileId!, admin.context!)).bytes, bytes)
  } finally { await f.close() }
})

test('one-time population is atomic/idempotent, preserves dates/files and works paused/offline', async () => {
  const f = await fixture()
  try {
    await f.enable()
    const { admin } = f, first = admin.modifications.detail(f.modification.id)
    await admin.modifications.upload(first.record.id, { ...mutation(first), name: 'request.txt', bytes: Buffer.from('Fictional work request') }, admin.context!)
    const view = admin.modifications.detail(first.record.id), request = populate(view, f.cars.slice(1), 'oneTime'), beforeHead = await f.head()
    const offline = { ...admin.context!, directory: path.join(f.root, 'unavailable'), online: false, syncEnabled: false }
    const result = await admin.modifications.populate(view.record.id, request, offline)
    assert.equal(result.recordIds.length, 2); assert.equal(await f.head(), beforeHead)
    assert.deepEqual((await admin.modifications.populate(view.record.id, request, offline)).recordIds, result.recordIds)
    const copies = result.recordIds.map(id => admin.modifications.detail(id))
    for (const copy of copies) {
      assert.equal(copy.mode, 'independent'); assert.equal(copy.record.data.installedAt, '2026-04-01'); assert.equal(copy.record.data.requestor, 'External requester')
      assert.equal(copy.files[0].checksum, view.files[0].checksum); assert.notEqual(copy.files[0].id, view.files[0].id)
    }
    assert.notEqual(copies[0].files[0].id, copies[1].files[0].id)
    await assert.rejects(admin.modifications.edit(view.record.id, { ...mutation(view), data: { ...view.record.data, attachments: undefined, description: 'New source detail' } }, offline), rejects('INVALID_INPUT'))
    const { attachments: _files, ...fields } = view.record.data
    await admin.modifications.edit(view.record.id, { ...mutation(view), data: { ...fields, description: 'New source detail' } }, offline)
    assert.equal(admin.modifications.detail(copies[0].record.id).record.data.description, 'Supplier change')
    const current = admin.modifications.detail(view.record.id)
    await assert.rejects(admin.modifications.populate(view.record.id, { ...populate(current, [f.cars[1]], 'oneTime'), targets: [{ vehicleId: f.cars[1].id, expectedVin: 'TEST0000000000999' }] }, offline), rejects('MODIFICATION_STALE'))
    const count = admin.business.list('modification').length
    await assert.rejects(admin.modifications.populate(view.record.id, { ...populate(current, [f.cars[1]], 'oneTime'), targets: [null] as never }, offline), rejects('INVALID_INPUT'))
    assert.equal(admin.business.list('modification').length, count)
  } finally { await f.close() }
})

test('Linked shared edits, unlink/archive freezing and original VIN deletion preserve other memberships', async () => {
  const f = await fixture()
  try {
    await f.enable()
    const { admin, member } = f
    await admin.modifications.upload(f.modification.id, { ...mutation(admin.modifications.detail(f.modification.id)), name: 'request.txt', bytes: Buffer.from('Shared request bytes') }, admin.context!)
    const linked = await admin.modifications.populate(f.modification.id, populate(admin.modifications.detail(f.modification.id), f.cars.slice(1), 'linked'), admin.context!)
    assert.ok(linked.groupId); assert.equal(admin.business.list('modificationGroup').length, 1)
    assert.equal(admin.modifications.detail(f.modification.id).linkedVehicles.length, 3)
    await f.synchronize(1)
    const target = member.modifications.detail(linked.recordIds[0]), { attachments: _files, groupId: _group, ...fields } = target.record.data
    await assert.rejects(member.modifications.edit(target.record.id, { ...mutation(target), data: fields }, { ...member.context!, syncEnabled: false }), rejects('CONFIRM_RESUME'))
    const updated = await member.modifications.edit(target.record.id, { ...mutation(target), data: { ...fields, lead: 'New group lead', installedAt: '2026-05-01' } }, member.context!)
    assert.equal(updated.modification!.record.data.lead, 'New group lead')
    await f.synchronize()
    assert.equal(admin.modifications.detail(f.modification.id).record.data.installedAt, '2026-05-01')
    await assert.rejects(member.modifications.edit(target.record.id, { ...mutation(target), data: { ...fields, lead: 'Stale overwrite' } }, member.context!), rejects('MODIFICATION_STALE'))
    const detached = await admin.modifications.unlink(linked.recordIds[1], mutation(admin.modifications.detail(linked.recordIds[1])), admin.context!)
    assert.equal(detached.modification!.mode, 'independent'); assert.equal(detached.modification!.record.data.lead, 'New group lead')
    const archived = await admin.modifications.archiveMember(f.modification.id, { ...mutation(admin.modifications.detail(f.modification.id)), archived: true }, admin.context!)
    assert.equal(archived.modification!.mode, 'independent'); assert.equal(archived.modification!.record.archived, true)
    const sourceCar = admin.business.get(f.cars[0].id)
    admin.business.write({ id: sourceCar.id, kind: 'vehicle', data: sourceCar.data, archived: true, version: sourceCar.version, actor: admin.context!.actor, reason: 'Archive original fictional VIN' })
    await f.synchronize()
    const preview = await admin.sync.deletePreview(f.shared, f.team.id, admin.identity, admin.context!.actor, sourceCar.id)
    await admin.sync.deleteVehicle(f.shared, f.team.id, admin.identity, admin.context!.actor, sourceCar.id, { previewToken: preview.token, version: preview.version, vin: preview.vin, confirmation: 'DELETE', reason: 'Delete original fictional VIN', requestId: randomUUID() })
    const surviving = admin.modifications.detail(linked.recordIds[0])
    assert.equal(surviving.mode, 'linked'); assert.equal(surviving.linkedVehicles.length, 1)
    assert.equal((await admin.modifications.download(surviving.record.id, surviving.files[0].id, admin.context!)).bytes.toString(), 'Shared request bytes')
  } finally { await f.close() }
})

test('archive parent atomically freezes only its memberships and lost HEAD response recovers the same request', async () => {
  const f = await fixture()
  const originalPublish = SharedBusinessSnapshot.prototype.publish
  try {
    await f.enable()
    const { admin } = f, request = populate(admin.modifications.detail(f.modification.id), [f.cars[1]], 'linked')
    let failOnce = true
    SharedBusinessSnapshot.prototype.publish = async function (...args) { const result = await originalPublish.apply(this, args); if (failOnce) { failOnce = false; throw new AppError('SHARE_IO_ERROR', 503) }; return result }
    await assert.rejects(admin.modifications.populate(f.modification.id, request, admin.context!), rejects('SHARE_IO_ERROR'))
    SharedBusinessSnapshot.prototype.publish = originalPublish
    const recovered = await admin.modifications.populate(f.modification.id, request, admin.context!)
    assert.equal(admin.business.list('modificationGroup').length, 1); assert.equal(recovered.recordIds.length, 1)
    const vehicle = admin.business.get(f.cars[0].id), archive = { requestId: randomUUID(), version: vehicle.version, reason: 'Archive vehicle with linked work', archived: true }
    const result = await admin.modifications.archiveVehicle(vehicle.id, archive, admin.context!)
    assert.equal(admin.business.get(vehicle.id).archived, true); assert.equal(admin.modifications.detail(f.modification.id).record.archived, true)
    assert.equal(admin.modifications.detail(f.modification.id).mode, 'independent'); assert.equal(admin.modifications.detail(recovered.recordIds[0]).mode, 'linked')
    assert.deepEqual((await admin.modifications.archiveVehicle(vehicle.id, archive, admin.context!)).recordIds, result.recordIds)
  } finally { SharedBusinessSnapshot.prototype.publish = originalPublish; await f.close() }
})

test('upload cancellation after persistence writes no records and complete async workflow drains before close', async () => {
  const f = await fixture()
  try {
    await f.enable()
    const { admin } = f, before = admin.modifications.detail(f.modification.id), original = admin.business.blob.bind(admin.business)
    let entered!: () => void, release!: () => void, alive = true
    const waiting = new Promise<void>(resolve => { entered = resolve }), held = new Promise<void>(resolve => { release = resolve })
    admin.business.blob = async bytes => { entered(); await held; return original(bytes) }
    const context = { ...admin.context!, assertCurrent: () => { if (!alive) throw new AppError('WORKSPACE_CHANGED', 409) } }
    const upload = admin.modifications.upload(before.record.id, { ...mutation(before), name: 'cancel.txt', bytes: Buffer.from('Retained orphan bytes, no saved record') }, context)
    await waiting
    let drained = false
    const settled = admin.store.settleWork().then(() => { drained = true })
    await new Promise(resolve => setImmediate(resolve)); assert.equal(drained, false)
    alive = false; release()
    await assert.rejects(upload, rejects('WORKSPACE_CHANGED')); await settled
    assert.equal(admin.modifications.detail(before.record.id).record.version, before.record.version)
    assert.equal(admin.modifications.detail(before.record.id).files.length, 0)
  } finally { await f.close() }
})

test('restored independent receipts recover same-identity retries and reject another actor before and after publication', async () => {
  const f = await fixture()
  let reinstalled: LocalStore | undefined
  try {
    await f.enable()
    const { admin, member } = f, view = admin.modifications.detail(f.modification.id), request = populate(view, [f.cars[1]], 'oneTime')
    const saved = await admin.modifications.populate(view.record.id, request, admin.context!)
    await f.synchronize()
    const bytes = await createBackup(admin.business, f.team.id)
    reinstalled = new LocalStore(path.join(f.root, 'reinstalled'), admin.identity.deviceId)
    const business = new Business(reinstalled), sync = new BusinessSync(business, admin.teams), modifications = new Modifications(business, sync)
    assert.equal((await sync.synchronize(f.shared, f.team.id, admin.identity)).error, null)
    await restoreBackup(business, bytes, f.team.id, admin.context!.actor, 'Recover independent command receipts')
    const count = business.list('modification').length
    assert.deepEqual((await modifications.populate(view.record.id, request, admin.context!)).recordIds, saved.recordIds)
    assert.equal(business.list('modification').length, count)
    assert.equal((await sync.synchronize(f.shared, f.team.id, admin.identity)).error, null)
    assert.deepEqual(reinstalled.get('pendingModificationImports'), [])
    assert.deepEqual((await modifications.populate(view.record.id, request, admin.context!)).recordIds, saved.recordIds)
    await assert.rejects(modifications.populate(view.record.id, { ...request, reason: 'Changed original request' }, admin.context!), rejects('MODIFICATION_REQUEST_MISMATCH'))
    await f.synchronize(1)
    await assert.rejects(member.modifications.populate(view.record.id, request, member.context!), rejects('MODIFICATION_REQUEST_MISMATCH'))
    assert.equal(member.business.list('modification').length, count)
  } finally { reinstalled?.db.close(); await f.close() }
})

test('fresh clients retain historical modification files removed by a restore in their backups', async () => {
  const f = await fixture()
  try {
    await f.enable()
    const { admin, member } = f
    await admin.modifications.populate(f.modification.id, populate(admin.modifications.detail(f.modification.id), [f.cars[1]], 'linked'), admin.context!)
    const original = await createBackup(admin.business, f.team.id), bytes = Buffer.from('Historical original after restoring older group')
    const uploaded = await admin.modifications.upload(f.modification.id, { ...mutation(admin.modifications.detail(f.modification.id)), name: 'history-only.txt', bytes }, admin.context!)
    const file = uploaded.modification!.files.find(entry => entry.id === uploaded.fileId)!
    await restoreBackup(admin.business, original, f.team.id, admin.context!.actor, 'Restore group before document upload')
    await f.synchronize()
    assert.equal(admin.modifications.detail(f.modification.id).files.length, 0)
    await f.synchronize(1)
    assert.deepEqual(await member.business.readBlob(file.checksum), bytes)
    const zip = await unzipper.Open.buffer(await createBackup(member.business, f.team.id))
    assert.deepEqual(await zip.files.find(entry => entry.path === `blobs/${file.checksum}`)!.buffer(), bytes)
  } finally { await f.close() }
})

test('restored history publishes original files even when no current record references them', async () => {
  const f = await fixture()
  try {
    await f.enable()
    const { admin, member } = f, bytes = Buffer.from('Original document retained by restored history only')
    const file: ModificationFile = { id: randomUUID(), name: 'historical-original.txt', checksum: await admin.business.blob(bytes), size: bytes.length, savedAt: new Date().toISOString(), archived: false }
    const change: Change = { id: randomUUID(), recordId: f.modification.id, vehicleId: f.cars[0].id, kind: 'modification', before: null, after: { ...f.modification.data, attachments: [file] }, archivedBefore: null, archivedAfter: false, actor: admin.context!.actor, reason: 'Restore historical document metadata', action: 'modification.restored', sourceId: null, created: new Date().toISOString() }
    admin.store.set('pendingHistoryImports', [{ id: randomUUID(), actor: admin.context!.actor, changes: [change] }])
    await f.synchronize()
    assert.deepEqual(await fs.readFile(path.join(f.shared, 'business', 'blobs', file.checksum)), bytes)
    await f.synchronize(1)
    assert.deepEqual(await member.business.readBlob(file.checksum), bytes)
    const zip = await unzipper.Open.buffer(await createBackup(member.business, f.team.id))
    assert.deepEqual(await zip.files.find(entry => entry.path === `blobs/${file.checksum}`)!.buffer(), bytes)
  } finally { await f.close() }
})

test('membership changes invalidate reviewed shared scopes and command retries do not advance them again', async () => {
  const f = await fixture()
  try {
    await f.enable()
    const { admin, member } = f
    const linked = await admin.modifications.populate(f.modification.id, populate(admin.modifications.detail(f.modification.id), [f.cars[1]], 'linked'), admin.context!)
    await f.synchronize(1)
    const captured = admin.modifications.detail(f.modification.id), join = populate(member.modifications.detail(linked.recordIds[0]), [f.cars[2]], 'linked')
    const added = await member.modifications.populate(linked.recordIds[0], join, member.context!)
    assert.equal(member.business.get(linked.groupId!).version, captured.groupVersion! + 1)
    assert.deepEqual((await member.modifications.populate(linked.recordIds[0], join, member.context!)).recordIds, added.recordIds)
    assert.equal(member.business.get(linked.groupId!).version, captured.groupVersion! + 1)
    const beforeRejected = await f.head()
    await assert.rejects(admin.modifications.edit(captured.record.id, { ...mutation(captured), data: { ...fieldsOf(captured), lead: 'Unreviewed new VIN' } }, admin.context!), rejects('MODIFICATION_STALE'))
    await assert.rejects(admin.modifications.upload(captured.record.id, { ...mutation(captured), name: 'stale-scope.txt', bytes: Buffer.from('Do not share with an unreviewed VIN') }, admin.context!), rejects('MODIFICATION_STALE'))
    assert.equal(await f.head(), beforeRejected)
    const reviewed = admin.modifications.detail(captured.record.id), edit = { ...mutation(reviewed), data: { ...fieldsOf(reviewed), lead: 'All three VINs reviewed' } }
    assert.equal(reviewed.linkedVehicles.length, 3)
    await admin.modifications.edit(reviewed.record.id, edit, admin.context!)
    const editedVersion = admin.business.get(linked.groupId!).version
    await admin.modifications.edit(reviewed.record.id, edit, admin.context!)
    assert.equal(admin.business.get(linked.groupId!).version, editedVersion)

    const unlinkView = admin.modifications.detail(added.recordIds[0]), detach = mutation(unlinkView)
    await admin.modifications.unlink(unlinkView.record.id, detach, admin.context!)
    assert.equal(admin.business.get(linked.groupId!).version, editedVersion + 1)
    await admin.modifications.unlink(unlinkView.record.id, detach, admin.context!)
    assert.equal(admin.business.get(linked.groupId!).version, editedVersion + 1)
    const archiveView = admin.modifications.detail(linked.recordIds[0]), archive = { ...mutation(archiveView), archived: true }
    await admin.modifications.archiveMember(archiveView.record.id, archive, admin.context!)
    assert.equal(admin.business.get(linked.groupId!).version, editedVersion + 2)
    await admin.modifications.archiveMember(archiveView.record.id, archive, admin.context!)
    assert.equal(admin.business.get(linked.groupId!).version, editedVersion + 2)
    const car = admin.business.get(f.cars[0].id), archiveCar = { requestId: randomUUID(), version: car.version, archived: true, reason: 'Freeze final linked scope before vehicle archival', groupVersions: { [linked.groupId!]: editedVersion + 2 } }
    await admin.modifications.archiveVehicle(car.id, archiveCar, admin.context!)
    assert.equal(admin.business.get(linked.groupId!).version, editedVersion + 3)
    await admin.modifications.archiveVehicle(car.id, archiveCar, admin.context!)
    assert.equal(admin.business.get(linked.groupId!).version, editedVersion + 3)
    const preview = await admin.sync.deletePreview(f.shared, f.team.id, admin.identity, admin.context!.actor, car.id)
    await admin.sync.deleteVehicle(f.shared, f.team.id, admin.identity, admin.context!.actor, car.id, { previewToken: preview.token, version: preview.version, vin: preview.vin, confirmation: 'DELETE', reason: 'Remove archived independent membership', requestId: randomUUID() })
    assert.equal(admin.business.get(linked.groupId!).version, editedVersion + 3, 'Deletion removes a frozen independent row after archival already invalidated the shared scope')
  } finally { await f.close() }
})
