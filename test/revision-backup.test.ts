import { test } from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { ZipArchive } from 'archiver'
import unzipper from 'unzipper'
import { LocalStore } from '../server/store.js'
import { Business } from '../server/business.js'
import { createBackup, previewBackup, restoreBackup } from '../server/backup.js'
import type { ConfigurationReceiptEntry, PendingConfigurationImport } from '../server/backup.js'
import type { Actor, BusinessRecord, VehicleDeletion } from '../shared/business.js'
import { configurationDecisionKey, configurationRevisionLabel, configurationRevisionSummaries, configurationSections, configurationSnapshot, configurationSourceFingerprint, validateConfigurationRecords } from '../shared/configuration-revisions.js'
import type { ConfigurationDecisions, ConfigurationRevisionData } from '../shared/configuration-revisions.js'

const teamId = randomUUID(), vin = 'TEST0000000000001', date = '2026-10-29T01:00:00.000Z'
type Manifest = { format: number; schemaVersion: number; fieldVersion: number; records: BusinessRecord[]; configurationReceipts?: ConfigurationReceiptEntry[] }
async function fixture() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'vehicle-revision-backup-'))
  const store = new LocalStore(directory), business = new Business(store)
  store.set('businessProtocol', 3)
  const actor: Actor = { id: 'backup-admin', name: 'Backup administrator', role: 'admin', deviceId: store.deviceId }
  const car = (id = randomUUID(), owner = '') => business.write({ id, kind: 'vehicle', data: { vin, status: 'available', owner }, actor, reason: 'Register fictional vehicle' })
  const sent = () => store.db.exec("UPDATE outbox SET state='sent'")
  const insert = (record: BusinessRecord) => store.db.prepare('INSERT INTO records VALUES(?,?,?,?,?,?,?,?)').run(record.id, record.kind, record.vehicleId, record.kind === 'vehicle' ? String(record.data.vin) : null, JSON.stringify(record.data), Number(record.archived), record.version, record.updated)
  const type = (id = randomUUID(), name = 'Charger') => {
    const record: BusinessRecord = { id, kind: 'componentType', vehicleId: null, archived: false, version: 1, updated: date, data: { schema: 1, name, description: 'Fictional type', disabled: false, definitionVersion: 1 } }
    insert(record); return record
  }
  const revision = (vehicleId: string, previous: BusinessRecord | null = null, id = randomUUID()) => {
    const sections = configurationSections(business.list(), vehicleId)
    const decisions: ConfigurationDecisions = { fields: {}, sections: {} }
    for (const section of sections) {
      if (!section.components.length) decisions.sections[section.typeId] = { state: 'notInstalled', reason: 'Not installed in this fictional baseline' }
      for (const component of section.components) for (const field of component.fields) if (field.required && !field.value) decisions.fields[configurationDecisionKey(component.id, field.id)] = { state: 'unknown', reason: 'Historical identifier is unavailable' }
    }
    const number = previous ? Number(previous.data.number) + 1 : 1
    const label = configurationRevisionLabel(number)
    const data: ConfigurationRevisionData = { schema: 1, name: label, vehicleId, vin, number, label, title: '', summary: `Publish ${label}`, publishedAt: date, actor, previousRevisionId: previous?.id || null, sourceFingerprint: configurationSourceFingerprint(sections), snapshot: configurationSnapshot(sections, decisions) }
    const record: BusinessRecord = { id, kind: 'configurationRevision', vehicleId, archived: false, version: 1, updated: date, data }
    insert(record); validateConfigurationRecords(business.list()); return record
  }
  const receipt = (record: BusinessRecord, requestId = randomUUID()): ConfigurationReceiptEntry => ({ key: `configurationRequest:${requestId}`, value: JSON.stringify({ actorKey: `${actor.id}:${actor.deviceId}`, commandDigest: 'a'.repeat(64), kind: 'publish', receipt: { requestId, revisionId: record.id, vehicleId: record.vehicleId, number: record.data.number, label: record.data.label, publishedAt: record.data.publishedAt, localSynced: true } }) })
  const fingerprint = () => JSON.stringify(['settings', 'records', 'changes', 'outbox', 'local_events'].map(table => store.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()))
  return { directory, store, business, actor, car, sent, insert, type, revision, receipt, fingerprint, close: async () => { store.db.close(); await fs.rm(directory, { recursive: true, force: true }) } }
}
async function rewrite(bytes: Buffer, mutate: (manifest: Manifest) => void): Promise<Buffer> {
  const zip = await unzipper.Open.buffer(bytes), archive = new ZipArchive(), chunks: Buffer[] = []
  const done = new Promise<Buffer>((resolve, reject) => { archive.on('data', chunk => chunks.push(Buffer.from(chunk))); archive.once('error', reject); archive.once('end', () => resolve(Buffer.concat(chunks))) })
  for (const file of zip.files) {
    const bytes = await file.buffer()
    if (file.path === 'manifest.json') { const manifest = JSON.parse(bytes.toString()) as Manifest; mutate(manifest); archive.append(JSON.stringify(manifest), { name: file.path }) }
    else archive.append(bytes, { name: file.path })
  }
  void archive.finalize(); return done
}
async function manifest(bytes: Buffer): Promise<Manifest> { const zip = await unzipper.Open.buffer(bytes); return JSON.parse((await zip.files.find(file => file.path === 'manifest.json')!.buffer()).toString()) as Manifest }

