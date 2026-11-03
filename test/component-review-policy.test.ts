import { test } from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { Business } from '../server/business.js'
import { LocalStore } from '../server/store.js'
import { BusinessSync } from '../server/sync.js'
import { TeamDirectory } from '../server/team.js'
import { ConfigurationRevisions } from '../server/configuration-revisions.js'
import type { ConfigurationContext } from '../server/configuration-revisions.js'
import { builtinComponentTypes, componentTypeDefinitions, configurationDecisionKey, configurationSnapshot, validateComponentTypeRecord, validateConfigurationRevisionRecord } from '../shared/configuration-revisions.js'
import type { ComponentReviewState, ConfigurationDecisions, ConfigurationPreview, ConfigurationPublishRequest } from '../shared/configuration-revisions.js'
import type { Actor } from '../shared/business.js'

async function fixture() {
  const directory = await fs.mkdtemp(path.join(tmpdir(), 'vm-component-policy-')), shared = path.join(directory, 'shared')
  await fs.mkdir(shared)
  const clients = ['admin', 'member'].map(name => {
    const store = new LocalStore(path.join(directory, name)), business = new Business(store), teams = new TeamDirectory(), sync = new BusinessSync(business, teams)
    return { store, business, teams, sync, revisions: new ConfigurationRevisions(business, sync), identity: { deviceId: store.deviceId, deviceName: name, localUserId: name, displayName: name }, actor: null as Actor | null, context: null as ConfigurationContext | null }
  })
  const [admin, member] = clients, team = await admin.teams.create(shared, 'Fictional component policy', admin.identity)
  const joining = await member.teams.join(shared, team.id, member.identity)
  const approved = await admin.teams.approve(shared, team.id, admin.identity, joining.requests[0].id, 'member', null, 'Approve fictional member')
  for (const client of clients) {
    const matched = approved.members.find(row => row.id === approved.bindings.find(binding => binding.deviceId === client.identity.deviceId)!.memberId)!
    client.actor = { id: matched.id, name: matched.name, deviceId: client.store.deviceId, role: matched.role }
    client.context = { directory: shared, teamId: team.id, identity: client.identity, actor: client.actor, syncEnabled: true, scopeKey: client.identity.localUserId }
  }
  const synchronize = async (index = 0) => { const result = await clients[index].sync.synchronize(shared, team.id, clients[index].identity); assert.equal(result.phase, 'ready', result.error); return result }
  await admin.revisions.enable(admin.context!, { requestId: randomUUID() })
  const car = admin.business.write({ kind: 'vehicle', data: { name: 'Fictional retrofit', vin: 'TEST0000000000001', status: 'available', complianceLevel: 'CN6', thermal: 'No Heat Pump' }, actor: admin.actor!, reason: 'Register temporary vehicle' })
  const battery = admin.business.write({ kind: 'part', vehicleId: car.id, data: { name: 'HV Battery', category: 'battery', productPart: 'BAT-001', serial: '00123', maturity: 'POC', lifeStatus: 'BOL' }, actor: admin.actor!, reason: 'Install fictional battery' })
  await synchronize(); await synchronize(1)
  const head = async () => JSON.parse(await fs.readFile(path.join(shared, 'business', 'HEAD.json'), 'utf8')) as { protocol: number; revision: string; sequence: number }
  const change = async (id: string, reviewState: ComponentReviewState) => {
    const type = admin.revisions.catalog().types.find(type => type.id === id)!
    return admin.revisions.updateType(admin.context!, id, { version: type.version, name: type.name, description: type.description, reviewState, requestId: randomUUID(), reason: `Set configuration review to ${reviewState}` })
  }
  const close = async () => { for (const client of clients) { await client.sync.settle(); client.store.db.close() }; await fs.rm(directory, { recursive: true, force: true }) }
  return { directory, shared, team, admin, member, car, battery, synchronize, head, change, close }
}
function request(preview: ConfigurationPreview): ConfigurationPublishRequest {
  const decisions: ConfigurationDecisions = { fields: {}, sections: {} }
  for (const section of preview.sections) {
    if (!section.components.length) decisions.sections[section.typeId] = { state: 'notInstalled', reason: 'Not installed on this temporary vehicle' }
    for (const component of section.components) for (const field of component.fields) if (field.required && !field.value.trim()) decisions.fields[configurationDecisionKey(component.id, field.id)] = { state: 'unknown', reason: 'Fictional supplier detail pending' }
  }
  return { previewToken: preview.token, requestId: randomUUID(), title: 'Trial retrofit', summary: 'Review fictional components', decisions }
}

