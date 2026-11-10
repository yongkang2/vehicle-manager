import { test } from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { ZipArchive } from 'archiver'
import unzipper from 'unzipper'
import { Business, validateEquipmentAttachmentRecords } from '../server/business.js'
import { LocalStore } from '../server/store.js'
import { BusinessSync } from '../server/sync.js'
import { TeamDirectory } from '../server/team.js'
import { createBackup, previewBackup, restoreBackup } from '../server/backup.js'
import { equipmentTypes } from '../shared/business.js'
import type { Actor, BusinessRecord } from '../shared/business.js'

const original = Buffer.from('%PDF-1.4\nFictional equipment instructions\n%%EOF')
async function fixture(shared = false) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'equipment-attachments-'))
  const clients = ['alpha', 'beta'].map(name => {
    const store = new LocalStore(path.join(directory, name)), business = new Business(store), teams = new TeamDirectory()
    return { store, business, teams, sync: new BusinessSync(business, teams), identity: { deviceId: store.deviceId, deviceName: name, localUserId: name, displayName: name }, actor: { id: name, name, deviceId: store.deviceId, role: 'admin' } as Actor }
  })
  const share = path.join(directory, 'shared'); await fs.mkdir(share)
  let teamId = 'equipment-test-team'
  if (shared) {
    const [alpha, beta] = clients, team = await alpha.teams.create(share, 'Equipment attachment test', alpha.identity)
    const pending = await beta.teams.join(share, team.id, beta.identity)
    const approved = await alpha.teams.approve(share, team.id, alpha.identity, pending.requests[0].id, 'admin', null, 'Approve fictional equipment client')
    teamId = team.id
    for (const client of clients) client.actor.id = approved.bindings.find(binding => binding.deviceId === client.store.deviceId)!.memberId
  }
  const vehicle = (index = 0, vin = 'TEST0000000000001') => clients[index].business.write({ kind: 'vehicle', data: { vin, status: 'available' }, actor: clients[index].actor, reason: 'Register fictional vehicle' })
  const equipment = (car: BusinessRecord, index = 0) => clients[index].business.write({ kind: 'equipment', vehicleId: car.id, data: { name: 'Fictional logger' }, actor: clients[index].actor, reason: 'Install fictional equipment' })
  const file = async (item: BusinessRecord, index = 0) => {
    const client = clients[index], checksum = await client.business.blob(original)
    return client.business.write({ kind: 'attachment', vehicleId: item.vehicleId, data: { name: 'Fictional equipment.PDF', checksum, size: original.length, savedAt: new Date().toISOString(), equipmentId: item.id }, actor: client.actor, reason: 'Attach fictional instructions', internal: true })
  }
  const archive = (record: BusinessRecord, index = 0, archived = true) => clients[index].business.write({ id: record.id, kind: record.kind, vehicleId: record.vehicleId, data: record.data, version: record.version, archived, actor: clients[index].actor, reason: archived ? 'Archive fictional record' : 'Restore fictional record', internal: record.kind === 'attachment' })
  const synchronize = (index: number) => clients[index].sync.synchronize(share, teamId, clients[index].identity)
  const converge = async () => { for (const index of [0, 1, 0]) { const status = await synchronize(index); assert.equal(status.phase, 'ready', JSON.stringify(status)); assert.equal(status.pending, 0) } }
  const close = async () => { for (const client of clients) client.store.db.close(); await fs.rm(directory, { recursive: true, force: true }) }
  return { directory, clients, share, teamId, vehicle, equipment, file, archive, synchronize, converge, close }
}

