import { test } from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { Business } from '../server/business.js'
import { LocalStore } from '../server/store.js'
import { BusinessSync } from '../server/sync.js'
import { AppError, TeamDirectory } from '../server/team.js'
import { ConfigurationRevisions } from '../server/configuration-revisions.js'
import type { ConfigurationContext } from '../server/configuration-revisions.js'
import { configurationDecisionKey, configurationRevisionSummaries, configurationSections, configurationSnapshot, configurationSourceFingerprint, validateConfigurationRecords } from '../shared/configuration-revisions.js'
import type { ConfigurationDecisions, ConfigurationPreview, ConfigurationPublishRequest, ConfigurationRevisionRecord } from '../shared/configuration-revisions.js'
import type { Actor, BusinessRecord } from '../shared/business.js'

async function fixture() {
  const directory = await fs.mkdtemp(path.join(tmpdir(), 'vm-config-revisions-')), shared = path.join(directory, 'shared')
  await fs.mkdir(shared)
  const clients = ['admin', 'member'].map(name => {
    const store = new LocalStore(path.join(directory, name)), business = new Business(store), teams = new TeamDirectory(), sync = new BusinessSync(business, teams)
    return { store, business, teams, sync, revisions: new ConfigurationRevisions(business, sync), identity: { deviceId: store.deviceId, deviceName: name, localUserId: name, displayName: name }, actor: null as Actor | null, context: null as ConfigurationContext | null }
  })
  const [admin, member] = clients, team = await admin.teams.create(shared, 'Configuration test', admin.identity)
  const request = await member.teams.join(shared, team.id, member.identity)
  const approved = await admin.teams.approve(shared, team.id, admin.identity, request.requests[0].id, 'member', null, 'Approve configuration tester')
  for (const client of clients) {
    const matched = approved.members.find(row => row.id === approved.bindings.find(binding => binding.deviceId === client.identity.deviceId)!.memberId)!
    client.actor = { id: matched.id, name: matched.name, deviceId: client.store.deviceId, role: matched.role }
    client.context = { directory: shared, teamId: team.id, identity: client.identity, actor: client.actor, syncEnabled: true, scopeKey: client.identity.localUserId }
  }
  const synchronize = async (index = 0) => { const result = await clients[index].sync.synchronize(shared, team.id, clients[index].identity); assert.equal(result.phase, 'ready', result.error || 'sync failed'); return result }
  const enable = async () => { await admin.revisions.enable(admin.context!, { requestId: randomUUID() }); await synchronize(1) }
  const seed = async (complete = true) => {
    const car = admin.business.write({ kind: 'vehicle', data: { name: 'Fictional car', vin: 'TEST0000000000001', status: 'available', complianceLevel: 'CN6', thermal: complete ? 'No Heat Pump' : '' }, actor: admin.actor!, reason: 'Register test car' })
    if (complete) {
      for (const data of [
        { name: 'HV Battery', category: 'battery', productPart: 'BAT-PN', serial: '00123', maturity: 'POC', lifeStatus: 'BOL' },
        { name: 'eMotor', category: 'motor', position: 'Front', productPart: 'MOTOR-PN', serial: 'M001', maturity: 'Production' },
        { name: 'EVCU', category: 'controller', controllerType: 'Open ECU', functionalPart: 'FUN-PN', productPart: 'ECU-PN', serial: 'C001', software: 'SW-1', calibrationPart: 'CAL-PN', calibrationVersion: 'CAL-1' },
        { name: 'Compressor', category: 'component', componentTypeId: 'thermal-management', productPart: 'TH-PN', notes: 'Demo only' },
      ]) admin.business.write({ kind: 'part', vehicleId: car.id, data, actor: admin.actor!, reason: 'Install test component' })
    }
    await synchronize(); await synchronize(1)
    return admin.business.get(car.id)
  }
  const head = async () => JSON.parse(await fs.readFile(path.join(shared, 'business', 'HEAD.json'), 'utf8')) as { protocol: number; revision: string; sequence: number }
  const close = async () => { for (const client of clients) { await client.sync.settle(); client.store.db.close() }; await fs.rm(directory, { recursive: true, force: true }) }
  return { directory, shared, team, clients, admin, member, enable, seed, head, synchronize, close }
}
function decisions(preview: ConfigurationPreview): ConfigurationDecisions {
  const result: ConfigurationDecisions = { fields: {}, sections: {} }
  for (const section of preview.sections) {
    if (!section.components.length) result.sections[section.typeId] = { state: 'unknown', reason: 'Prototype details not recorded' }
    for (const component of section.components) for (const item of component.fields) if (item.required && !item.value.trim()) result.fields[configurationDecisionKey(component.id, item.id)] = { state: 'unknown', reason: 'Awaiting supplier identification' }
  }
  return result
}
const publication = (preview: ConfigurationPreview): ConfigurationPublishRequest => ({ previewToken: preview.token, requestId: randomUUID(), title: 'Prototype retrofit', summary: 'Reviewed fictional configuration', decisions: decisions(preview) })