test('format4 preserves frozen revisions, custom types and receipts through the durable import queue and reopening', async () => {
  const source = await fixture(), target = await fixture()
  try {
    const car = source.car(), type = source.type(), revision = source.revision(car.id), receipt = source.receipt(revision)
    source.store.set('configurationReceipts', [receipt]); source.sent()
    const bytes = await createBackup(source.business, teamId), content = await manifest(bytes)
    assert.equal(content.format, 4); assert.equal(content.schemaVersion, 5); assert.equal(content.fieldVersion, 2)
    assert.deepEqual(content.configurationReceipts, [receipt])
    const result = await restoreBackup(target.business, bytes, teamId, target.actor, 'Restore frozen history')
    assert.equal(result.changed, 3)
    const pending = target.store.get<PendingConfigurationImport[]>('pendingConfigurationImports')!
    assert.deepEqual(pending[0].records.map(record => record.id).sort(), [type.id, revision.id].sort())
    assert.deepEqual(pending[0].receipts, [receipt])
    assert.equal(target.business.list().some(record => record.kind === 'configurationRevision' || record.kind === 'componentType'), false)
    assert.deepEqual(target.store.db.prepare("SELECT payload FROM outbox WHERE state='pending'").all().map(row => JSON.parse(String(row.payload)).kind), ['vehicle'])
    const rebundled = await manifest(await createBackup(target.business, teamId))
    assert.deepEqual(rebundled.records.filter(record => record.kind === 'configurationRevision' || record.kind === 'componentType').map(record => record.id).sort(), [type.id, revision.id].sort())
    assert.deepEqual(rebundled.configurationReceipts, [receipt])
    target.store.db.close()
    const reopened = new LocalStore(target.directory)
    try { assert.deepEqual(reopened.get('pendingConfigurationImports'), pending) } finally { reopened.db.close() }
  } finally { await source.close(); if (target.store.db.isOpen) await target.close(); else await fs.rm(target.directory, { recursive: true, force: true }) }
})

for (const format of [1, 2, 3]) test(`older format${format} restores working data without archiving or rolling back protected history`, async () => {
  const source = await fixture(), target = await fixture()
  try {
    const car = source.car(), current = target.car(car.id), type = target.type(), first = target.revision(current.id), second = target.revision(current.id, first)
    target.store.db.prepare('UPDATE records SET data=? WHERE id=?').run(JSON.stringify({ ...type.data, name: 'Renamed charger', disabled: true, definitionVersion: 2 }), type.id)
    source.sent(); target.sent()
    const old = await rewrite(await createBackup(source.business, teamId), content => { content.format = format; content.fieldVersion = 1; content.schemaVersion = 4; delete content.configurationReceipts })
    const preview = await previewBackup(target.business, old, teamId)
    assert.deepEqual(preview.archiveCandidates, []); assert.deepEqual(preview.conflicts, [])
    await restoreBackup(target.business, old, teamId, target.actor, 'Restore an older working copy')
    assert.deepEqual(target.business.get(second.id).data, second.data)
    assert.equal(target.business.get(type.id).data.name, 'Renamed charger'); assert.equal(target.business.get(type.id).data.disabled, true)
    assert.equal(configurationRevisionSummaries(target.business.list())[0].label, 'R02')
    assert.equal(target.store.get('pendingConfigurationImports'), null)
  } finally { await source.close(); await target.close() }
})