test('equipment attachment links are immutable UUID references, retain bytes and survive record rename and archive', async () => {
  const f = await fixture()
  try {
    const [client] = f.clients, car = f.vehicle(), item = f.equipment(car), other = f.equipment(car), attachment = await f.file(item)
    assert.equal(item.data.installedAt, ''); assert.equal(item.data.removedAt, '')
    client.business.write({ id: item.id, kind: 'equipment', vehicleId: car.id, data: { ...item.data, name: 'Renamed logger' }, version: item.version, actor: client.actor, reason: 'Rename equipment' })
    assert.equal(client.business.get(attachment.id).data.equipmentId, item.id)
    assert.deepEqual(await client.business.readBlob(String(attachment.data.checksum)), original)
    for (const equipmentId of [null, 'bad-id', {}, other.id, '']) {
      assert.throws(() => client.business.write({ id: attachment.id, kind: 'attachment', vehicleId: car.id, data: { ...attachment.data, equipmentId }, version: attachment.version, actor: client.actor, reason: 'Reject relink', internal: true }), { code: 'INVALID_INPUT' })
    }
    f.archive(client.business.get(item.id))
    await assert.rejects(f.file(item), { code: 'RECORD_ARCHIVED' })
    const archivedFile = f.archive(attachment), restoredFile = f.archive(archivedFile, 0, false)
    assert.equal(restoredFile.data.equipmentId, item.id)
    assert.equal(client.business.get(item.id).archived, true)
    assert.doesNotThrow(() => validateEquipmentAttachmentRecords(client.business.list()))
    assert.equal(client.store.db.prepare('PRAGMA integrity_check').get()!.integrity_check, 'ok')
  } finally { await f.close() }
})

test('equipment Type merges with unrelated legacy edits, treats missing as blank and conflicts on competing selections', async () => {
  const f = await fixture(true)
  try {
    const [alpha, beta] = f.clients, car = f.vehicle(), item = f.equipment(car)
    const oldData = { ...item.data }; delete oldData.equipmentType
    alpha.store.db.prepare('UPDATE records SET data=? WHERE id=?').run(JSON.stringify(oldData), item.id)
    for (const row of alpha.store.db.prepare('SELECT id,payload FROM outbox WHERE record_id=?').all(item.id)) {
      const operation = JSON.parse(String(row.payload)); delete operation.desired.data.equipmentType
      for (const change of operation.changes) delete change.after.equipmentType
      alpha.store.db.prepare('UPDATE outbox SET payload=? WHERE id=?').run(JSON.stringify(operation), row.id!)
    }
    await f.converge()
    assert.equal(beta.business.get(item.id).data.equipmentType, undefined)
    for (const [client, data] of [[alpha, { equipmentType: 'ETAS tools' }], [beta, { description: 'Unrelated legacy edit' }]] as const) {
      const current = client.business.get(item.id)
      client.business.write({ id: current.id, kind: 'equipment', vehicleId: car.id, data: { ...current.data, ...data }, version: current.version, actor: client.actor, reason: 'Concurrent Type or unrelated edit' })
    }
    await f.converge()
    for (const client of f.clients) { const data = client.business.get(item.id).data; assert.equal(data.equipmentType, 'ETAS tools'); assert.equal(data.description, 'Unrelated legacy edit') }
    for (const [client, equipmentType] of [[alpha, 'Hook'], [beta, 'Controller']] as const) {
      const current = client.business.get(item.id)
      client.business.write({ id: item.id, kind: 'equipment', vehicleId: car.id, data: { ...current.data, equipmentType }, version: current.version, actor: client.actor, reason: 'Competing equipment Type' })
    }
    await f.synchronize(0)
    const conflict = await f.synchronize(1)
    assert.equal(conflict.phase, 'conflict'); assert.deepEqual(conflict.conflicts[0].fields, ['equipmentType'])
  } finally { await f.close() }
})