test('administrator activation is explicit, idempotent and preserves roster policy; members cannot manage the catalog', async () => {
  const f = await fixture()
  try {
    assert.equal(f.admin.revisions.catalog().enabled, false)
    await assert.rejects(f.member.revisions.enable(f.member.context!), { code: 'ADMIN_REQUIRED' })
    await f.enable(); const before = await f.head()
    assert.equal(before.protocol, 3); assert.equal(f.member.revisions.catalog().enabled, true)
    await f.admin.revisions.enable(f.admin.context!)
    assert.deepEqual(await f.head(), before)
    assert.equal((await f.admin.teams.read(f.shared, f.team.id)).protocol, 1)
    await assert.rejects(f.member.revisions.createType(f.member.context!, { name: 'Charger' }), { code: 'ADMIN_REQUIRED' })
    const type = await f.admin.revisions.createType(f.admin.context!, { name: 'Charger', requestId: randomUUID() })
    assert.equal(type.name, 'Charger'); assert.equal(type.builtin, false)
    await assert.rejects(f.admin.revisions.createType(f.admin.context!, { name: 'charger' }), { code: 'COMPONENT_TYPE_EXISTS' })
    const renamed = await f.admin.revisions.updateType(f.admin.context!, type.id, { name: 'OBC', version: type.version, disabled: true })
    assert.equal(renamed.id, type.id); assert.equal(renamed.disabled, true)
    await assert.rejects(f.admin.revisions.updateType(f.admin.context!, type.id, { name: 'Outdated', version: type.version, disabled: false }), { code: 'VERSION_CONFLICT' })
  } finally { await f.close() }
})

test('revision publication snapshots all installed components, allocates R numbers and leaves ordinary vehicle counters separate', async () => {
  const f = await fixture()
  try {
    await f.enable(); const car = await f.seed(), version = car.version
    const preview = await f.member.revisions.preview(f.member.context!, car.id)
    assert.equal(preview.previousNumber, 0); assert.equal(preview.sections.length, 4)
    const result = await f.member.revisions.publish(f.member.context!, car.id, publication(preview))
    assert.equal(result.label, 'R01'); assert.equal(result.number, 1); assert.equal(result.localSynced, true)
    assert.equal(f.member.business.get(car.id).version, version)
    const record = f.member.revisions.detail(car.id, result.revisionId)
    assert.equal(record.data.actor.id, f.member.actor!.id)
    assert.equal(record.data.snapshot.sections.find(section => section.typeId === 'controllers')!.components[0].fields.find(item => item.id === 'name')!.value, 'VCU')
    assert.equal(record.data.snapshot.sections.find(section => section.typeId === 'hv-battery')!.components[0].fields.find(item => item.id === 'serial')!.value, '00123')
    assert.equal(f.member.revisions.workingView().records.some(row => row.kind === 'configurationRevision' || row.kind === 'componentType'), false)
    assert.equal(f.member.revisions.workingView().revisionSummaries[0].hasChanges, false)
    assert.equal(f.member.revisions.history(car.id)[0].revisionId, result.revisionId)
  } finally { await f.close() }
})

