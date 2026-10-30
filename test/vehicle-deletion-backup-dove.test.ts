import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ZipArchive } from 'archiver'
import unzipper from 'unzipper'
import ExcelJS from 'exceljs'
import { createBackup, previewBackup, restoreBackup } from '../server/backup.js'
import { Business, checksum } from '../server/business.js'
import { DoveService } from '../server/dove.js'
import { LocalStore } from '../server/store.js'
import { appVersion } from '../shared/version.js'
import type { Actor, BusinessRecord, Operation, QuarantinedOperation, VehicleDeletion } from '../shared/business.js'

const vin = 'TEST0000000000001', teamId = 'deletion-backup-team'
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vehicle-delete-backup-'))
  const store = new LocalStore(root), business = new Business(store)
  const actor: Actor = { id: 'admin', name: 'Administrator', deviceId: store.deviceId, role: 'admin' }
  const createVehicle = (registration = vin, id?: string) => business.write({ ...(id ? { id } : {}), kind: 'vehicle', data: { vin: registration, status: 'available' }, actor, reason: 'Register test vehicle' })
  const sent = () => { store.db.exec("UPDATE outbox SET state='sent'") }
  const deletion = (vehicleId: string): VehicleDeletion => {
    const vehicle = business.get(vehicleId), records = business.list().filter(record => record.id === vehicleId || record.vehicleId === vehicleId)
    return { id: randomUUID(), requestId: randomUUID(), vehicleId, vin: String(vehicle.data.vin), recordIds: records.map(record => record.id), fileKeys: records.filter(record => ['report', 'attachment'].includes(record.kind)).map(record => String(record.data.checksum)), actor, reason: 'Delete archived test vehicle', deletedAt: new Date().toISOString(), revision: randomUUID(), sequence: 1 }
  }
  const close = async () => { store.db.close(); await fs.rm(root, { recursive: true, force: true }) }
  return { store, business, actor, createVehicle, sent, deletion, close }
}
type BackupManifest = { format: number; teamId: string; records: BusinessRecord[]; deletions?: VehicleDeletion[]; quarantinedOperations?: QuarantinedOperation[] }
async function rewrite(bytes: Buffer, mutate: (manifest: BackupManifest) => void): Promise<Buffer> {
  const zip = await unzipper.Open.buffer(bytes), archive = new ZipArchive({ zlib: { level: 6 } }), chunks: Buffer[] = []
  const done = new Promise<Buffer>((resolve, reject) => { archive.on('data', (chunk: Buffer) => chunks.push(chunk)); archive.once('error', reject); archive.once('end', () => resolve(Buffer.concat(chunks))) })
  for (const file of zip.files) {
    const content = await file.buffer()
    if (file.path === 'manifest.json') { const manifest = JSON.parse(content.toString()) as BackupManifest; mutate(manifest); archive.append(JSON.stringify(manifest), { name: file.path }) }
    else archive.append(content, { name: file.path })
  }
  void archive.finalize()
  return done
}
async function workbook(): Promise<Buffer> {
  const book = new ExcelJS.Workbook()
  book.addWorksheet('DOVE').addRows([['Vin :', vin], ['Date of record', '2026-10-21']])
  book.addWorksheet('Identification').addRows([['ECU', 'Description', 'Network', 'Supplier'], ['EVCU', 'Controller', 'CAN UDS', 'Supplier', 'FN', 'PN', '1.0', '', 'CAL', '2', '', '', '', '000123']])
  book.addWorksheet('Defauts')
  return Buffer.from(await book.xlsx.writeBuffer())
}