test('equipment Type survives backups with attachments and older missing-Type backups remain restorable', async () => {
  const f = await fixture()
  try {
    const [source, target] = f.clients, car = f.vehicle(), rows = equipmentTypes.map(equipmentType => source.business.write({ kind: 'equipment', vehicleId: car.id, data: { name: 'Typed equipment', equipmentType }, actor: source.actor, reason: 'Store every equipment Type' })), attachment = await f.file(rows[0])
    const bytes = await createBackup(source.business, f.teamId), preview = await previewBackup(target.business, bytes, f.teamId)
    assert.equal(preview.droppedFields.length, 0)
    await restoreBackup(target.business, bytes, f.teamId, target.actor, 'Restore typed equipment and attachments')
    for (const row of rows) assert.equal(target.business.get(row.id).data.equipmentType, row.data.equipmentType)
    assert.equal(target.business.get(attachment.id).data.equipmentId, rows[0].id)
    const legacy = await rewriteBackup(bytes, manifest => { manifest.format = 1; for (const row of manifest.records) if (row.kind === 'equipment') delete row.data.equipmentType })
    const third = new LocalStore(path.join(f.directory, 'older-types')), older = new Business(third)
    try {
      await restoreBackup(older, legacy, f.teamId, target.actor, 'Restore legacy unclassified equipment')
      for (const row of rows) assert.equal(older.get(row.id).data.equipmentType, '')
      assert.deepEqual(await older.readBlob(String(attachment.data.checksum)), original)
    } finally { third.db.close() }
    const invalid = await rewriteBackup(bytes, manifest => { manifest.records.find(row => row.id === rows[0].id)!.data.equipmentType = 'Invalid category' })
    await assert.rejects(restoreBackup(target.business, invalid, f.teamId, target.actor, 'Reject an invalid Type'))
  } finally { await f.close() }
})

test('equipment links reject missing/cross-vehicle/non-equipment parents and photo metadata before writing rows', async () => {
  const f = await fixture()
  try {
    const [client] = f.clients, car = f.vehicle(), otherCar = f.vehicle(0, 'TEST0000000000002'), item = f.equipment(car), otherEquipment = f.equipment(otherCar)
    const checksum = await client.business.blob(original), base = { name: 'file.pdf', checksum, size: original.length }
    const before = client.business.list().length
    for (const data of [{ ...base, equipmentId: null }, { ...base, equipmentId: otherEquipment.id }, { ...base, equipmentId: car.id }, { ...base, equipmentId: item.id, purpose: 'vehiclePhoto' }]) {
      assert.throws(() => client.business.write({ kind: 'attachment', vehicleId: car.id, data, actor: client.actor, reason: 'Reject invalid equipment association', internal: true }), { code: 'INVALID_INPUT' })
    }
    assert.throws(() => client.business.write({ kind: 'attachment', vehicleId: car.id, data: { ...base, equipmentId: randomUUID() }, actor: client.actor, reason: 'Reject missing equipment', internal: true }), { code: 'RECORD_NOT_FOUND' })
    assert.equal(client.business.list().length, before)
    const legacy = client.business.write({ kind: 'attachment', vehicleId: car.id, data: base, actor: client.actor, reason: 'Keep general attachment', internal: true })
    assert.equal(legacy.data.equipmentId, undefined)
    assert.doesNotThrow(() => validateEquipmentAttachmentRecords(client.business.list()))
  } finally { await f.close() }
})

test('new equipment and its attachment synchronize together and unrelated equipment renames retain the link', async () => {
  const f = await fixture(true)
  try {
    const car = f.vehicle(); await f.converge()
    const item = f.equipment(car, 1), attachment = await f.file(item, 1)
    await f.converge()
    const [alpha, beta] = f.clients, current = alpha.business.get(item.id)
    alpha.business.write({ id: current.id, kind: 'equipment', vehicleId: car.id, data: { ...current.data, name: 'Renamed shared logger' }, version: current.version, actor: alpha.actor, reason: 'Rename shared equipment' })
    const additional = await f.file(beta.business.get(item.id), 1)
    await f.converge()
    for (const client of f.clients) for (const id of [attachment.id, additional.id]) {
      assert.equal(client.business.get(id).data.equipmentId, item.id)
      assert.deepEqual(await client.business.readBlob(String(client.business.get(id).data.checksum)), original)
      assert.equal(client.business.get(item.id).data.name, 'Renamed shared logger')
    }
  } finally { await f.close() }
})

test('files saved before a local equipment archive publish with that archive without becoming orphans', async () => {
  const f = await fixture(true)
  try {
    const car = f.vehicle(), item = f.equipment(car), attachment = await f.file(item)
    f.archive(item)
    await f.converge()
    for (const client of f.clients) {
      assert.equal(client.business.get(item.id).archived, true)
      assert.equal(client.business.get(attachment.id).data.equipmentId, item.id)
      assert.deepEqual(await client.business.readBlob(String(attachment.data.checksum)), original)
    }
  } finally { await f.close() }
})