test('missing information requires explicit explanations and review cancellation produces no records or outbox changes', async () => {
  const f = await fixture()
  try {
    await f.enable(); const car = await f.seed(false), pending = f.member.sync.status().pending, before = await f.head()
    const preview = await f.member.revisions.preview(f.member.context!, car.id)
    assert.equal(preview.sections.every(section => section.components.length === 0), true)
    assert.equal(f.member.revisions.history(car.id).length, 0); assert.equal(f.member.sync.status().pending, pending); assert.deepEqual(await f.head(), before)
    await assert.rejects(f.member.revisions.publish(f.member.context!, car.id, { ...publication(preview), decisions: { fields: {}, sections: {} } }), { code: 'REVISION_INFORMATION_REQUIRED' })
    assert.deepEqual(await f.head(), before)
    const result = await f.member.revisions.publish(f.member.context!, car.id, publication(preview))
    const record = f.member.revisions.detail(car.id, result.revisionId)
    assert(record.data.snapshot.sections.every(section => section.state === 'unknown' && Boolean(section.reason)))
    assert.equal(f.member.revisions.workingView().revisionSummaries[0].hasChanges, false)
  } finally { await f.close() }
})

test('working fingerprints ignore administrative saves and DOVE provenance, while component changes create an unpublished difference', async () => {
  const f = await fixture()
  try {
    await f.enable(); const car = await f.seed(), preview = await f.admin.revisions.preview(f.admin.context!, car.id)
    await f.admin.revisions.publish(f.admin.context!, car.id, publication(preview))
    const current = f.admin.business.get(car.id)
    f.admin.business.write({ id: car.id, kind: 'vehicle', data: { ...current.data, owner: 'New owner', physicalLocation: 'Another garage' }, version: current.version, actor: f.admin.actor!, reason: 'Administrative update' })
    let controller = f.admin.business.list('part', car.id).find(row => row.data.category === 'controller')!
    f.admin.business.write({ id: controller.id, kind: 'part', vehicleId: car.id, data: { ...controller.data, reportId: 'new-source-report', reportRecordedAt: '2026-10-29' }, version: controller.version, actor: f.admin.actor!, reason: 'Refresh DOVE provenance' })
    await f.synchronize()
    assert.equal(f.admin.revisions.workingView().revisionSummaries[0].hasChanges, false)
    controller = f.admin.business.get(controller.id)
    f.admin.business.write({ id: controller.id, kind: 'part', vehicleId: car.id, data: { ...controller.data, software: 'SW-2' }, version: controller.version, actor: f.admin.actor!, reason: 'Retrofit controller' })
    await f.synchronize()
    assert.equal(f.admin.revisions.workingView().revisionSummaries[0].label, 'R01')
    assert.equal(f.admin.revisions.workingView().revisionSummaries[0].hasChanges, true)
    const next = await f.admin.revisions.preview(f.admin.context!, car.id), receipt = await f.admin.revisions.publish(f.admin.context!, car.id, publication(next))
    assert.equal(receipt.label, 'R02'); assert.equal(f.admin.revisions.workingView().revisionSummaries[0].hasChanges, false)
    const first = f.admin.revisions.history(car.id)[1]
    assert.equal(f.admin.revisions.detail(car.id, first.revisionId).data.snapshot.sections.find(section => section.typeId === 'controllers')!.components[0].fields.find(item => item.id === 'software')!.value, 'SW-1')
  } finally { await f.close() }
})

test('stale source/base previews, different workspace scopes, paused sessions and revoked members cannot publish', async () => {
  const f = await fixture()
  try {
    await f.enable(); const car = await f.seed(), preview = await f.member.revisions.preview(f.member.context!, car.id)
    await assert.rejects(f.member.revisions.publish({ ...f.member.context!, scopeKey: 'another-selection' }, car.id, publication(preview)), { code: 'REVISION_PREVIEW_CHANGED' })
    await assert.rejects(f.member.revisions.publish({ ...f.member.context!, syncEnabled: false }, car.id, publication(preview)), { code: 'CONFIRM_RESUME' })
    const battery = f.admin.business.list('part', car.id).find(row => row.data.category === 'battery')!
    f.admin.business.write({ id: battery.id, kind: 'part', vehicleId: car.id, data: { ...battery.data, serial: 'Replacement serial' }, version: battery.version, actor: f.admin.actor!, reason: 'Replace battery' })
    await f.synchronize()
    await assert.rejects(f.member.revisions.publish(f.member.context!, car.id, publication(preview)), { code: 'REVISION_PREVIEW_CHANGED' })
    const renewed = await f.member.revisions.preview(f.member.context!, car.id)
    await f.admin.teams.changeMember(f.shared, f.team.id, f.admin.identity, f.member.actor!.id, 'member', false, 'Disable publisher')
    await assert.rejects(f.member.revisions.publish(f.member.context!, car.id, publication(renewed)), { code: 'ACCESS_DISABLED' })
  } finally { await f.close() }
})