test('built-in policy changes upgrade once, retain working records and immutable history, and ignore excluded component edits', async () => {
  const f = await fixture()
  try {
    assert.equal((await f.head()).protocol, 3)
    assert.equal(f.admin.revisions.catalog().policyEnabled, false)
    const initial = await f.member.revisions.preview(f.member.context!, f.car.id)
    const r1 = await f.member.revisions.publish(f.member.context!, f.car.id, request(initial)), frozen = JSON.stringify(f.member.revisions.detail(f.car.id, r1.revisionId))
    assert.equal(f.member.revisions.detail(f.car.id, r1.revisionId).data.schema, 1)
    const type = f.admin.revisions.catalog().types.find(type => type.id === 'hv-battery')!
    const update = { version: type.version, name: type.name, description: type.description, reviewState: 'disabled' as const, requestId: randomUUID(), reason: 'Exclude battery from future configuration reviews' }
    const disabled = await f.admin.revisions.updateType(f.admin.context!, type.id, update), head = await f.head()
    assert.equal(head.protocol, 4); assert.equal(disabled.builtin, true); assert.equal(disabled.reviewState, 'disabled')
    assert.equal(f.admin.revisions.catalog().policyEnabled, true)
    assert.deepEqual(await f.admin.revisions.updateType(f.admin.context!, type.id, update), disabled)
    assert.deepEqual(await f.head(), head)
    assert.equal(f.admin.revisions.workingView().revisionSummaries[0].hasChanges, true)
    await f.synchronize(1)
    assert.equal(JSON.stringify(f.member.revisions.detail(f.car.id, r1.revisionId)), frozen)
    assert.equal(f.member.business.get(f.battery.id).id, f.battery.id)
    const preview = await f.member.revisions.preview(f.member.context!, f.car.id)
    assert(!preview.sections.some(section => section.typeId === 'hv-battery'))
    assert.equal(preview.reviewScope?.find(scope => scope.typeId === 'hv-battery')?.included, false)
    const r2 = await f.member.revisions.publish(f.member.context!, f.car.id, request(preview)), record = f.member.revisions.detail(f.car.id, r2.revisionId)
    assert.equal(record.data.schema, 2); assert.equal(record.data.snapshot.schema, 2)
    assert.equal(f.member.revisions.workingView().revisionSummaries[0].hasChanges, false)
    const battery = f.member.business.get(f.battery.id)
    f.member.business.write({ id: battery.id, kind: 'part', vehicleId: f.car.id, version: battery.version, data: { ...battery.data, serial: 'NEW-SERIAL' }, actor: f.member.actor!, reason: 'Edit excluded battery' })
    f.member.business.write({ kind: 'part', vehicleId: f.car.id, data: { ...battery.data, serial: 'SECOND-BATTERY' }, actor: f.member.actor!, reason: 'Add excluded second battery' })
    assert.equal(f.member.revisions.workingView().revisionSummaries[0].hasChanges, false)
    await f.synchronize(1); await f.synchronize()
    await f.change('hv-battery', 'active')
    assert.equal(f.admin.revisions.workingView().revisionSummaries[0].hasChanges, true)
    const restored = await f.admin.revisions.preview(f.admin.context!, f.car.id)
    assert.equal(restored.sections.find(section => section.typeId === 'hv-battery')?.components.length, 2)
    assert.equal(JSON.stringify(f.admin.revisions.detail(f.car.id, r1.revisionId)), frozen)
    assert.equal(f.admin.revisions.history(f.car.id).length, 2)
    assert.equal((await f.head()).protocol, 4)
  } finally { await f.close() }
})