test('a concurrent shared equipment archive blocks stale offline uploads and cannot be bypassed by conflict resolution', async () => {
  const f = await fixture(true)
  try {
    const car = f.vehicle(), item = f.equipment(car); await f.converge()
    const offline = await f.file(f.clients[1].business.get(item.id), 1)
    f.archive(f.clients[0].business.get(item.id)); assert.equal((await f.synchronize(0)).phase, 'ready')
    const state = await f.synchronize(1), beta = f.clients[1]
    assert.equal(state.phase, 'conflict'); assert.equal(state.conflicts.length, 1)
    const conflict = state.conflicts[0]
    assert.equal(conflict.recordId, offline.id); assert.ok(conflict.fields.includes('_equipmentParent'))
    await assert.rejects(beta.sync.resolve(f.share, f.teamId, beta.identity, beta.actor, offline.id, conflict.token, { _equipmentParent: 'local' }, 'Cannot recreate an upload under archived equipment'), { code: 'INVALID_INPUT' })
    assert.deepEqual(await beta.business.readBlob(String(offline.data.checksum)), original)
    assert.equal(beta.store.db.prepare("SELECT COUNT(*) AS total FROM outbox WHERE state='pending'").get()!.total, 1)
  } finally { await f.close() }
})

type Manifest = { format: number; records: BusinessRecord[]; [key: string]: unknown }
async function rewriteBackup(bytes: Buffer, mutate: (manifest: Manifest) => void): Promise<Buffer> {
  const originalZip = await unzipper.Open.buffer(bytes), archive = new ZipArchive({ zlib: { level: 6 } }), chunks: Buffer[] = []
  const complete = new Promise<Buffer>((resolve, reject) => { archive.on('data', (chunk: Buffer) => chunks.push(chunk)); archive.once('error', reject); archive.once('end', () => resolve(Buffer.concat(chunks))) })
  for (const entry of originalZip.files) {
    const content = await entry.buffer()
    if (entry.path === 'manifest.json') { const manifest = JSON.parse(content.toString()) as Manifest; mutate(manifest); archive.append(JSON.stringify(manifest), { name: entry.path }) }
    else archive.append(content, { name: entry.path })
  }
  void archive.finalize(); return complete
}

test('backup restores equipment before its files, retains archived equipment and accepts older unassociated backups', async () => {
  const f = await fixture()
  try {
    const [source, target] = f.clients, car = f.vehicle(), item = f.equipment(car), attachment = await f.file(item)
    f.archive(item)
    const bytes = await rewriteBackup(await createBackup(source.business, f.teamId), manifest => { manifest.records.sort((left, right) => Number(right.kind === 'attachment') - Number(left.kind === 'attachment')) })
    const result = await restoreBackup(target.business, bytes, f.teamId, target.actor, 'Restore equipment and original files')
    assert.equal(result.changed, 3)
    assert.equal(target.business.get(item.id).archived, true)
    assert.equal(target.business.get(attachment.id).data.equipmentId, item.id)
    assert.deepEqual(await target.business.readBlob(String(attachment.data.checksum)), original)
    const legacy = await rewriteBackup(bytes, manifest => { manifest.format = 1; for (const row of manifest.records) if (row.kind === 'attachment') delete row.data.equipmentId })
    const third = new LocalStore(path.join(f.directory, 'legacy')), legacyBusiness = new Business(third)
    try {
      await restoreBackup(legacyBusiness, legacy, f.teamId, target.actor, 'Restore older vehicle attachment')
      assert.equal(legacyBusiness.get(attachment.id).data.equipmentId, undefined)
      assert.deepEqual(await legacyBusiness.readBlob(String(attachment.data.checksum)), original)
    } finally { third.db.close() }
  } finally { await f.close() }
})