test('restore preview reports changes, archive candidates and unrecognized fields, then invalidates after edits', async () => {
  const source = await fixture(), target = await fixture()
  try {
    const sharedId = randomUUID()
    const sourceCar = source.createVehicle(vin, sharedId)
    source.business.write({ id: sourceCar.id, kind: 'vehicle', data: { ...sourceCar.data, owner: 'From backup', futureField: 'Preserve for review' }, version: sourceCar.version, actor: source.actor, reason: 'Prepare future-format backup', internal: true })
    const bytes = await createBackup(source.business, teamId)
    const backup = await unzipper.Open.buffer(bytes)
    const manifest = JSON.parse((await backup.files.find(file => file.path === 'manifest.json')!.buffer()).toString())
    assert.equal(manifest.format, 4)
    assert.equal(manifest.appVersion, appVersion)
    assert.equal(manifest.schemaVersion, 5)
    assert.equal(manifest.fieldVersion, 2)
    assert.equal(manifest.recordCounts.vehicle, 1)
    target.business.write({ id: sharedId, kind: 'vehicle', data: { vin, status: 'available', owner: 'Current value' }, actor: target.actor, reason: 'Current record' })
    const extra = target.createVehicle('TEST0000000000002')
    const extraPart = target.business.write({ kind: 'part', vehicleId: extra.id, data: { name: 'Extra motor', category: 'motor' }, actor: target.actor, reason: 'Extra vehicle part' })
    target.sent()
    const preview = await previewBackup(target.business, bytes, teamId)
    assert.equal(preview.records, 1)
    assert.equal(preview.additions, 0)
    assert.equal(preview.changes, 1)
    assert.deepEqual(preview.archiveCandidates.map(item => [item.id, item.relatedRecords]), [[extra.id, 1]])
    assert.deepEqual(preview.droppedFields, [{ recordId: sharedId, fields: ['futureField'] }])
    const current = target.business.get(sharedId)
    target.business.write({ id: sharedId, kind: 'vehicle', data: { ...current.data, owner: 'Edited after preview' }, version: current.version, actor: target.actor, reason: 'Invalidate preview' })
    const refreshed = await previewBackup(target.business, bytes, teamId)
    assert.notEqual(refreshed.fingerprint, preview.fingerprint)
    target.sent()
    await restoreBackup(target.business, bytes, teamId, target.actor, 'Archive omitted vehicle graph', [extra.id])
    assert.equal(target.business.get(extra.id).archived, true)
    assert.equal(target.business.get(extraPart.id).archived, true)
  } finally { await source.close(); await target.close() }
})
test('restore preview bounds actual manifest inflation when ZIP metadata understates its size', async () => {
  const target = await fixture()
  try {
    const archive = new ZipArchive({ zlib: { level: 6 } }), chunks: Buffer[] = []
    const done = new Promise<Buffer>((resolve, reject) => { archive.on('data', (chunk: Buffer) => chunks.push(chunk)); archive.once('error', reject); archive.once('end', () => resolve(Buffer.concat(chunks))) })
    archive.append(JSON.stringify({ padding: 'x'.repeat(20 * 1024 * 1024) }), { name: 'manifest.json' })
    void archive.finalize()
    const bytes = await done
    const directoryOffset = bytes.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]))
    assert.ok(directoryOffset >= 0)
    bytes.writeUInt32LE(256, directoryOffset + 24)
    await assert.rejects(previewBackup(target.business, bytes, teamId), { code: 'BACKUP_TOO_LARGE' })
    assert.deepEqual(target.business.list(), [])
  } finally { await target.close() }
})

for (const format of [1, 2]) {
  test(`format ${format} restore skips tombstoned vehicle UUIDs and all their children`, async () => {
    const source = await fixture(), target = await fixture()
    try {
      const removed = source.createVehicle(), retained = source.createVehicle('TEST0000000000002')
      const child = source.business.write({ kind: 'modification', vehicleId: removed.id, data: { name: 'Historical modification' }, actor: source.actor, reason: 'Test child' })
      const marker = source.deletion(removed.id)
      const current = await createBackup(source.business, teamId)
      const bytes = await rewrite(current, manifest => { manifest.format = format; if (format === 1) { delete manifest.deletions; delete manifest.quarantinedOperations } })
      target.store.applyDeletions([marker])
      const result = await restoreBackup(target.business, bytes, teamId, target.actor, 'Restore older backup')
      assert.deepEqual(result, { changed: 1, skippedVehicles: 1, skippedRecords: 2, skippedVehicleIds: [removed.id] })
      assert.deepEqual(target.business.list().map(record => record.id), [retained.id])
      assert.equal(target.store.deletionFor(child.id)?.vehicleId, removed.id)
      assert.ok(target.business.history(removed.id).length > 0)
      assert.equal(target.store.db.prepare('PRAGMA integrity_check').get()!.integrity_check, 'ok')
    } finally { await source.close(); await target.close() }
  })
}