test('existing catalog definitions win older backup labels while exact old revisions do not replace the current R number', async () => {
  const source = await fixture(), target = await fixture()
  try {
    const car = source.car(), type = source.type(), first = source.revision(car.id)
    target.car(car.id); target.insert(type); target.insert(first); const second = target.revision(car.id, first)
    target.store.db.prepare('UPDATE records SET data=? WHERE id=?').run(JSON.stringify({ ...type.data, name: 'Current catalog name', disabled: true, definitionVersion: 2 }), type.id)
    source.sent(); target.sent()
    const bytes = await createBackup(source.business, teamId)
    assert.deepEqual((await previewBackup(target.business, bytes, teamId)).archiveCandidates, [])
    assert.equal((await restoreBackup(target.business, bytes, teamId, target.actor, 'Preserve latest history')).changed, 0)
    assert.deepEqual(target.business.get(second.id).data, second.data); assert.equal(target.business.get(type.id).data.name, 'Current catalog name')
    assert.equal(target.store.get('pendingConfigurationImports'), null)
  } finally { await source.close(); await target.close() }
})

test('changed immutable payloads and duplicate ordinals are rejected before working records, settings or queues change', async () => {
  const source = await fixture(), target = await fixture()
  try {
    const car = source.car(), first = source.revision(car.id)
    target.car(car.id); target.insert(first); source.sent(); target.sent()
    const bytes = await createBackup(source.business, teamId), before = target.fingerprint()
    for (const mutate of [
      (content: Manifest) => { content.records.find(record => record.id === first.id)!.data.summary = 'Forged replacement' },
      (content: Manifest) => { content.records.push({ ...structuredClone(first), id: randomUUID() }) },
    ]) {
      const changed = await rewrite(bytes, mutate)
      assert((await previewBackup(target.business, changed, teamId)).conflicts.includes('CONFIGURATION_HISTORY'))
      await assert.rejects(restoreBackup(target.business, changed, teamId, target.actor, 'Reject conflicting history'), { code: 'BACKUP_CONFIGURATION_CONFLICT' })
      assert.equal(target.fingerprint(), before)
    }
  } finally { await source.close(); await target.close() }
})

test('deleted UUIDs skip historical revisions while durable publication receipts survive without resurrection', async () => {
  const source = await fixture(), target = await fixture()
  try {
    const car = source.car(), revision = source.revision(car.id), receipt = source.receipt(revision)
    source.store.set('configurationReceipts', [receipt]); source.sent()
    const deletion: VehicleDeletion = { id: randomUUID(), requestId: randomUUID(), vehicleId: car.id, vin, recordIds: [car.id, revision.id], fileKeys: [], actor: target.actor, reason: 'Delete fictional vehicle', deletedAt: date, revision: randomUUID(), sequence: 1 }
    target.store.applyDeletions([deletion])
    const result = await restoreBackup(target.business, await createBackup(source.business, teamId), teamId, target.actor, 'Skip deleted history')
    assert.equal(result.skippedVehicles, 1); assert.equal(result.skippedRecords, 2); assert.equal(target.business.list().length, 0)
    const queued = target.store.get<PendingConfigurationImport[]>('pendingConfigurationImports')!
    assert.deepEqual(queued[0].records, []); assert.deepEqual(queued[0].receipts, [receipt])
    const rebundled = await manifest(await createBackup(target.business, teamId))
    assert.deepEqual(rebundled.records, []); assert.deepEqual(rebundled.configurationReceipts, [receipt])
    assert.notEqual(target.car().id, car.id)
  } finally { await source.close(); await target.close() }
})

test('protected imports require activation and reject malformed format4 receipt/schema metadata', async () => {
  const source = await fixture(), target = await fixture()
  try {
    const car = source.car(), revision = source.revision(car.id), receipt = source.receipt(revision)
    source.store.set('configurationReceipts', [receipt]); source.sent(); target.store.set('businessProtocol', 2)
    const bytes = await createBackup(source.business, teamId), before = target.fingerprint()
    await assert.rejects(previewBackup(target.business, bytes, teamId), { code: 'CONFIGURATION_NOT_ENABLED' })
    await assert.rejects(restoreBackup(target.business, bytes, teamId, target.actor, 'Require activation'), { code: 'CONFIGURATION_NOT_ENABLED' })
    assert.equal(target.fingerprint(), before)
    target.store.set('businessProtocol', 3)
    for (const mutate of [
      (content: Manifest) => { content.schemaVersion = 6 },
      (content: Manifest) => { content.configurationReceipts = undefined },
      (content: Manifest) => { content.configurationReceipts![0].value = '{}' },
    ]) await assert.rejects(restoreBackup(target.business, await rewrite(bytes, mutate), teamId, target.actor, 'Reject malformed metadata'), { code: 'INVALID_BACKUP' })
  } finally { await source.close(); await target.close() }
})