for (const invalid of ['missing', 'malformed', 'cross-vehicle', 'wrong-kind', 'photo'] as const) {
  test(`backup rejects ${invalid} equipment attachment references before mutating records or blobs`, async () => {
    const f = await fixture()
    try {
      const [source, target] = f.clients, car = f.vehicle(), item = f.equipment(car), attachment = await f.file(item), otherCar = f.vehicle(0, 'TEST0000000000002'), other = f.equipment(otherCar)
      const bytes = await rewriteBackup(await createBackup(source.business, f.teamId), manifest => {
        const row = manifest.records.find(record => record.id === attachment.id)!
        if (invalid === 'missing') row.data.equipmentId = randomUUID()
        else if (invalid === 'malformed') row.data.equipmentId = null
        else if (invalid === 'cross-vehicle') row.data.equipmentId = other.id
        else if (invalid === 'wrong-kind') row.data.equipmentId = car.id
        else row.data.purpose = 'vehiclePhoto'
      })
      await assert.rejects(previewBackup(target.business, bytes, f.teamId), { code: 'INVALID_BACKUP' })
      await assert.rejects(restoreBackup(target.business, bytes, f.teamId, target.actor, 'Reject invalid association'), { code: 'INVALID_BACKUP' })
      assert.deepEqual(target.business.list(), [])
      assert.equal(target.store.db.prepare('SELECT COUNT(*) AS total FROM changes').get()!.total, 0)
      assert.equal(target.store.db.prepare('SELECT COUNT(*) AS total FROM outbox').get()!.total, 0)
      await assert.rejects(fs.access(path.join(target.store.directory, 'blobs')))
    } finally { await f.close() }
  })
}

test('backup restoration cannot redirect or clear an existing attachment equipment identity', async () => {
  const f = await fixture()
  try {
    const [source, target] = f.clients, car = f.vehicle(), item = f.equipment(car), other = f.equipment(car), attachment = await f.file(item)
    const backup = await createBackup(source.business, f.teamId)
    await restoreBackup(target.business, backup, f.teamId, target.actor, 'Restore original equipment association')
    const before = target.business.list(), beforeHistory = target.business.history()
    for (const equipmentId of [other.id, '']) {
      const changed = await rewriteBackup(backup, manifest => { manifest.records.find(row => row.id === attachment.id)!.data.equipmentId = equipmentId })
      await assert.rejects(restoreBackup(target.business, changed, f.teamId, target.actor, 'Reject changed equipment identity'), { code: 'INVALID_BACKUP' })
      assert.deepEqual(target.business.list(), before); assert.deepEqual(target.business.history(), beforeHistory)
      assert.equal(target.business.get(attachment.id).data.equipmentId, item.id)
    }
  } finally { await f.close() }
})

test('vehicle deletion quarantines offline equipment files and VIN reuse never redirects the association', async () => {
  const f = await fixture(true)
  try {
    const car = f.vehicle(), item = f.equipment(car); await f.converge()
    const offline = await f.file(f.clients[1].business.get(item.id), 1), [alpha, beta] = f.clients
    f.archive(alpha.business.get(car.id)); assert.equal((await f.synchronize(0)).phase, 'ready')
    const preview = await alpha.sync.deletePreview(f.share, f.teamId, alpha.identity, alpha.actor, car.id)
    await alpha.sync.deleteVehicle(f.share, f.teamId, alpha.identity, alpha.actor, car.id, { previewToken: preview.token, version: preview.version, vin: String(car.data.vin), confirmation: 'DELETE', reason: 'Delete fictional archived vehicle', requestId: randomUUID() })
    const state = await f.synchronize(1)
    assert.equal(state.pending, 0); assert.equal(state.quarantined, 1)
    const retained = beta.store.quarantineRows().find(entry => entry.operation.recordId === offline.id)!
    assert.equal(retained.operation.desired.data.equipmentId, item.id)
    assert.deepEqual(await beta.business.readBlob(String(offline.data.checksum)), original)
    const replacement = f.vehicle(), nextEquipment = f.equipment(replacement); await f.converge()
    assert.notEqual(replacement.id, car.id); assert.notEqual(nextEquipment.id, item.id)
    assert.equal(beta.business.list('attachment', replacement.id).length, 0)
    assert.equal(beta.store.quarantineRows()[0].operation.desired.data.equipmentId, item.id)
    const zip = await unzipper.Open.buffer(await createBackup(beta.business, f.teamId))
    assert.ok(zip.files.some(file => file.path === `blobs/${offline.data.checksum}`))
  } finally { await f.close() }
})
