import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { BusinessRecord } from '../shared/business.js'
import type { ComponentReviewState, ComponentTypeDefinition, ConfigurationDecisions, ConfigurationRevisionData } from '../shared/configuration-revisions.js'
import { builtinComponentTypes, configurationDecisionKey, configurationReviewScope, configurationSections, configurationSnapshot, configurationSourceFingerprint, validateConfigurationRevisionRecord } from '../shared/configuration-revisions.js'
import { componentPolicyActionState, componentPolicyStatus, componentTypeBlocksNewEntries, showWorkingComponentType, visibleComponentTypes } from '../src/component-review-policy.js'
import { compareConfigurationRevisions, configurationRevisionText, excludedConfigurationTypes } from '../src/configuration-revision-view.js'

const vehicleId = '11111111-1111-4111-8111-111111111111', stamp = '2026-11-03T02:00:00.000Z'
const vehicle: BusinessRecord = { id: vehicleId, kind: 'vehicle', vehicleId: null, data: { name: 'Fictional car', vin: 'TEST0000000000001', status: 'available' }, archived: false, version: 1, updated: stamp }
const battery: BusinessRecord = { id: '22222222-2222-4222-8222-222222222222', kind: 'part', vehicleId, data: { name: 'HV Battery', category: 'battery', productPart: 'BAT-001', serial: 'SN-001', maturity: 'POC', lifeStatus: 'BOL' }, archived: false, version: 1, updated: stamp }
function revision(number: number, states?: Partial<Record<string, ComponentReviewState>>, records = [vehicle, battery]): ConfigurationRevisionData {
  const types: ComponentTypeDefinition[] = builtinComponentTypes.map(type => ({ ...structuredClone(type), ...(states ? { reviewState: states[type.id] || 'active' } : {}) }))
  const sections = configurationSections(records, vehicleId, types), decisions: ConfigurationDecisions = { fields: {}, sections: {} }
  for (const section of sections) {
    if (!section.components.length) decisions.sections[section.typeId] = { state: 'notInstalled', reason: 'Not fitted to this fictional vehicle' }
    for (const component of section.components) for (const field of component.fields) if (field.required && !field.value.trim()) decisions.fields[configurationDecisionKey(component.id, field.id)] = { state: 'unknown', reason: 'Fictional supplier information pending' }
  }
  const scope = states ? configurationReviewScope(records, vehicleId, types) : undefined
  const data: ConfigurationRevisionData = { schema: scope ? 2 : 1, name: `R0${number}`, label: `R0${number}`, number, vehicleId, vin: String(vehicle.data.vin), title: 'Trial', summary: 'Fictional scope review', publishedAt: stamp, actor: { id: 'member', name: 'Trial member', role: 'member', deviceId: 'trial-device' }, previousRevisionId: number > 1 ? `revision-${number - 1}` : null, sourceFingerprint: configurationSourceFingerprint(sections), snapshot: configurationSnapshot(sections, decisions, scope) }
  validateConfigurationRevisionRecord({ id: `revision-${number}`, kind: 'configurationRevision', vehicleId, archived: false, version: 1, updated: stamp, data })
  return data
}

test('management filtering and lifecycle actions retain removed identities and distinguish legacy disabled types', () => {
  const active = { ...builtinComponentTypes[0], reviewState: 'active' as const }, disabled = { ...builtinComponentTypes[1], reviewState: 'disabled' as const }, removed = { ...builtinComponentTypes[2], reviewState: 'removed' as const }
  const types = [active, disabled, removed], original = structuredClone(types)
  assert.deepEqual(visibleComponentTypes(types, false).map(type => type.id), [active.id, disabled.id])
  assert.deepEqual(visibleComponentTypes(types, true).map(type => type.id), types.map(type => type.id))
  assert.equal(componentPolicyActionState('disable'), 'disabled'); assert.equal(componentPolicyActionState('remove'), 'removed')
  assert.equal(componentPolicyActionState('enable'), 'active'); assert.equal(componentPolicyActionState('restore'), 'active')
  assert.equal(componentPolicyStatus({ ...active, reviewState: undefined, disabled: true }), 'disabled')
  assert.deepEqual(types, original)
})

test('configuration policy never hides working sections or blocks new records, while pending imports remain protected', () => {
  for (const reviewState of ['active', 'disabled', 'removed'] as const) {
    const type = { ...builtinComponentTypes[0], builtin: false, reviewState, disabled: reviewState !== 'active' }
    assert.equal(showWorkingComponentType(type, true, false), true)
    assert.equal(componentTypeBlocksNewEntries(type, true), false)
    assert.equal(componentTypeBlocksNewEntries({ ...type, pendingRestore: true }, true), true)
  }
  const legacyDisabled = { ...builtinComponentTypes[0], disabled: true }
  assert.equal(showWorkingComponentType(legacyDisabled, false, false), false)
  assert.equal(showWorkingComponentType(legacyDisabled, false, true), true)
  assert.equal(componentTypeBlocksNewEntries(legacyDisabled, false), true)
})

test('frozen summaries and comparisons label scope exclusion rather than physical component removal in both languages', () => {
  const before = revision(1), after = revision(2, { 'hv-battery': 'removed' }), original = structuredClone(before)
  assert.equal(excludedConfigurationTypes(after.snapshot.reviewScope)[0].typeId, 'hv-battery')
  const en = configurationRevisionText(after, 'en'), zh = configurationRevisionText(after, 'zh')
  assert(en.includes('HV Battery: Excluded from configuration review')); assert(zh.includes('高压电池: 不纳入配置核对'))
  assert(!en.includes('BAT-001')); assert(configurationRevisionText(before, 'en').includes('BAT-001'))
  const differences = compareConfigurationRevisions(before, after, 'en')
  assert.equal(differences.length, 1)
  assert.equal(differences[0].key, 'hv-battery:review-scope'); assert.equal(differences[0].status, 'changed')
  assert.equal(differences[0].before, 'Included in configuration review'); assert.equal(differences[0].after, 'Excluded from configuration review')
  assert(compareConfigurationRevisions(after, before, 'zh')[0].after.includes('纳入配置核对'))
  assert.deepEqual(compareConfigurationRevisions(after, revision(3, { 'hv-battery': 'disabled' }), 'en'), [])
  assert.deepEqual(before, original)
})

test('actual removal of components in an included category still compares component details', () => {
  const before = revision(1, {}), after = revision(2, {}, [vehicle])
  const differences = compareConfigurationRevisions(before, after, 'en')
  assert(differences.some(row => row.before.includes('BAT-001') && row.status === 'removed'))
  assert(differences.some(row => row.after.includes('Not installed')))
  assert(differences.every(row => !row.key.endsWith(':review-scope')))
})