test('same-request retries survive service restart and later vehicle deletion without allocating another revision', async () => {
  const f = await fixture()
  try {
    await f.enable(); const car = await f.seed(), preview = await f.admin.revisions.preview(f.admin.context!, car.id), request = publication(preview)
    const first = await f.admin.revisions.publish(f.admin.context!, car.id, request), publishedHead = await f.head()
    const restarted = new ConfigurationRevisions(f.admin.business, f.admin.sync)
    const retry = await restarted.publish(f.admin.context!, car.id, request)
    assert.equal(retry.revisionId, first.revisionId); assert.deepEqual(await f.head(), publishedHead)
    await assert.rejects(restarted.publish(f.admin.context!, car.id, { ...request, summary: 'Different command' }), { code: 'REVISION_REQUEST_MISMATCH' })
    const current = f.admin.business.get(car.id)
    f.admin.business.write({ id: car.id, kind: 'vehicle', data: current.data, version: current.version, archived: true, actor: f.admin.actor!, reason: 'Archive deleted vehicle' })
    await f.synchronize()
    const deletion = await f.admin.sync.deletePreview(f.shared, f.team.id, f.admin.identity, f.admin.actor!, car.id)
    assert.equal(deletion.counts.configurationRevision, 1)
    await f.admin.sync.deleteVehicle(f.shared, f.team.id, f.admin.identity, f.admin.actor!, car.id, { previewToken: deletion.token, version: deletion.version, vin: deletion.vin, confirmation: 'DELETE', reason: 'Remove test identity', requestId: randomUUID() })
    assert.equal((await f.head()).protocol, 3)
    const afterDeletion = await f.head(), recovered = await restarted.publish(f.admin.context!, car.id, request)
    assert.equal(recovered.revisionId, first.revisionId); assert.deepEqual(await f.head(), afterDeletion)
    assert.equal(f.admin.business.list().some(row => row.kind === 'configurationRevision'), false)
    const replacement = f.admin.business.write({ kind: 'vehicle', data: { vin: car.data.vin, status: 'available' }, actor: f.admin.actor!, reason: 'Register reused VIN' })
    await f.synchronize()
    const nextPreview = await f.admin.revisions.preview(f.admin.context!, replacement.id)
    assert.equal(nextPreview.previousNumber, 0)
  } finally { await f.close() }
})

test('two publishers reviewing the same base cannot allocate duplicate or silently skipped ordinals', async () => {
  const f = await fixture()
  try {
    await f.enable(); const car = await f.seed(), first = await f.admin.revisions.preview(f.admin.context!, car.id), second = await f.member.revisions.preview(f.member.context!, car.id)
    const result = await f.admin.revisions.publish(f.admin.context!, car.id, publication(first))
    assert.equal(result.number, 1)
    await assert.rejects(f.member.revisions.publish(f.member.context!, car.id, publication(second)), { code: 'REVISION_PREVIEW_CHANGED' })
    assert.equal(f.admin.revisions.history(car.id).length, 1)
    const next = await f.member.revisions.preview(f.member.context!, car.id)
    assert.equal(next.previousNumber, 1)
  } finally { await f.close() }
})