test('format 2 retains quarantine originals, markers and history without replaying operations', async () => {
  const source = await fixture(), target = await fixture()
  try {
    const vehicle = source.createVehicle(), bytes = Buffer.from('Quarantined original report bytes'), key = await source.business.blob(bytes)
    source.business.write({ kind: 'attachment', vehicleId: vehicle.id, data: { name: 'original.pdf', checksum: key, size: bytes.length }, actor: source.actor, reason: 'Retain original', internal: true })
    const operation = JSON.parse(source.store.db.prepare('SELECT payload FROM outbox ORDER BY seq DESC LIMIT 1').get()!.payload as string) as Operation
    const marker = source.deletion(vehicle.id)
    source.sent(); source.store.applyDeletions([marker])
    const quarantine: QuarantinedOperation = { id: operation.id, vehicleId: vehicle.id, reason: 'VEHICLE_DELETED', quarantinedAt: new Date().toISOString(), operation }
    source.store.importQuarantine([quarantine])
    const backup = await createBackup(source.business, teamId), zip = await unzipper.Open.buffer(backup)
    assert.deepEqual(await zip.files.find(file => file.path === `blobs/${key}`)!.buffer(), bytes)
    const manifest = JSON.parse((await zip.files.find(file => file.path === 'manifest.json')!.buffer()).toString())
    assert.equal(manifest.format, 4); assert.equal(manifest.records.length, 0); assert.equal(manifest.deletions.length, 1); assert.equal(manifest.quarantinedOperations.length, 1)
    const result = await restoreBackup(target.business, backup, teamId, target.actor, 'Restore retained audit data')
    assert.equal(result.changed, 0); assert.equal(target.business.list().length, 0)
    assert.deepEqual(target.store.quarantineRows(), [quarantine]); assert.deepEqual(await target.business.readBlob(key), bytes)
    assert.equal(target.store.deletionFor(vehicle.id)?.id, marker.id)
    assert.equal(target.store.get<Array<{ deletion: VehicleDeletion }>>('pendingDeletionImports')![0].deletion.id, marker.id)
    assert.equal(target.store.db.prepare("SELECT COUNT(*) AS count FROM outbox WHERE state='pending'").get()!.count, 0)
    assert.ok(target.business.history(vehicle.id).length > 0)
    await restoreBackup(target.business, backup, teamId, target.actor, 'Repeat audit restore')
    assert.equal(target.store.quarantineRows().length, 1)
    const invalid = await rewrite(backup, data => { data.quarantinedOperations![0].operation.files = ['b'.repeat(64)] })
    await assert.rejects(restoreBackup(target.business, invalid, teamId, target.actor, 'Missing quarantine file'), { code: 'INVALID_BACKUP' })
    const wrongSize = await rewrite(backup, data => { data.quarantinedOperations![0].operation.desired.data.size = bytes.length + 1 })
    await assert.rejects(restoreBackup(target.business, wrongSize, teamId, target.actor, 'Invalid quarantine metadata'), { code: 'INVALID_BACKUP' })
  } finally { await source.close(); await target.close() }
})

test('a backup cannot use deletion markers to remove a currently live vehicle or cross teams', async () => {
  const source = await fixture(), target = await fixture()
  try {
    const vehicle = source.createVehicle(), marker = source.deletion(vehicle.id)
    source.sent(); source.store.applyDeletions([marker])
    const backup = await createBackup(source.business, teamId)
    const overlapping = await rewrite(backup, manifest => {
      const other = randomUUID()
      manifest.deletions!.push({ ...marker, id: randomUUID(), requestId: randomUUID(), vehicleId: other, recordIds: [other, marker.vehicleId] })
    })
    await assert.rejects(restoreBackup(source.business, overlapping, teamId, source.actor, 'Conflicting marker ownership'), { code: 'INVALID_BACKUP' })
    const live = target.createVehicle(vin, vehicle.id); target.sent()
    await assert.rejects(restoreBackup(target.business, backup, teamId, target.actor, 'Unsafe imported marker'), { code: 'BACKUP_DELETION_CONFLICT' })
    assert.equal(target.business.get(live.id).data.vin, vin); assert.equal(target.store.deletionRows().length, 0)
    const wrongTeam = await rewrite(backup, manifest => { manifest.teamId = 'another-team' })
    await assert.rejects(restoreBackup(target.business, wrongTeam, teamId, target.actor, 'Wrong team'), { code: 'INVALID_BACKUP' })
    const malformed = await rewrite(backup, manifest => { manifest.deletions![0].sequence = -1 })
    await assert.rejects(restoreBackup(target.business, malformed, teamId, target.actor, 'Invalid marker'), { code: 'INVALID_BACKUP' })
    for (const field of ['id', 'requestId', 'vehicleId', 'revision'] as const) {
      const badUuid = await rewrite(backup, manifest => { manifest.deletions![0][field] = 'invalid-uuid' })
      await assert.rejects(restoreBackup(target.business, badUuid, teamId, target.actor, 'Invalid marker UUID'), { code: 'INVALID_BACKUP' })
    }
    assert.equal(target.business.get(live.id).data.vin, vin)
  } finally { await source.close(); await target.close() }
})

