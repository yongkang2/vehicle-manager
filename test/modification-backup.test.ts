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
import { createBackup, previewBackup, restoreBackup } from '../server/backup.js'
import type { Actor, BusinessRecord, Change, VehicleDeletion } from '../shared/business.js'
import { modificationView } from '../shared/modifications.js'
import type { AbandonedModificationImport, ModificationFile, ModificationImport, ModificationReceiptEntry } from '../shared/modifications.js'

const teamId = randomUUID(), date = '2026-11-08T01:02:03.000Z'
type Manifest = { format: number; schemaVersion: number; fieldVersion: number; records: BusinessRecord[]; changes: Change[]; source: { pending: number }; modificationReceipts?: ModificationReceiptEntry[] }
async function fixture() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'modification-backup-'))
  const store = new LocalStore(directory), business = new Business(store)
  store.set('businessProtocol', 5)
  const actor: Actor = { id: randomUUID(), name: 'Fictional backup administrator', role: 'admin', deviceId: store.deviceId }
  const insert = (record: BusinessRecord) => { store.db.prepare('INSERT INTO records VALUES(?,?,?,?,?,?,?,?)').run(record.id, record.kind, record.vehicleId, record.kind === 'vehicle' ? String(record.data.vin) : null, JSON.stringify(record.data), Number(record.archived), record.version, record.updated); return record }
  const car = (id = randomUUID(), vin = 'TEST0000000000001') => business.write({ id, kind: 'vehicle', data: { name: 'Fictional vehicle', vin, status: 'available' }, actor, reason: 'Register a fictional backup vehicle' })
  const file = async (name = 'request.txt', content = 'Fictional modification request\r\n改装说明') => {
    const bytes = Buffer.from(content)
    return { metadata: { id: randomUUID(), name, checksum: await business.blob(bytes), size: bytes.length, savedAt: date, archived: false } satisfies ModificationFile, bytes }
  }
  const group = (files: ModificationFile[] = [], id = randomUUID()) => insert({ id, kind: 'modificationGroup', vehicleId: null, archived: false, version: 1, updated: date, data: { schema: 1, name: 'Shared retrofit', description: 'Fictional fleet retrofit', requestor: 'Requestor 甲', lead: 'Lead 乙', installedAt: '2026-11-01', removedAt: '', notes: 'Reviewed fictional parts', attachments: files } })
  const member = (vehicleId: string, groupId: string, id = randomUUID()) => insert({ id, kind: 'modification', vehicleId, archived: false, version: 1, updated: date, data: { groupId } })
  const standalone = (vehicleId: string, files: ModificationFile[] = [], id = randomUUID()) => insert({ id, kind: 'modification', vehicleId, archived: false, version: 1, updated: date, data: { name: 'Independent retrofit', description: '', requestor: 'Independent requestor', lead: '', installedAt: '', removedAt: '', notes: '', attachments: files } })
  const sent = () => store.db.exec("UPDATE outbox SET state='sent'")
  const fingerprint = () => JSON.stringify(['records', 'settings', 'changes', 'outbox'].map(table => store.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()))
  const close = async () => { if (store.db.isOpen) store.db.close(); await fs.rm(directory, { recursive: true, force: true }) }
  return { directory, store, business, actor, insert, car, file, group, member, standalone, sent, fingerprint, close }
}
async function content(bytes: Buffer): Promise<Manifest> { const zip = await unzipper.Open.buffer(bytes); return JSON.parse((await zip.files.find(file => file.path === 'manifest.json')!.buffer()).toString()) as Manifest }
async function rewrite(bytes: Buffer, mutate: (manifest: Manifest) => void): Promise<Buffer> {
  const zip = await unzipper.Open.buffer(bytes), archive = new ZipArchive(), chunks: Buffer[] = []
  const completed = new Promise<Buffer>((resolve, reject) => { archive.on('data', chunk => chunks.push(Buffer.from(chunk))); archive.once('error', reject); archive.once('end', () => resolve(Buffer.concat(chunks))) })
  for (const file of zip.files) {
    const bytes = await file.buffer()
    if (file.path === 'manifest.json') { const manifest = JSON.parse(bytes.toString()) as Manifest; mutate(manifest); archive.append(JSON.stringify(manifest), { name: file.path }) }
    else archive.append(bytes, { name: file.path })
  }
  void archive.finalize(); return completed
}