test('custom catalog labels are frozen in history and disabling preserves existing and queued component identities', async () => {
  const f = await fixture()
  try {
    await f.enable(); const car = await f.seed(), type = await f.admin.revisions.createType(f.admin.context!, { name: 'Charger' })
    await f.synchronize(1)
    const charger = f.member.business.write({ kind: 'part', vehicleId: car.id, data: { name: 'OBC', category: 'component', componentTypeId: type.id, productPart: 'OBC-PN', serial: 'OBC-001', maturity: 'POC' }, actor: f.member.actor!, reason: 'Install charger' })
    await f.synchronize(1)
    const preview = await f.member.revisions.preview(f.member.context!, car.id), receipt = await f.member.revisions.publish(f.member.context!, car.id, publication(preview))
    const queued = f.member.business.write({ kind: 'part', vehicleId: car.id, data: { name: 'Second OBC', category: 'component', componentTypeId: type.id, productPart: 'OBC-PN2', serial: 'OBC-002', maturity: 'POC' }, actor: f.member.actor!, reason: 'Offline entry before type retirement' })
    await f.admin.revisions.updateType(f.admin.context!, type.id, { version: type.version, name: 'On-board Charger', disabled: true })
    await f.synchronize(1)
    assert.equal(f.member.business.get(queued.id).data.componentTypeId, type.id)
    assert.equal(f.member.business.get(charger.id).data.componentTypeId, type.id)
    assert.equal(f.member.revisions.detail(car.id, receipt.revisionId).data.snapshot.sections.find(section => section.typeId === type.id)!.name, 'Charger')
    assert.equal(f.member.revisions.catalog().types.find(item => item.id === type.id)!.disabled, true)
    assert.throws(() => f.member.business.write({ kind: 'part', vehicleId: car.id, data: { name: 'New OBC', category: 'component', componentTypeId: type.id }, actor: f.member.actor!, reason: 'Attempt disabled type' }), { code: 'COMPONENT_TYPE_DISABLED' })
  } finally { await f.close() }
})

test('durable restore imports commit catalogs, working components and protected history in one shared revision', async t => {
  const f = await fixture()
  try {
    await f.enable(); const car = await f.seed(), before = await f.head(), updated = new Date().toISOString()
    const type: BusinessRecord = { id: randomUUID(), kind: 'componentType', vehicleId: null, archived: false, version: 1, updated, data: { schema: 1, name: 'Restored Charger', description: '', disabled: false, definitionVersion: 1 } }
    const entry = { id: randomUUID(), records: [type], actor: f.admin.actor!, reason: 'Restore protected test metadata', receipts: [] }
    f.admin.store.set('pendingConfigurationImports', [entry])
    f.admin.business.write({ kind: 'part', vehicleId: car.id, data: { name: 'Restored OBC', category: 'component', componentTypeId: type.id, productPart: 'REST-PN', serial: 'REST-SN', maturity: 'POC' }, actor: f.admin.actor!, reason: 'Restore working charger', maintenance: 'restore' })
    const sections = configurationSections([...f.admin.business.list(), type], car.id), snapshot = configurationSnapshot(sections, { fields: {}, sections: {} })
    const revision: ConfigurationRevisionRecord = { id: randomUUID(), kind: 'configurationRevision', vehicleId: car.id, archived: false, version: 1, updated, data: { schema: 1, name: 'R01', vehicleId: car.id, vin: String(car.data.vin), number: 1, label: 'R01', title: 'Historical baseline', summary: 'Restore test baseline', publishedAt: updated, actor: f.admin.actor!, previousRevisionId: null, sourceFingerprint: configurationSourceFingerprint(sections), snapshot } }
    entry.records.push(revision)
    f.admin.store.set('pendingConfigurationImports', [entry])
    assert.equal(f.admin.revisions.workingView().revisionSummaries.length, 0, 'A queued history row is not a published revision')
    assert.equal(f.admin.revisions.catalog().types.some(item => item.id === type.id), true, 'Pending catalog resolves existing restored working rows')
    const rename = fs.rename
    t.mock.method(fs, 'rename', async (source, target) => { if (String(target).endsWith('HEAD.json')) throw new Error('Simulated interruption'); return rename(source, target) })
    assert.equal((await f.admin.sync.synchronize(f.shared, f.team.id, f.admin.identity)).phase, 'offline')
    t.mock.restoreAll()
    assert.deepEqual(await f.head(), before)
    assert.equal((f.admin.store.get<unknown[]>('pendingConfigurationImports') || []).length, 1)
    assert.equal(f.admin.revisions.workingView().revisionSummaries.length, 0)
    await f.synchronize()
    assert.equal((await f.head()).sequence, before.sequence + 1)
    assert.equal((f.admin.store.get<unknown[]>('pendingConfigurationImports') || []).length, 0)
    assert.equal(f.admin.revisions.workingView().revisionSummaries[0].label, 'R01')
    await f.synchronize(1)
    assert.equal(f.member.revisions.catalog().types.some(item => item.id === type.id), true)
    assert.equal(f.member.revisions.history(car.id).length, 1)
    assert.equal(f.member.business.list('part', car.id).some(row => row.data.componentTypeId === type.id), true)
  } finally { t.mock.restoreAll(); await f.close() }
})