test('VIN reuse permits a fresh same-file report but never retargets an old matched draft', async () => {
  const context = await fixture()
  try {
    const service = new DoveService(context.business), bytes = await workbook(), original = context.createVehicle()
    const firstDraft = await service.preview(bytes, 'original.xlsx', context.actor.id)
    const first = await service.save(firstDraft.id, context.actor.id, context.actor, { confirmed: true, reportOnly: true })
    assert.equal(first.id, `report-${original.id}-${checksum(bytes)}`)
    const stale = await service.preview(bytes, 'stale.xlsx', context.actor.id), marker = context.deletion(original.id)
    context.sent(); context.store.applyDeletions([marker])
    const replacement = context.createVehicle()
    assert.notEqual(replacement.id, original.id)
    await assert.rejects(service.save(stale.id, context.actor.id, context.actor, { confirmed: true, reportOnly: true }), { code: 'VEHICLE_DELETED' })
    const fresh = await service.preview(bytes, 'fresh.xlsx', context.actor.id)
    assert.equal(fresh.vehicle!.id, replacement.id); assert.equal(fresh.existingId, null)
    const report = await service.save(fresh.id, context.actor.id, context.actor, { confirmed: true, reportOnly: true })
    assert.equal(report.id, `report-${replacement.id}-${checksum(bytes)}`); assert.notEqual(report.id, first.id)
    assert.deepEqual(await context.business.readBlob(String(report.data.checksum)), bytes)
    assert.equal(context.business.list('report', replacement.id).length, 1)
  } finally { await context.close() }
})

test('legacy report IDs are reused for the same vehicle UUID and checksum', async () => {
  const context = await fixture()
  try {
    const service = new DoveService(context.business), bytes = await workbook(), vehicle = context.createVehicle()
    const draft = await service.preview(bytes, 'legacy.xlsx', context.actor.id), key = await context.business.blob(bytes)
    const legacy = context.business.write({ id: `report-${key}`, kind: 'report', vehicleId: vehicle.id, data: { name: 'legacy.xlsx', checksum: key, size: bytes.length, recordedAt: draft.parsed.recordedAt, savedAt: new Date().toISOString(), parserVersion: 'legacy', parsed: draft.parsed, vehicleSnapshot: vehicle.data }, actor: context.actor, reason: 'Seed legacy report', internal: true })
    const repeated = await service.preview(bytes, 'renamed.xlsx', context.actor.id)
    assert.equal(repeated.existingId, legacy.id)
    assert.equal((await service.save(repeated.id, context.actor.id, context.actor, { confirmed: true, reportOnly: true })).id, legacy.id)
    assert.equal(context.business.list('report', vehicle.id).length, 1)
  } finally { await context.close() }
})

test('DOVE rechecks the bound UUID after asynchronous original-file persistence', async () => {
  const context = await fixture()
  try {
    const service = new DoveService(context.business), bytes = await workbook(), vehicle = context.createVehicle()
    const draft = await service.preview(bytes, 'concurrent.xlsx', context.actor.id), originalBlob = context.business.blob.bind(context.business)
    context.business.blob = async content => {
      const key = await originalBlob(content), marker = context.deletion(vehicle.id)
      context.sent(); context.store.applyDeletions([marker]); context.createVehicle()
      return key
    }
    await assert.rejects(service.save(draft.id, context.actor.id, context.actor, { confirmed: true, reportOnly: true }), { code: 'VEHICLE_DELETED' })
    assert.equal(context.business.list('report').length, 0)
  } finally { await context.close() }
})