test('retained unpublished modification restores round-trip payloads, history and originals without replaying them', async () => {
  const source = await fixture(), target = await fixture()
  try {
    const car = source.car(), file = await source.file(), row = source.standalone(car.id, [file.metadata])
    const change: Change = { id: randomUUID(), recordId: row.id, vehicleId: car.id, kind: 'modification', before: null, after: row.data, archivedBefore: null, archivedAfter: false, actor: source.actor, reason: 'An unpublished desired restore', action: 'modification.restored', sourceId: null, created: date }
    const entry: AbandonedModificationImport = { id: randomUUID(), abandonedAt: date, actor: source.actor, reason: 'Review current shared configuration', import: { id: randomUUID(), restoreRequestId: randomUUID(), records: [row], receipts: [], baseVersions: { [row.id]: null }, baseStates: { [row.id]: null }, forwardChanges: [change], actor: source.actor, reason: 'An unpublished desired restore' } }
    source.store.set('abandonedModificationImports', [entry]); source.sent()
    // The retained payload remains useful even after its original vehicle is gone.
    source.store.db.prepare('DELETE FROM records WHERE id IN (?,?)').run(row.id, car.id)
    const bytes = await createBackup(source.business, teamId)
    await restoreBackup(target.business, bytes, teamId, target.actor, 'Recover retained payload for inspection only')
    assert.deepEqual(target.store.get('abandonedModificationImports'), [entry])
    assert.equal(target.business.list('modification').length, 0)
    assert.equal(target.store.get('pendingModificationImports'), null)
    assert.deepEqual(await target.business.readBlob(file.metadata.checksum), file.bytes)
    const restored = await content(await createBackup(target.business, teamId))
    assert.deepEqual((restored as Manifest & { abandonedModificationImports: AbandonedModificationImport[] }).abandonedModificationImports, [entry])
  } finally { await source.close(); await target.close() }
})

test('format5 preserves shared fields, dates, files and durable receipts in an atomic managed restore queue', async () => {
  const source = await fixture(), target = await fixture()
  try {
    const first = source.car(), second = source.car(randomUUID(), 'TEST0000000000002'), file = await source.file(), group = source.group([file.metadata]), left = source.member(first.id, group.id), right = source.member(second.id, group.id)
    const requestId = randomUUID(), receipt: ModificationReceiptEntry = { key: `modificationRequest:${requestId}`, value: JSON.stringify({ actorKey: source.actor.id, commandDigest: 'a'.repeat(64), kind: 'populate', receipt: { requestId, action: 'populated', recordIds: [left.id, right.id], groupId: group.id, localSynced: true } }) }
    source.store.set('modificationReceipts', [receipt]); source.sent()
    const bytes = await createBackup(source.business, teamId), manifest = await content(bytes)
    assert.equal(manifest.format, 5); assert.equal(manifest.schemaVersion, 6); assert.equal(manifest.fieldVersion, 4)
    assert.deepEqual(manifest.modificationReceipts, [receipt])
    const zip = await unzipper.Open.buffer(bytes)
    assert.deepEqual(await zip.files.find(entry => entry.path === `blobs/${file.metadata.checksum}`)!.buffer(), file.bytes)
    const preview = await previewBackup(target.business, bytes, teamId)
    assert.deepEqual(preview.conflicts, []); assert.deepEqual(preview.droppedFields, []); assert.equal(preview.additions, 5)
    const result = await restoreBackup(target.business, bytes, teamId, target.actor, 'Restore fictional linked modifications')
    assert.equal(result.changed, 5)
    const pending = target.store.get<ModificationImport[]>('pendingModificationImports')!
    assert.equal(pending.length, 1); assert.deepEqual(pending[0].records.map(row => row.id).sort(), [group.id, left.id, right.id].sort())
    assert.deepEqual(pending[0].baseStates, { [group.id]: null, [left.id]: null, [right.id]: null })
    assert.deepEqual(pending[0].receipts, [receipt])
    assert.deepEqual(target.store.db.prepare("SELECT payload FROM outbox WHERE state='pending'").all().map(row => JSON.parse(String(row.payload)).kind), ['vehicle', 'vehicle'])
    const resolved = modificationView(target.business.list(), right.id)
    assert.equal(resolved.record.data.requestor, 'Requestor 甲'); assert.equal(resolved.record.data.lead, 'Lead 乙'); assert.equal(resolved.record.data.installedAt, '2026-11-01')
    assert.deepEqual(resolved.files, [file.metadata]); assert.deepEqual(await target.business.readBlob(file.metadata.checksum), file.bytes)
    const rebundled = await content(await createBackup(target.business, teamId))
    assert.equal(rebundled.records.filter(row => row.kind === 'modificationGroup').length, 1); assert.deepEqual(rebundled.modificationReceipts, [receipt]); assert(rebundled.source.pending >= 1)
    target.store.db.close(); const reopened = new LocalStore(target.directory)
    try { assert.deepEqual(reopened.get('pendingModificationImports'), pending) } finally { reopened.db.close() }
  } finally { await source.close(); await target.close() }
})