test('final workspace checks run immediately before HEAD rename and maintenance drains the whole publication', async t => {
  const f = await fixture()
  try {
    await f.enable(); const car = await f.seed(), preview = await f.admin.revisions.preview(f.admin.context!, car.id), request = publication(preview), before = await f.head(), rename = fs.rename
    let live = true
    const scoped = { ...f.admin.context!, assertCurrent: () => { if (!live) throw new AppError('WORKSPACE_CHANGED', 409) } }
    t.mock.method(fs, 'rename', async (source, target) => { await rename(source, target); if (String(target).includes(`${path.sep}snapshots${path.sep}`)) live = false })
    await assert.rejects(f.admin.revisions.publish(scoped, car.id, request), { code: 'WORKSPACE_CHANGED' })
    t.mock.restoreAll()
    assert.deepEqual(await f.head(), before)
    let release!: () => void, reached!: () => void
    const waiting = new Promise<void>(resolve => { release = resolve }), admitted = new Promise<void>(resolve => { reached = resolve })
    t.mock.method(fs, 'rename', async (source, target) => { if (String(target).endsWith('HEAD.json')) { reached(); await waiting }; return rename(source, target) })
    const publishing = f.admin.revisions.publish(f.admin.context!, car.id, request)
    await admitted
    let drained = false
    const draining = f.admin.store.settleWork().then(() => { drained = true })
    await new Promise<void>(resolve => setImmediate(resolve))
    assert.equal(drained, false)
    await assert.rejects(f.admin.store.runWrite(() => {}), { code: 'MAINTENANCE_IN_PROGRESS' })
    release(); await publishing; await draining
    assert.equal(drained, true)
  } finally { t.mock.restoreAll(); await f.close() }
})

test('a pending restore catalog-name collision stays readable and can be repaired without discarding queued data', async () => {
  const f = await fixture()
  try {
    await f.enable(); const car = await f.seed(), live = await f.admin.revisions.createType(f.admin.context!, { name: 'Current component' })
    await f.admin.teams.changeMember(f.shared, f.team.id, f.admin.identity, f.member.actor!.id, 'admin', true, 'Allow another catalog administrator')
    await f.synchronize(1)
    const pendingType: BusinessRecord = { id: randomUUID(), kind: 'componentType', vehicleId: null, archived: false, version: 1, updated: new Date().toISOString(), data: { schema: 1, name: 'Restored charger', description: 'Historical catalog identity', disabled: false, definitionVersion: 1 } }
    const entry = { id: randomUUID(), records: [pendingType], actor: f.admin.actor!, reason: 'Restore a charger', receipts: [] }
    f.admin.store.set('pendingConfigurationImports', [entry])
    const part = f.admin.business.write({ kind: 'part', vehicleId: car.id, data: { name: 'Historical charger', category: 'component', componentTypeId: pendingType.id, productPart: 'REST-PN', serial: 'REST-SN', maturity: 'POC' }, actor: f.admin.actor!, reason: 'Restore working charger', maintenance: 'restore' })
    const preserved = JSON.stringify(f.admin.store.get('pendingConfigurationImports'))
    await f.member.revisions.updateType(f.member.context!, live.id, { version: live.version, name: 'Restored charger', disabled: false })
    const before = await f.head(), failed = await f.admin.sync.synchronize(f.shared, f.team.id, f.admin.identity)
    assert.equal(failed.error, 'COMPONENT_TYPE_EXISTS'); assert.deepEqual(await f.head(), before)
    await assert.rejects(f.admin.revisions.updateType(f.admin.context!, live.id, { version: live.version, name: 'Current charger', disabled: false }), { code: 'VERSION_CONFLICT' })
    const view = f.admin.revisions.workingView(), pending = view.catalog.types.find(type => type.id === pendingType.id)!, canonical = view.catalog.types.find(type => type.id === live.id)!
    assert.equal(canonical.name, 'Restored charger')
    assert.equal(pending.name, pendingType.data.name); assert.equal(pending.pendingRestore, true); assert.equal(pending.disabled, true)
    assert(pending.label[0].includes('pending restore')); assert(pending.label[1].includes('待恢复'))
    assert.equal(view.records.find(row => row.id === part.id)!.data.componentTypeId, pendingType.id)
    assert.equal(JSON.stringify(f.admin.store.get('pendingConfigurationImports')), preserved)
    assert.equal(configurationRevisionSummaries(f.admin.revisions.exportRecords()).length, 0)
    await f.admin.revisions.updateType(f.admin.context!, live.id, { version: canonical.version, name: 'Current charger', disabled: false })
    assert.equal((f.admin.store.get<unknown[]>('pendingConfigurationImports') || []).length, 1)
    await f.synchronize()
    assert.equal((f.admin.store.get<unknown[]>('pendingConfigurationImports') || []).length, 0)
    const restored = f.admin.revisions.catalog().types.find(type => type.id === pendingType.id)!
    assert.equal(restored.name, 'Restored charger'); assert.equal(restored.pendingRestore, undefined); assert.equal(restored.disabled, false)
    assert.equal(f.admin.business.get(part.id).data.componentTypeId, pendingType.id)
    assert.equal((await f.head()).sequence, before.sequence + 2)
  } finally { await f.close() }
})

