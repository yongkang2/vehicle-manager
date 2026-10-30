import { test } from 'node:test'
import assert from 'node:assert/strict'
import unzipper from 'unzipper'
import type { BusinessRecord } from '../shared/business.js'
import { configurationSections, configurationSnapshot, configurationSourceFingerprint, configurationDecisionKey, validateConfigurationRevisionRecord } from '../shared/configuration-revisions.js'
import type { ConfigurationDecisions, ConfigurationRevisionRecord } from '../shared/configuration-revisions.js'
import { defaultExportConfiguration, exportKinds, parseExportConfiguration } from '../shared/csv-export.js'
import { buildCsvExport } from '../server/csv-export.js'
import { compareConfigurationRevisions, configurationRevisionText } from '../src/configuration-revision-view.js'
import { createVehicleFilterValues, matchesVehicleColumnFilters } from '../src/vehicle-table-filters.js'

const vehicleId = '11111111-1111-4111-8111-111111111111', batteryId = '22222222-2222-4222-8222-222222222222'
const stamp = '2026-10-29T02:00:00.000Z'
const vehicle: BusinessRecord = { id: vehicleId, kind: 'vehicle', vehicleId: null, data: { name: 'Trial car', vin: 'TEST0000000000001', status: 'available', thermal: 'No Heat Pump' }, archived: false, version: 1, updated: stamp }
const battery = (serial: string): BusinessRecord => ({ id: batteryId, kind: 'part', vehicleId, data: { name: 'HV Battery', category: 'battery', productPart: '000123', serial, maturity: 'POC', lifeStatus: 'BOL' }, archived: false, version: 1, updated: stamp })
function revision(id: string, number: number, records: BusinessRecord[], previousRevisionId: string | null, adjust?: (decisions: ConfigurationDecisions) => void): ConfigurationRevisionRecord {
  const sections = configurationSections(records, vehicleId), decisions: ConfigurationDecisions = { fields: {}, sections: {} }
  for (const section of sections) {
    if (!section.components.length) decisions.sections[section.typeId] = { state: 'notInstalled', reason: 'Not fitted on this fictional vehicle' }
    for (const component of section.components) for (const field of component.fields) if (field.required && !field.value.trim()) decisions.fields[configurationDecisionKey(component.id, field.id)] = { state: 'unknown', reason: 'Supplier information pending' }
  }
  adjust?.(decisions)
  const record: ConfigurationRevisionRecord = { id, kind: 'configurationRevision', vehicleId, archived: false, version: 1, updated: stamp, data: { schema: 1, name: `R${String(number).padStart(2, '0')}`, vehicleId, vin: String(vehicle.data.vin), number, label: `R${String(number).padStart(2, '0')}`, title: 'Trial retrofit', summary: 'Fictional component change', publishedAt: stamp, actor: { id: 'member', name: 'Trial member', role: 'member', deviceId: 'device' }, previousRevisionId, sourceFingerprint: configurationSourceFingerprint(sections), snapshot: configurationSnapshot(sections, decisions) } }
  validateConfigurationRevisionRecord(record)
  return record
}

test('copied revision summaries use frozen values and bilingual field/explanation names', () => {
  const first = revision('revision-one', 1, [vehicle, battery('OLD-SERIAL')], null)
  const en = configurationRevisionText(first.data, 'en'), zh = configurationRevisionText(first.data, 'zh')
  assert(en.includes('TEST0000000000001 · R01'))
  assert(en.includes('000123')); assert(en.includes('OLD-SERIAL')); assert(en.includes('Not installed'))
  assert(zh.includes('高压电池')); assert(zh.includes('未安装')); assert(zh.includes('热管理系统类型')); assert(zh.includes('关键热管理部件'))
  assert(!zh.includes('Key thermal components'))
  const edited = battery('NEW-SERIAL')
  assert.equal(edited.data.serial, 'NEW-SERIAL')
  assert(configurationRevisionText(first.data, 'en').includes('OLD-SERIAL'))
})

test('revision comparisons include actual field and explanation-state changes without rewriting snapshots', () => {
  const first = revision('revision-one', 1, [vehicle, battery('OLD-SERIAL')], null)
  const second = revision('revision-two', 2, [vehicle, battery('NEW-SERIAL')], first.id, decisions => {
    const missing = Object.keys(decisions.fields)[0]
    decisions.fields[missing] = { state: 'notApplicable', reason: 'Not applicable to this prototype' }
  })
  const original = structuredClone(first), differences = compareConfigurationRevisions(first.data, second.data, 'en')
  assert(differences.some(row => row.before.includes('OLD-SERIAL') && row.after.includes('NEW-SERIAL')))
  assert(differences.some(row => row.before.includes('Unknown') && row.after.includes('Not applicable')))
  assert.deepEqual(compareConfigurationRevisions(first.data, first.data, 'zh'), [])
  assert.deepEqual(first, original)
})

test('vehicle header revision filters preserve labels and dirty state across language changes', () => {
  const summary = { vehicleId, revisionId: 'revision-one', number: 1, label: 'R01', publishedAt: stamp, actor: { id: 'm', name: 'M', role: 'member' as const, deviceId: 'd' }, title: '', summary: 'Update', hasChanges: true }
  const en = createVehicleFilterValues([vehicle], 'en', [summary]).get(vehicleId)!, zh = createVehicleFilterValues([vehicle], 'zh', [summary]).get(vehicleId)!
  assert.equal(en.configurationRevision.key, zh.configurationRevision.key)
  assert(en.configurationRevision.label.includes('Unpublished configuration changes'))
  assert(zh.configurationRevision.label.includes('配置有未发布更改'))
  assert(matchesVehicleColumnFilters(zh, { configurationRevision: [en.configurationRevision.key] }))
  assert.equal(createVehicleFilterValues([vehicle], 'en').get(vehicleId)!.configurationRevision.key, '[]')
})

test('CSV adds the current R label without adding protected categories or changing existing selections', async () => {
  const first = revision('revision-one', 1, [vehicle, battery('OLD-SERIAL')], null), second = revision('revision-two', 2, [vehicle, battery('NEW-SERIAL')], first.id)
  const configuration = { ...defaultExportConfiguration('en'), columns: { vehicle: ['vin', 'configurationRevision'] } }
  assert.deepEqual(exportKinds, ['vehicle', 'part', 'modification', 'equipment', 'report', 'attachment'])
  assert(!defaultExportConfiguration('en').columns.vehicle!.includes('configurationRevision'))
  assert.equal(parseExportConfiguration({ ...configuration, columns: { configurationRevision: ['label'] } }), null)
  const spoofedVehicle = { ...vehicle, data: { ...vehicle.data, configurationRevision: 'R99' } }
  const result = await buildCsvExport([spoofedVehicle, battery('NEW-SERIAL'), first, second], { vehicleIds: [vehicleId], configuration })
  const zip = await unzipper.Open.buffer(result.bytes), csv = (await zip.files[0].buffer()).toString('utf8')
  assert(csv.includes('VIN,Configuration revision\r\nTEST0000000000001,R02\r\n'))
  assert.equal(zip.files.length, 1)
})
