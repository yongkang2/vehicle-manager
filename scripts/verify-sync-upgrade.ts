// Isolated source-to-source upgrade check; never opens configured application data.
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { pathToFileURL } from 'node:url'
import { randomUUID } from 'node:crypto'
import ExcelJS from 'exceljs'
import { LocalStore } from '../server/store.js'
import { Business } from '../server/business.js'
import { BusinessSync } from '../server/sync.js'
import { TeamDirectory } from '../server/team.js'
import { createBackup, previewBackup, restoreBackup } from '../server/backup.js'
import { Modifications } from '../server/modifications.js'
import { ConfigurationRevisions } from '../server/configuration-revisions.js'
import type { ConfigurationPreview, ConfigurationDecisions } from '../shared/configuration-revisions.js'

const run = promisify(execFile)
const project = path.resolve(import.meta.dirname, '..')
const baseline = '6f9354ac76e7999e9a115ad6aa95417366f01a0a'
const root = await fs.mkdtemp(path.join(project, 'test', 'test-data-upgrade-'))
async function profile(check: () => Promise<{ phase: string; timings?: unknown }>) {
  const samples = []
  for (let index = 0; index < 5; index++) {
    const started = performance.now(), state = await check()
    assert.equal(state.phase, 'ready')
    samples.push({ durationMs: Math.round(performance.now() - started), timings: state.timings })
  }
  return { medianMs: samples.map(sample => sample.durationMs).sort((a, b) => a - b)[2], samples }
}
async function whileLocked(teams: TeamDirectory, shared: string, teamId: string, identity: Parameters<TeamDirectory['withAccess']>[2], check: () => Promise<{ phase: string }>) {
  let entered!: () => void, release!: () => void
  const acquired = new Promise<void>(resolve => { entered = resolve }), gate = new Promise<void>(resolve => { release = resolve })
  const holder = teams.withAccess(shared, teamId, identity, false, async () => { entered(); await gate })
  await acquired
  const started = performance.now()
  try { const state = await check(); return { phase: state.phase, durationMs: Math.round(performance.now() - started) } }
  finally { release(); await holder }
}
let active: { db: { close(): void } } | undefined
try {
  const source = path.join(root, 'baseline'), shared = path.join(root, 'shared'), local = path.join(root, 'local')
  await fs.mkdir(source); await fs.mkdir(shared)
  const archive = path.join(root, 'source.tar')
  await run('git', ['archive', baseline, '--output', archive, 'server', 'shared', 'package.json'], { cwd: project })
  await run('tar', ['-xf', archive, '-C', source])
  assert.equal(JSON.parse(await fs.readFile(path.join(source, 'package.json'), 'utf8')).version, '1.9.1')
  const legacy = async (file: string) => import(pathToFileURL(path.join(source, 'server', `${file}.ts`)).href)
  const { LocalStore: OldStore } = await legacy('store'), { Business: OldBusiness } = await legacy('business')
  const { BusinessSync: OldSync } = await legacy('sync'), { TeamDirectory: OldTeams } = await legacy('team')
  const { Modifications: OldModifications } = await legacy('modifications'), { ConfigurationRevisions: OldRevisions } = await legacy('configuration-revisions')
  const { createBackup: oldBackup } = await legacy('backup')
  const { DoveService: OldDove } = await legacy('dove')
  const old = new OldStore(local); active = old
  const business = new OldBusiness(old), teams = new OldTeams(), sync = new OldSync(business, teams)
  const identity = { deviceId: old.deviceId, deviceName: 'Upgrade fixture', localUserId: 'owner', displayName: 'Owner' }
  const team = await teams.create(shared, 'Existing team', identity)
  const actor = { id: team.members[0].id, deviceId: old.deviceId, name: 'Owner', role: 'admin' as const }
  const vehicle = business.write({ kind: 'vehicle', data: { vin: 'TEST0000000000001', name: 'Existing vehicle', status: 'available' }, actor, reason: 'Existing data' })
  const bytes = Buffer.from('Existing original bytes'), checksum = await business.blob(bytes)
  business.write({ kind: 'attachment', vehicleId: vehicle.id, data: { name: 'original.txt', checksum, size: bytes.length }, actor, reason: 'Existing file', internal: true })
  const second = business.write({ kind: 'vehicle', data: { vin: 'TEST0000000000002', status: 'available' }, actor, reason: 'Linked target' })
  const archived = business.write({ kind: 'vehicle', data: { vin: 'TEST0000000000003', status: 'available' }, actor, reason: 'Archive fixture' })
  business.write({ id: archived.id, kind: 'vehicle', data: archived.data, version: archived.version, archived: true, actor, reason: 'Existing archived vehicle' })
  const equipment = business.write({ kind: 'equipment', vehicleId: vehicle.id, data: { name: 'Existing logger', equipmentType: 'ETAS tools' }, actor, reason: 'Existing equipment' })
  business.write({ kind: 'attachment', vehicleId: vehicle.id, data: { name: 'equipment.txt', checksum, size: bytes.length, equipmentId: equipment.id }, actor, reason: 'Existing equipment file', internal: true })
  const modification = business.write({ kind: 'modification', vehicleId: vehicle.id, data: { name: 'Existing retrofit' }, actor, reason: 'Existing modification' })
  const independent = business.write({ kind: 'modification', vehicleId: second.id, data: { name: 'Independent retrofit' }, actor, reason: 'Independent modification' })
  const book = new ExcelJS.Workbook()
  book.addWorksheet('DOVE').addRows([['Vin :', vehicle.data.vin], ['Date of record', '2026-10-21']])
  book.addWorksheet('Identification').addRows([['ECU', 'Description', 'Network', 'Supplier'], ['EVCU', 'Controller', 'CAN UDS', 'Supplier', 'FN', 'PN', '1.0', '', 'CAL', '2', '', '', '', '000123']])
  book.addWorksheet('Defauts')
  const reportBytes = Buffer.from(await book.xlsx.writeBuffer()), dove = new OldDove(business)
  const draft = await dove.preview(reportBytes, 'existing-report.xlsx', actor.id)
  const report = await dove.save(draft.id, actor.id, actor, { confirmed: true })
  assert.equal((await sync.synchronize(shared, team.id, identity)).phase, 'ready')
  const removed = business.write({ kind: 'vehicle', data: { vin: 'TEST0000000000004', status: 'available' }, actor, reason: 'Deleted identity fixture' })
  business.write({ id: removed.id, kind: 'vehicle', data: removed.data, version: removed.version, archived: true, actor, reason: 'Archive deleted identity' })
  await sync.synchronize(shared, team.id, identity)
  const deletionPreview = await sync.deletePreview(shared, team.id, identity, actor, removed.id)
  await sync.deleteVehicle(shared, team.id, identity, actor, removed.id, { previewToken: deletionPreview.token, version: deletionPreview.version, vin: deletionPreview.vin, confirmation: 'DELETE', reason: 'Existing deletion', requestId: randomUUID() })
  const context = { directory: shared, teamId: team.id, identity, actor, online: true, syncEnabled: true }
  const modifications = new OldModifications(business, sync), revisions = new OldRevisions(business, sync)
  await modifications.enable(context, { requestId: randomUUID(), reason: 'Existing team activation' })
  const mutation = (id: string) => { const view = modifications.detail(id); return { requestId: randomUUID(), version: view.record.version, groupVersion: view.groupVersion, reason: 'Existing retrofit operation' } }
  await modifications.upload(modification.id, { ...mutation(modification.id), name: 'request.txt', bytes }, context)
  await modifications.upload(independent.id, { ...mutation(independent.id), name: 'independent.txt', bytes }, context)
  await sync.synchronize(shared, team.id, identity)
  await modifications.populate(modification.id, { ...mutation(modification.id), mode: 'linked', targets: [{ vehicleId: second.id, expectedVin: second.data.vin }] }, context)
  await revisions.enable(context, { requestId: randomUUID(), reason: 'Existing configuration activation' })
  const customType = await revisions.createType(context, { name: 'Existing custom type', requestId: randomUUID(), reason: 'Existing catalog' })
  const preview: ConfigurationPreview = await revisions.preview(context, vehicle.id)
  const decisions: ConfigurationDecisions = { fields: {}, sections: {} }
  for (const section of preview.sections) {
    if (!section.components.length) decisions.sections[section.typeId] = { state: 'unknown', reason: 'Historical fixture unknown' }
    for (const component of section.components) for (const field of component.fields) if (field.required && !field.value.trim()) decisions.fields[`${component.id}:${field.id}`] = { state: 'unknown', reason: 'Historical fixture unknown' }
  }
  const published = await revisions.publish(context, vehicle.id, { previewToken: preview.token, requestId: randomUUID(), summary: 'Existing configuration', decisions })
  for (let index = 0; index < 300; index++) business.write({ kind: 'equipment', vehicleId: second.id, data: { name: `Existing equipment ${index}`, equipmentType: 'ETAS tools' }, actor, reason: 'Synthetic fleet profile' })
  assert.equal((await sync.synchronize(shared, team.id, identity)).phase, 'ready')
  const fullSyncBefore = await profile(() => sync.synchronize(shared, team.id, identity))
  const backup = await oldBackup(business, team.id)
  const before = await whileLocked(teams, shared, team.id, identity, () => sync.synchronize(shared, team.id, identity, { ifChanged: true }))
  assert.equal(before.phase, 'busy')
  assert.equal((await sync.synchronize(shared, team.id, identity)).phase, 'ready')
  const head = await fs.readFile(path.join(shared, 'business', 'HEAD.json'))
  const current = business.get(vehicle.id)
  business.write({ id: vehicle.id, kind: 'vehicle', data: { ...current.data, owner: 'Unsynchronized owner' }, version: current.version, actor, reason: 'Pending old work' })
  const records = business.list(), history = old.db.prepare('SELECT * FROM changes ORDER BY id').all()
  const pending = old.db.prepare("SELECT COUNT(*) AS n FROM outbox WHERE state='pending'").get().n
  const deletions = old.deletionRows()
  await sync.settle(); old.db.close(); active = undefined
  const upgraded = new LocalStore(local); active = upgraded
  const nextBusiness = new Business(upgraded), nextSync = new BusinessSync(nextBusiness, new TeamDirectory())
  assert.deepEqual(nextBusiness.list(), records)
  assert.deepEqual(upgraded.db.prepare('SELECT * FROM changes ORDER BY id').all(), history)
  assert.equal(nextSync.status().pending, pending)
  assert.deepEqual(await nextBusiness.readBlob(checksum), bytes)
  assert.deepEqual(await nextBusiness.readBlob(String(nextBusiness.get(report.id).data.checksum)), reportBytes)
  assert.deepEqual(upgraded.deletionRows(), deletions)
  assert.throws(() => nextBusiness.get(removed.id), { code: 'VEHICLE_DELETED' })
  assert.equal(nextBusiness.get(archived.id).archived, true)
  assert.equal(nextBusiness.get(equipment.id).data.equipmentType, 'ETAS tools')
  const nextModifications = new Modifications(nextBusiness, nextSync), nextRevisions = new ConfigurationRevisions(nextBusiness, nextSync)
  assert.equal(nextModifications.detail(modification.id).mode, 'linked')
  assert.deepEqual(await nextBusiness.readBlob(String(nextBusiness.get(report.id).data.checksum)), reportBytes)
  assert.deepEqual(upgraded.deletionRows(), deletions)
  assert.equal(nextModifications.detail(modification.id).linkedVehicles.length, 2)
  assert.equal(nextModifications.detail(independent.id).mode, 'independent')
  assert.equal(nextRevisions.detail(vehicle.id, published.revisionId).data.summary, 'Existing configuration')
  assert.equal(nextBusiness.get(customType.id).data.name, 'Existing custom type')
  assert.deepEqual(await fs.readFile(path.join(shared, 'business', 'HEAD.json')), head, 'opening must not publish or migrate shared data')
  assert.equal((await nextSync.synchronize(shared, team.id, identity)).phase, 'ready')
  assert.equal(nextSync.status().pending, 0)
  assert.equal(nextBusiness.get(vehicle.id).data.owner, 'Unsynchronized owner')
  const fullSyncAfter = await profile(() => nextSync.synchronize(shared, team.id, identity))
  assert.deepEqual((await previewBackup(nextBusiness, backup, team.id)).conflicts, [])
  await restoreBackup(nextBusiness, backup, team.id, actor, 'Verify old backup restoration')
  assert.equal((await nextSync.synchronize(shared, team.id, identity)).phase, 'ready')
  assert.equal(nextBusiness.get(vehicle.id).data.owner, '')
  assert.equal(nextModifications.detail(modification.id).mode, 'linked')
  const roundTrip = await createBackup(nextBusiness, team.id)
  assert.deepEqual((await previewBackup(nextBusiness, roundTrip, team.id)).conflicts, [])
  const after = await whileLocked(new TeamDirectory(), shared, team.id, identity, () => nextSync.synchronize(shared, team.id, identity, { ifChanged: true }))
  assert.equal(after.phase, 'ready')
  await nextSync.settle(); upgraded.db.close(); active = undefined
  const reopened = new OldStore(local); active = reopened
  const oldBusiness = new OldBusiness(reopened), oldSync = new OldSync(oldBusiness, new OldTeams())
  assert.equal((await oldSync.synchronize(shared, team.id, identity)).phase, 'ready')
  assert.equal(oldBusiness.get(vehicle.id).data.owner, '')
  assert.deepEqual(await oldBusiness.readBlob(checksum), bytes)
  await oldSync.settle(); reopened.db.close(); active = undefined
  console.log(JSON.stringify({ baseline, version: '1.9.1', records: records.length, history: history.length, pendingPreserved: pending, originalBytesPreserved: true, sharedHeadUnchangedOnOpen: true, legacyReopen: true, configurationAndLinkedModifications: true, oldBackupRestored: true, unchangedWhileLocked: { before, after }, fullSync: { before: fullSyncBefore, after: fullSyncAfter }, environment: 'Synthetic local directory; before pending edit versus after publication; not physical SMB acceptance' }))
} finally {
  active?.db.close()
  assert.equal(path.dirname(root), path.join(project, 'test'))
  await fs.rm(root, { recursive: true, force: true })
}