test('canonical catalog updates retain unrelated unresolved working-record conflicts', async () => {
  const f = await fixture()
  try {
    await f.enable(); const car = await f.seed(), left = f.admin.business.list('part', car.id).find(row => row.data.category === 'battery')!, right = f.member.business.get(left.id)
    f.member.business.write({ id: right.id, kind: 'part', vehicleId: car.id, data: { ...right.data, serial: 'Shared serial' }, version: right.version, actor: f.member.actor!, reason: 'Other working edit' })
    await f.synchronize(1)
    f.admin.business.write({ id: left.id, kind: 'part', vehicleId: car.id, data: { ...left.data, serial: 'Local serial' }, version: left.version, actor: f.admin.actor!, reason: 'Competing working edit' })
    assert.equal((await f.admin.sync.synchronize(f.shared, f.team.id, f.admin.identity)).phase, 'conflict')
    const before = f.admin.sync.status().conflicts
    await f.admin.revisions.createType(f.admin.context!, { name: 'Unrelated new type' })
    assert.deepEqual(f.admin.sync.status().conflicts, before)
    assert.equal(f.admin.sync.status().pending, 1)
  } finally { await f.close() }
})

test('failure before HEAD leaves no published revision; lost rename acknowledgement recovers the committed receipt', async t => {
  const f = await fixture()
  try {
    await f.enable(); const car = await f.seed(), preview = await f.admin.revisions.preview(f.admin.context!, car.id), request = publication(preview), prior = await f.head(), rename = fs.rename
    t.mock.method(fs, 'rename', async (source, target) => { if (String(target).endsWith('HEAD.json')) throw new Error('Injected before commit'); return rename(source, target) })
    await assert.rejects(f.admin.revisions.publish(f.admin.context!, car.id, request), { code: 'SHARE_IO_ERROR' })
    t.mock.restoreAll()
    assert.deepEqual(await f.head(), prior); assert.equal(f.admin.revisions.history(car.id).length, 0)
    t.mock.method(fs, 'rename', async (source, target) => { await rename(source, target); if (String(target).endsWith('HEAD.json')) throw new Error('Lost acknowledgement') })
    const committed = await f.admin.revisions.publish(f.admin.context!, car.id, request)
    t.mock.restoreAll()
    assert.equal(committed.number, 1)
    assert.equal((await f.admin.revisions.publish(f.admin.context!, car.id, request)).revisionId, committed.revisionId)
  } finally { t.mock.restoreAll(); await f.close() }
})