for (const format of [1, 2, 3, 4]) test(`format${format} cannot detach linked records, overwrite managed files or archive extra managed modifications`, async () => {
  const source = await fixture(), target = await fixture()
  try {
    const car = source.car(); target.car(car.id)
    const old = source.business.write({ kind: 'modification', vehicleId: car.id, data: { name: 'Historical standalone modification', description: 'Before it was shared' }, actor: source.actor, reason: 'Create old fictional modification' })
    const file = await target.file(), group = target.group([file.metadata]), member = target.member(car.id, group.id, old.id), extra = target.standalone(car.id, [file.metadata])
    source.sent(); target.sent()
    const bytes = await rewrite(await createBackup(source.business, teamId), manifest => { manifest.format = format; manifest.schemaVersion = format === 4 ? 5 : 4; manifest.fieldVersion = format === 4 ? 2 : 1; delete manifest.modificationReceipts })
    const preview = await previewBackup(target.business, bytes, teamId)
    assert.deepEqual(preview.conflicts, []); assert.deepEqual(preview.archiveCandidates, []); assert.deepEqual(preview.droppedFields, [])
    const effect = preview.effects.find(effect => effect.id === member.id)!
    assert.equal(effect.action, 'unchanged'); assert.deepEqual(effect.fields, [])
    await restoreBackup(target.business, bytes, teamId, target.actor, 'Preserve shared modifications from an old backup')
    assert.deepEqual(target.business.get(member.id).data, { groupId: group.id })
    assert.deepEqual(target.business.get(group.id).data, group.data)
    assert.deepEqual(target.business.get(extra.id).data, extra.data); assert.equal(target.business.get(extra.id).archived, false)
    assert.equal(target.store.get('pendingModificationImports'), null)
  } finally { await source.close(); await target.close() }
})

test('format5 rejects dangling groups, corrupt originals and contradictory receipts before changing working state', async () => {
  const source = await fixture(), target = await fixture()
  try {
    const car = source.car(), file = await source.file(), group = source.group([file.metadata]); source.member(car.id, group.id); source.sent()
    const bytes = await createBackup(source.business, teamId), before = target.fingerprint()
    const dangling = await rewrite(bytes, manifest => { manifest.records = manifest.records.filter(row => row.id !== group.id) })
    assert((await previewBackup(target.business, dangling, teamId)).conflicts.includes('MODIFICATION_GRAPH'))
    await assert.rejects(restoreBackup(target.business, dangling, teamId, target.actor, 'Reject a dangling group'), { code: 'BACKUP_MODIFICATION_CONFLICT' })
    const corrupted = await rewrite(bytes, manifest => { const owner = manifest.records.find(row => row.id === group.id)!; (owner.data.attachments as ModificationFile[])[0].checksum = 'f'.repeat(64) })
    await assert.rejects(previewBackup(target.business, corrupted, teamId), { code: 'INVALID_BACKUP' })
    assert.equal(target.fingerprint(), before)
  } finally { await source.close(); await target.close() }
})

test('format5 skips deleted vehicle memberships without deleting the workspace-owned group or surviving files', async () => {
  const source = await fixture(), target = await fixture()
  try {
    const first = source.car(), second = source.car(randomUUID(), 'TEST0000000000002'), file = await source.file(), group = source.group([file.metadata]), deletedMember = source.member(first.id, group.id), liveMember = source.member(second.id, group.id)
    const deletion: VehicleDeletion = { id: randomUUID(), requestId: randomUUID(), vehicleId: first.id, vin: String(first.data.vin), recordIds: [first.id, deletedMember.id], fileKeys: [], actor: target.actor, reason: 'Permanently remove a fictional vehicle', deletedAt: date, revision: randomUUID(), sequence: 1 }
    target.store.applyDeletions([deletion]); source.sent(); target.sent()
    const result = await restoreBackup(target.business, await createBackup(source.business, teamId), teamId, target.actor, 'Restore only surviving memberships')
    assert.equal(result.skippedVehicles, 1); assert.equal(result.skippedRecords, 2)
    assert.equal(target.business.list().some(row => row.id === deletedMember.id || row.id === first.id), false)
    assert.equal(target.business.get(group.id).vehicleId, null)
    assert.equal(modificationView(target.business.list(), liveMember.id).files[0].checksum, file.metadata.checksum)
    assert.deepEqual(await target.business.readBlob(file.metadata.checksum), file.bytes)
  } finally { await source.close(); await target.close() }
})