test('removal is reversible for every builtin and empty configuration publication is blocked', async () => {
  const f = await fixture()
  try {
    for (const type of builtinComponentTypes) await f.change(type.id, 'removed')
    assert.equal(f.admin.revisions.catalog().types.filter(type => type.reviewState === 'removed').length, 4)
    assert.equal(f.admin.business.get(f.battery.id).data.serial, '00123')
    const preview = await f.admin.revisions.preview(f.admin.context!, f.car.id), head = await f.head()
    assert.equal(preview.sections.length, 0); assert.equal(preview.reviewScope?.length, 4)
    assert.throws(() => configurationSnapshot(preview.sections, { fields: {}, sections: {} }, preview.reviewScope), { code: 'CONFIGURATION_EMPTY_REVIEW' })
    await assert.rejects(f.admin.revisions.publish(f.admin.context!, f.car.id, request(preview)), { code: 'CONFIGURATION_EMPTY_REVIEW' })
    assert.deepEqual(await f.head(), head)
    const restored = await f.change('hv-battery', 'active')
    assert.equal(restored.id, 'hv-battery'); assert.equal(restored.reviewState, 'active')
    const selected = await f.admin.revisions.preview(f.admin.context!, f.car.id)
    assert.deepEqual(selected.sections.map(section => section.typeId), ['hv-battery'])
    const r1 = await f.admin.revisions.publish(f.admin.context!, f.car.id, request(selected))
    assert.equal(r1.label, 'R01'); assert.equal(f.admin.revisions.workingView().revisionSummaries[0].hasChanges, false)
  } finally { await f.close() }
})

test('legacy disabled custom types migrate to review-only exclusion and retain identities through removal and rename', async () => {
  const f = await fixture()
  try {
    const type = await f.admin.revisions.createType(f.admin.context!, { name: 'Gearbox' })
    const legacy = await f.admin.revisions.updateType(f.admin.context!, type.id, { version: type.version, name: type.name, disabled: true })
    assert.equal(legacy.disabled, true); assert.equal(legacy.reviewState, undefined)
    const body = { kind: 'part' as const, vehicleId: f.car.id, data: { name: 'Front gearbox', category: 'component', componentTypeId: type.id, productPart: 'GB-001' }, actor: f.admin.actor!, reason: 'Fit gearbox' }
    assert.throws(() => f.admin.business.write(body), { code: 'COMPONENT_TYPE_DISABLED' })
    await f.change('controllers', 'disabled')
    assert.equal(f.admin.revisions.catalog().types.find(item => item.id === type.id)?.reviewState, 'disabled')
    const component = f.admin.business.write(body)
    await f.synchronize()
    assert(!((await f.admin.revisions.preview(f.admin.context!, f.car.id)).sections.some(section => section.typeId === type.id)))
    await f.change(type.id, 'removed')
    assert.equal(f.admin.business.get(component.id).data.componentTypeId, type.id)
    const active = await f.change(type.id, 'active')
    const renamed = await f.admin.revisions.updateType(f.admin.context!, type.id, { version: active.version, name: 'Reduction gear', disabled: true, reason: 'Rename only through legacy API shape' })
    assert.equal(renamed.reviewState, 'active'); assert.equal(renamed.id, type.id)
    assert((await f.admin.revisions.preview(f.admin.context!, f.car.id)).sections.some(section => section.typeId === type.id))
    const record = f.admin.business.list().find(row => row.id === type.id)!
    assert.equal(record.data.schema, 2); assert.equal(record.data.reviewState, 'active')
  } finally { await f.close() }
})

test('policy mutations preserve permission, stale-version, paused-session and fixed builtin identity guards', async () => {
  const f = await fixture()
  try {
    const type = f.admin.revisions.catalog().types.find(type => type.id === 'emotor')!, input = { version: type.version, name: type.name, description: type.description, reviewState: 'disabled' as const, reason: 'Test policy guards', requestId: randomUUID() }, head = await f.head()
    await assert.rejects(f.member.revisions.updateType(f.member.context!, type.id, input), { code: 'ADMIN_REQUIRED' })
    await assert.rejects(f.admin.revisions.updateType({ ...f.admin.context!, syncEnabled: false }, type.id, input), { code: 'CONFIRM_RESUME' })
    await assert.rejects(f.admin.revisions.updateType(f.admin.context!, type.id, { ...input, name: 'Renamed motor' }), { code: 'INVALID_INPUT' })
    await assert.rejects(f.admin.revisions.updateType(f.admin.context!, type.id, { ...input, description: 'Alter built-in definition' }), { code: 'INVALID_INPUT' })
    await assert.rejects(f.admin.revisions.updateType(f.admin.context!, type.id, { ...input, reason: '' }), { code: 'REASON_REQUIRED' })
    await assert.rejects(f.admin.revisions.updateType(f.admin.context!, type.id, { ...input, reviewState: 'invalid' as ComponentReviewState }), { code: 'INVALID_INPUT' })
    assert.deepEqual(await f.head(), head)
    const preview = await f.member.revisions.preview(f.member.context!, f.car.id)
    await f.admin.revisions.updateType(f.admin.context!, type.id, input)
    await assert.rejects(f.member.revisions.publish(f.member.context!, f.car.id, request(preview)), { code: 'REVISION_PREVIEW_CHANGED' })
    await assert.rejects(f.admin.revisions.updateType(f.admin.context!, type.id, { ...input, requestId: randomUUID() }), { code: 'VERSION_CONFLICT' })
    await assert.rejects(f.admin.revisions.updateType(f.admin.context!, type.id, { ...input, reviewState: 'active' }), { code: 'REVISION_REQUEST_MISMATCH' })
  } finally { await f.close() }
})