test('canonical protection rejects ordinary writes, forged snapshot fields and duplicate or broken revision chains', async () => {
  const f = await fixture()
  try {
    await f.enable(); const car = await f.seed(), preview = await f.admin.revisions.preview(f.admin.context!, car.id), receipt = await f.admin.revisions.publish(f.admin.context!, car.id, publication(preview)), record = f.admin.revisions.detail(car.id, receipt.revisionId)
    assert.throws(() => f.admin.business.write({ id: record.id, kind: 'configurationRevision', vehicleId: car.id, data: record.data, version: record.version, actor: f.admin.actor!, reason: 'Attempt rewrite', internal: true }), { code: 'CONFIGURATION_IMMUTABLE' })
    const copied = structuredClone(record), all = f.admin.business.list()
    copied.id = randomUUID()
    assert.throws(() => validateConfigurationRecords([...all, copied]), { code: 'CONFIGURATION_CORRUPTED' })
    const malformed = structuredClone(record)
    malformed.data.snapshot.sections[0].components[0].fields[0].required = false
    assert.throws(() => validateConfigurationRecords(all.map(row => row.id === record.id ? malformed : row)), { code: 'CONFIGURATION_CORRUPTED' })
    const omitted = structuredClone(record)
    omitted.data.snapshot.sections[0].components[0].fields.pop()
    omitted.data.sourceFingerprint = configurationSourceFingerprint(omitted.data.snapshot.sections)
    assert.throws(() => validateConfigurationRecords(all.map(row => row.id === record.id ? omitted : row)), { code: 'CONFIGURATION_CORRUPTED' })
    const rebound = structuredClone(record), thermal = rebound.data.snapshot.sections.find(section => section.typeId === 'thermal-management')!
    thermal.components[0].sourceId = randomUUID()
    rebound.data.sourceFingerprint = configurationSourceFingerprint(rebound.data.snapshot.sections)
    assert.throws(() => validateConfigurationRecords(all.map(row => row.id === record.id ? rebound : row)), { code: 'CONFIGURATION_CORRUPTED' })
    const broken = structuredClone(record)
    broken.data.previousRevisionId = randomUUID()
    assert.throws(() => validateConfigurationRecords(all.map(row => row.id === record.id ? broken : row)), { code: 'CONFIGURATION_CORRUPTED' })
  } finally { await f.close() }
})

test('pure source snapshots retain every active instance and ignore inactive records without mutating source data', () => {
  const updated = '2026-10-29T00:00:00Z', vehicle: BusinessRecord = { id: 'vehicle', kind: 'vehicle', vehicleId: null, data: { vin: 'TEST0000000000001', thermal: '' }, archived: false, version: 1, updated }
  const part = (id: string, category: string, data = {}): BusinessRecord => ({ id, kind: 'part', vehicleId: vehicle.id, data: { name: id, category, ...data }, archived: false, version: 1, updated })
  const records = [vehicle, part('front', 'motor', { position: 'Front' }), part('rear', 'motor', { position: 'Rear' }), part('battery1', 'battery'), part('battery2', 'battery'), part('archived', 'motor'), part('removed', 'battery', { removedAt: '2026-10-01' }), part('extra-controller', 'controller', { name: 'TCU' })]
  records[5].archived = true
  const copy = structuredClone(records), sections = configurationSections(records, vehicle.id)
  assert.equal(sections.find(section => section.typeId === 'emotor')!.components.length, 2)
  assert.equal(sections.find(section => section.typeId === 'hv-battery')!.components.length, 2)
  assert.equal(sections.find(section => section.typeId === 'controllers')!.components[0].name, 'TCU')
  const preview: ConfigurationPreview = { token: 'unused', expires: 0, vehicleId: vehicle.id, vin: String(vehicle.data.vin), previousRevisionId: null, previousNumber: 0, sections }
  const snapshot = configurationSnapshot(sections, decisions(preview))
  assert.equal(configurationSourceFingerprint(snapshot.sections), configurationSourceFingerprint(sections))
  assert.deepEqual(records, copy)
  assert.equal(configurationRevisionSummaries(records).length, 0)
})