test('format5 archives omitted linked memberships as independent frozen copies in the managed transaction', async () => {
  const source = await fixture(), target = await fixture()
  try {
    const first = source.car(), second = source.car(randomUUID(), 'TEST0000000000002'); target.car(first.id); target.car(second.id, 'TEST0000000000002')
    const file = await target.file(), group = target.group([file.metadata]), left = target.member(first.id, group.id), right = target.member(second.id, group.id)
    source.sent(); target.sent()
    const bytes = await createBackup(source.business, teamId), preview = await previewBackup(target.business, bytes, teamId)
    assert.deepEqual(preview.archiveCandidates.map(row => row.id).sort(), [left.id, right.id].sort())
    await restoreBackup(target.business, bytes, teamId, target.actor, 'Archive omitted shared modification instances', preview.archiveCandidates.map(row => row.id))
    for (const id of [left.id, right.id]) {
      const frozen = target.business.get(id)
      assert.equal(frozen.archived, true); assert.equal(frozen.data.groupId, undefined); assert.equal(frozen.data.name, 'Shared retrofit'); assert.deepEqual(frozen.data.attachments, [file.metadata])
    }
    assert.equal(target.business.get(group.id).archived, false)
    const pending = target.store.get<ModificationImport[]>('pendingModificationImports')!
    assert.deepEqual(pending[0].records.map(row => row.id).sort(), [group.id, left.id, right.id].sort())
    assert.deepEqual(pending[0].baseStates[left.id], { data: { groupId: group.id }, archived: false })
    assert.equal(target.business.get(group.id).version, group.version + 1, 'Membership-only restores must invalidate older shared-scope reviews')
  } finally { await source.close(); await target.close() }
})


for (const format of [4, 5]) test(`format${format} restores with independent enhanced text require activation before any local mutation`, async () => {
  const source = await fixture(), target = await fixture()
  try {
    const car = source.car()
    const modification = source.business.write({ kind: 'modification', vehicleId: car.id, data: { name: 'Text-only modification', requestor: 'Restored requestor', lead: 'Restored lead' }, actor: source.actor, reason: 'Retain enhanced text without attachments' })
    source.sent(); target.store.set('businessProtocol', 1)
    const original = await createBackup(source.business, teamId)
    const bytes = format === 5 ? original : await rewrite(original, manifest => { manifest.format = 4; manifest.schemaVersion = 5; manifest.fieldVersion = 3 })
    const before = target.fingerprint()
    await assert.rejects(previewBackup(target.business, bytes, teamId), { code: 'MODIFICATION_NOT_ENABLED' })
    await assert.rejects(restoreBackup(target.business, bytes, teamId, target.actor, 'Restore only after explicit activation'), { code: 'MODIFICATION_NOT_ENABLED' })
    assert.equal(target.fingerprint(), before)
    target.store.set('businessProtocol', 5)
    await restoreBackup(target.business, bytes, teamId, target.actor, 'Activated restoration retains enhanced text')
    assert.equal(target.business.get(modification.id).data.requestor, 'Restored requestor')
    assert.equal(target.business.get(modification.id).data.lead, 'Restored lead')
  } finally { await source.close(); await target.close() }
})

for (const action of ['overwrite', 'archive', 'archiveParent']) test(`restoration cannot ${action} pre-fix enhanced text before activation`, async () => {
  const source = await fixture(), target = await fixture()
  try {
    const car = source.car(); target.car(car.id)
    const modification = target.insert({ id: randomUUID(), kind: 'modification', vehicleId: car.id, archived: false, version: 1, updated: date, data: { name: 'Pre-fix text-only modification', requestor: 'Keep existing requestor', lead: 'Keep existing lead' } })
    if (action === 'overwrite') source.insert({ ...modification, data: { name: 'Older snapshot with omitted fields' } })
    if (action === 'archiveParent') source.store.db.prepare('UPDATE records SET archived=1 WHERE id=?').run(car.id)
    source.sent(); target.sent(); target.store.set('businessProtocol', 1)
    const bytes = await createBackup(source.business, teamId), before = target.fingerprint()
    const archive = action === 'overwrite' ? [] : [modification.id]
    await assert.rejects(previewBackup(target.business, bytes, teamId), { code: 'MODIFICATION_NOT_ENABLED' })
    await assert.rejects(restoreBackup(target.business, bytes, teamId, target.actor, 'Do not modify protected pre-fix values', archive), { code: 'MODIFICATION_NOT_ENABLED' })
    assert.equal(target.fingerprint(), before)
    assert.equal(target.business.get(modification.id).data.requestor, 'Keep existing requestor')
    assert.equal(target.business.get(modification.id).data.lead, 'Keep existing lead')
  } finally { await source.close(); await target.close() }
})