test('scope validation rejects contradictory metadata while exclusion-state changes leave included fingerprints unchanged', async () => {
  const f = await fixture()
  try {
    await f.change('hv-battery', 'disabled')
    const preview = await f.admin.revisions.preview(f.admin.context!, f.car.id), r1 = await f.admin.revisions.publish(f.admin.context!, f.car.id, request(preview))
    const original = f.admin.revisions.detail(f.car.id, r1.revisionId)
    validateConfigurationRevisionRecord(original)
    for (const mutate of [
      (record: typeof original) => { record.data.snapshot.reviewScope!.pop() },
      (record: typeof original) => { record.data.snapshot.reviewScope![0].included = !record.data.snapshot.reviewScope![0].included },
      (record: typeof original) => { record.data.snapshot.reviewScope![0].name = 'Wrong built-in identity' },
      (record: typeof original) => { record.data.snapshot.sections.pop() },
      (record: typeof original) => { record.data.snapshot.sections = [] },
      (record: typeof original) => { record.data.schema = 1 },
    ]) {
      const altered = structuredClone(original); mutate(altered)
      assert.throws(() => validateConfigurationRevisionRecord(altered), { code: 'CONFIGURATION_CORRUPTED' })
    }
    await f.change('hv-battery', 'removed')
    assert.equal(f.admin.revisions.workingView().revisionSummaries[0].hasChanges, false)
    const definition = f.admin.business.list().find(row => row.kind === 'componentType' && row.id === 'hv-battery')!
    validateComponentTypeRecord(definition)
    assert.throws(() => validateComponentTypeRecord({ ...definition, data: { ...definition.data, schema: 1, disabled: true } }), { code: 'CONFIGURATION_CORRUPTED' })
    assert.equal(componentTypeDefinitions(f.admin.business.list()).find(type => type.id === 'hv-battery')?.reviewState, 'removed')
  } finally { await f.close() }
})

test('lost HEAD acknowledgment recovers the original policy receipt without another shared publication', async t => {
  const f = await fixture()
  try {
    const type = f.admin.revisions.catalog().types.find(type => type.id === 'thermal-management')!, input = { version: type.version, name: type.name, description: type.description, reviewState: 'removed' as const, reason: 'Recover fictional policy publication', requestId: randomUUID() }
    const rename = fs.rename
    t.mock.method(fs, 'rename', async (source, target) => { await rename(source, target); if (String(target).endsWith('HEAD.json')) throw Object.assign(new Error('Simulated lost acknowledgment'), { code: 'EIO' }) })
    const committed = await f.admin.revisions.updateType(f.admin.context!, type.id, input)
    assert.equal(committed.reviewState, 'removed')
    t.mock.restoreAll()
    const head = await f.head()
    assert.equal(head.protocol, 4)
    const reopened = new ConfigurationRevisions(f.admin.business, f.admin.sync)
    const result = await reopened.updateType(f.admin.context!, type.id, input)
    assert.equal(result.reviewState, 'removed'); assert.equal(result.version, 2)
    assert.deepEqual(await f.head(), head)
    assert.equal(reopened.catalog().types.filter(item => item.id === type.id).length, 1)
  } finally { t.mock.restoreAll(); await f.close() }
})
