import { test } from 'node:test'
import assert from 'node:assert/strict'
import { complianceLevels } from '../shared/business.js'
import type { BusinessRecord, Fields } from '../shared/business.js'
import { vehicleColumnIds } from '../shared/vehicle-table.js'
import { createVehicleFilterValues, findVehicleTableController, matchesVehicleColumnFilters, sortedVehicleReports, vehicleColumnFilterOptions, visibleVehicleColumnFilters } from '../src/vehicle-table-filters.js'
import type { VehicleColumnFilters } from '../src/vehicle-table-filters.js'

const updated = '2026-04-01T12:34:56.000Z'
const vehicle = (id: string, data: Fields = {}, extra: Partial<BusinessRecord> = {}): BusinessRecord => ({
  id, kind: 'vehicle', vehicleId: null, data: { name: id, vin: `VIN-${id}`, status: 'available', ...data }, archived: false, version: 1, updated, ...extra,
})
const child = (id: string, vehicleId: string, kind: BusinessRecord['kind'], data: Fields = {}, extra: Partial<BusinessRecord> = {}): BusinessRecord => ({
  id, kind, vehicleId, data, archived: false, version: 1, updated, ...extra,
})
const key = (...parts: string[]) => JSON.stringify(parts)

test('filter snapshot covers every data column and preserves whole composite cells without mutating records', () => {
  const car = vehicle('a', { name: 'Trial car', plate: '00123', plateExpiry: '2027-03-01', model: 'M1', project: 'Project A', color: 'Blue', owner: 'Alice', physicalLocation: 'Lab', notes: 'Line one\n第二行', thermal: 'Indirect Heat Pump' }, { version: 7 })
  const records = [car, child('equipment', car.id, 'equipment', { name: 'meter' })]
  const before = structuredClone(records)
  const values = createVehicleFilterValues(records, 'en')
  assert.equal(values.size, 1)
  const row = values.get(car.id)!
  assert.deepEqual(Object.keys(row).sort(), vehicleColumnIds.filter(column => column !== 'actions').sort())
  assert.deepEqual(row.vehicle, { key: key('Trial car', 'VIN-a'), label: 'Trial car · VIN-a' })
  assert.deepEqual(row.plate, { key: key('00123', '2027-03-01'), label: '00123 · 2027-03-01' })
  assert.deepEqual(row.updated, { key: key(updated, '7'), label: `${new Date(updated).toLocaleString('en-GB')} · v7` })
  for (const [column, label] of Object.entries({ model: 'M1', project: 'Project A', color: 'Blue', owner: 'Alice', physicalLocation: 'Lab', notes: 'Line one\n第二行' })) {
    assert.equal(row[column as keyof typeof row].label, label)
    assert.equal(row[column as keyof typeof row].key, key(label))
  }
  assert.deepEqual(records, before)
})

test('keys remain language independent while status, thermal, blank and timestamp labels follow the interface', () => {
  const car = vehicle('a', { status: 'testing', thermal: 'Direct Heat Pump' })
  const english = createVehicleFilterValues([car], 'en').get(car.id)!
  const chinese = createVehicleFilterValues([car], 'zh').get(car.id)!
  assert.deepEqual(Object.fromEntries(Object.entries(english).map(([column, value]) => [column, value.key])), Object.fromEntries(Object.entries(chinese).map(([column, value]) => [column, value.key])))
  assert.equal(english.status.label, 'Testing'); assert.equal(chinese.status.label, '测试中')
  assert.equal(english.thermal.label, 'Direct Heat Pump'); assert.equal(chinese.thermal.label, '直接式热泵')
  assert.equal(english.owner.label, '(blank)'); assert.equal(chinese.owner.label, '（空白）')
  assert.equal(chinese.updated.label, `${new Date(updated).toLocaleString('zh-CN')} · v1`)
  assert(matchesVehicleColumnFilters(chinese, { status: [english.status.key], thermal: [english.thermal.key] }))
  const archived = createVehicleFilterValues([{ ...car, archived: true }], 'zh').get(car.id)!
  assert.equal(archived.status.key, key('archived')); assert.equal(archived.status.label, '已归档')
  assert.equal(createVehicleFilterValues([vehicle('legacy', { thermal: 'Legacy cooling' })], 'zh').get('legacy')!.thermal.label, 'Legacy cooling')
})

test('missing, null and empty values share one blank key; em dashes, whitespace, zero and leading zeros stay distinct', () => {
  const cars = [vehicle('missing'), vehicle('null', { owner: null }), vehicle('empty', { owner: '' }), vehicle('dash', { owner: '—' }), vehicle('zero', { owner: 0 }), vehicle('false', { owner: false }), vehicle('identifier', { owner: '00123' }), vehicle('spaces', { owner: '  ' })]
  const values = createVehicleFilterValues(cars, 'en')
  for (const id of ['missing', 'null', 'empty']) assert.equal(values.get(id)!.owner.key, '[]')
  assert.equal(values.get('dash')!.owner.key, key('—'))
  assert.equal(values.get('zero')!.owner.label, '0')
  assert.equal(values.get('false')!.owner.label, 'false')
  assert.equal(values.get('identifier')!.owner.label, '00123')
  assert.equal(values.get('spaces')!.owner.key, key('  '))
  assert.equal(vehicleColumnFilterOptions('owner', cars, values, [], 'en').length, 6)
  assert(matchesVehicleColumnFilters(values.get('missing')!, { owner: ['[]'] }))
  assert(!matchesVehicleColumnFilters(values.get('dash')!, { owner: ['[]'] }))
  assert(matchesVehicleColumnFilters(values.get('dash')!, { owner: [key('—')] }))
})

test('composite keys include secondary values and encode separators without ambiguous concatenation', () => {
  const first = vehicle('first', { name: 'Trial', vin: 'VIN', plate: 'AB', plateExpiry: '2027-01-01' })
  const second = vehicle('second', { name: 'Trial', vin: 'OTHER', plate: 'AB', plateExpiry: '2028-01-01' }, { version: 2 })
  const values = createVehicleFilterValues([first, second], 'en')
  for (const column of ['vehicle', 'plate', 'updated'] as const) assert.notEqual(values.get(first.id)![column].key, values.get(second.id)![column].key)
  const separators = [vehicle('left', { name: 'a · b', vin: 'c' }), vehicle('right', { name: 'a', vin: 'b · c' })]
  const separated = createVehicleFilterValues(separators, 'en')
  assert.notEqual(separated.get('left')!.vehicle.key, separated.get('right')!.vehicle.key)
  assert.equal(createVehicleFilterValues([vehicle('blank', { name: null, vin: '' })], 'en').get('blank')!.vehicle.key, '[]')
  assert.equal(createVehicleFilterValues([vehicle('partial', { name: '', vin: 'VIN' })], 'en').get('partial')!.vehicle.label, '— · VIN')
})

test('independent nickname, VIN and plate-expiry filters do not inherit composite secondary values', () => {
  const cars = [
    vehicle('a', { name: 'Trial', vin: 'VIN-A', plate: '00123', plateExpiry: '2027-01-01' }),
    vehicle('b', { name: 'Trial', vin: 'VIN-B', plate: '00123', plateExpiry: '2028-01-01' }),
    vehicle('c', { name: 'Other', vin: 'VIN-C', plate: 'Other plate', plateExpiry: '2027-01-01' }),
  ]
  const values = createVehicleFilterValues(cars, 'en')
  const matching = (filters: VehicleColumnFilters) => cars.filter(car => matchesVehicleColumnFilters(values.get(car.id)!, filters)).map(car => car.id)
  assert.deepEqual(matching({ name: [key('Trial')] }), ['a', 'b'])
  assert.deepEqual(matching({ vehicle: [key('Trial', 'VIN-A')] }), ['a'])
  assert.deepEqual(matching({ vin: [key('VIN-B')] }), ['b'])
  assert.deepEqual(matching({ plateExpiry: [key('2027-01-01')] }), ['a', 'c'])
  assert.deepEqual(matching({ plate: [key('00123', '2027-01-01')] }), ['a'])
  assert.deepEqual(matching({ name: [key('Trial')], plateExpiry: [key('2028-01-01')] }), ['b'])
  assert.deepEqual(vehicleColumnFilterOptions('name', cars, values, [], 'en').map(value => value.label), ['Other', 'Trial'])
  assert.deepEqual(vehicleColumnFilterOptions('plateExpiry', cars, values, [], 'en').map(value => value.label), ['2027-01-01', '2028-01-01'])
  assert.deepEqual(values.get('a')!.vin, { key: key('VIN-A'), label: 'VIN-A' })
})

test('Compliance Level filters preserve every enum, distinguish legacy blanks and keep language-independent values', () => {
  const cars = [
    ...complianceLevels.map(value => vehicle(value, { complianceLevel: value })),
    vehicle('missing'), vehicle('null', { complianceLevel: null }), vehicle('empty', { complianceLevel: '' }), vehicle('dash', { complianceLevel: '—' }),
  ]
  const english = createVehicleFilterValues(cars, 'en'), chinese = createVehicleFilterValues(cars, 'zh')
  for (const level of complianceLevels) {
    assert.deepEqual(english.get(level)!.complianceLevel, { key: key(level), label: level })
    assert.deepEqual(chinese.get(level)!.complianceLevel, english.get(level)!.complianceLevel)
    assert.deepEqual(cars.filter(car => matchesVehicleColumnFilters(english.get(car.id)!, { complianceLevel: [key(level)] })).map(car => car.id), [level])
  }
  assert.deepEqual(cars.filter(car => matchesVehicleColumnFilters(english.get(car.id)!, { complianceLevel: ['[]'] })).map(car => car.id), ['missing', 'null', 'empty'])
  assert.equal(english.get('missing')!.complianceLevel.label, '(blank)')
  assert.equal(chinese.get('missing')!.complianceLevel.label, '（空白）')
  assert.deepEqual(english.get('dash')!.complianceLevel, { key: key('—'), label: '—' })
  const options = vehicleColumnFilterOptions('complianceLevel', cars, english, [], 'en')
  assert.equal(options.length, complianceLevels.length + 2)
  assert.deepEqual(cars.filter(car => matchesVehicleColumnFilters(chinese.get(car.id)!, { complianceLevel: [key('Eu7'), key('CN6')] })).map(car => car.id), ['Eu7', 'CN6'])
})

test('legacy cooling text is filterable while cover-photo references and arbitrary data never become columns', () => {
  const legacy = vehicle('legacy', { coolingArchitecture: 'Legacy loop\n历史架构', photoAttachmentId: 'private-image-id', unknownField: 'Hidden value' })
  const modern = vehicle('modern'), values = createVehicleFilterValues([legacy, modern], 'zh')
  assert.deepEqual(values.get(legacy.id)!.coolingArchitecture, { key: key('Legacy loop\n历史架构'), label: 'Legacy loop\n历史架构' })
  assert.equal(values.get(modern.id)!.coolingArchitecture.key, '[]')
  assert(matchesVehicleColumnFilters(values.get(legacy.id)!, { coolingArchitecture: [key('Legacy loop\n历史架构')] }))
  assert(!matchesVehicleColumnFilters(values.get(modern.id)!, { coolingArchitecture: [key('Legacy loop\n历史架构')] }))
  for (const row of values.values()) for (const field of ['photoAttachmentId', 'vehiclePhoto', 'unknownField']) assert(!Object.hasOwn(row, field))
})

test('battery filters use the whole ordered active-battery summary and omit archived and removed batteries', () => {
  const car = vehicle('a'), records = [
    car,
    child('old', car.id, 'part', { category: 'battery', maturity: 'POC', productPart: '0001', serial: 'A' }, { updated: '2026-01-01T00:00:00Z' }),
    child('new', car.id, 'part', { category: 'battery', maturity: 'DV', productPart: '0002', serial: 'B', removedAt: '  ' }, { updated: '2026-02-01T00:00:00Z' }),
    child('archived', car.id, 'part', { category: 'battery', maturity: 'ARCHIVED' }, { archived: true }),
    child('removed', car.id, 'part', { category: 'battery', maturity: 'REMOVED', removedAt: '2026-03-01' }),
    child('unrelated', 'another', 'part', { category: 'battery', maturity: 'OTHER' }),
  ]
  const row = createVehicleFilterValues(records, 'en').get(car.id)!
  assert.deepEqual(row.hvBatteryMaturityLevel, { key: key('DV', 'POC'), label: 'DV / POC' })
  assert.deepEqual(row.hvBatteryPartNumber, { key: key('0002', '0001'), label: '0002 / 0001' })
  assert.deepEqual(row.hvBatterySerialNumber, { key: key('B', 'A'), label: 'B / A' })
  assert(!matchesVehicleColumnFilters(row, { hvBatteryMaturityLevel: [key('DV')] }), 'A component alone is not the whole displayed cell')
  assert(matchesVehicleColumnFilters(row, { hvBatteryMaturityLevel: [key('DV', 'POC')] }))
  const blank = createVehicleFilterValues([car, child('empty', car.id, 'part', { category: 'battery' })], 'en').get(car.id)!
  assert.equal(blank.hvBatteryPartNumber.key, '[]')
  assert.equal(createVehicleFilterValues([car], 'en').get(car.id)!.hvBatteryPartNumber.key, '[]')
})

test('VCU lookup exactly follows the visible controller slot, including aliases, first match and archive filtering', () => {
  const car = vehicle('a')
  const archived = child('archived', car.id, 'part', { category: 'controller', name: 'VCU', controllerType: 'Close ECU' }, { archived: true })
  const wrongCategory = child('wrong', car.id, 'part', { category: 'battery', name: 'VCU', controllerType: 'Close ECU' })
  const evcu = child('evcu', car.id, 'part', { category: 'controller', name: ' evcu ', controllerType: 'Open ECU', removedAt: '2026-01-01' })
  const later = child('later', car.id, 'part', { category: 'controller', name: 'VCU', controllerType: 'Close ECU' })
  const bms = child('bms', car.id, 'part', { category: 'controller', name: 'MSB' })
  const records = [car, archived, wrongCategory, evcu, later, bms]
  assert.equal(findVehicleTableController(records, car.id, 'VCU'), evcu)
  assert.equal(findVehicleTableController(records, car.id, 'BMS/MSB'), bms)
  assert.equal(findVehicleTableController(records, car.id, 'MCU'), null)
  assert.equal(findVehicleTableController(records, 'another', 'VCU'), null)
  assert.deepEqual(createVehicleFilterValues(records, 'en').get(car.id)!.vcuType, { key: key('Open ECU'), label: 'Open ECU' })
  assert.equal(createVehicleFilterValues([car, later], 'en').get(car.id)!.vcuType.label, 'Close ECU')
  assert.equal(createVehicleFilterValues([car, archived, wrongCategory], 'en').get(car.id)!.vcuType.key, '[]')
  assert.equal(createVehicleFilterValues([car, { ...evcu, data: { ...evcu.data, controllerType: '' } }], 'en').get(car.id)!.vcuType.key, '[]')
})

test('report ordering retains DOVE date parsing, saved/updated fallback, updated tie-break and stable exact ties', () => {
  const car = vehicle('a')
  const first = child('first', car.id, 'report', { recordedAt: '2026-04-01 10h00' }, { updated: '2026-05-01T00:00:00Z' })
  const sameTimeNewer = child('newer', car.id, 'report', { recordedAt: '2026-04-01T10:00:00' }, { updated: '2026-05-02T00:00:00Z' })
  const exactTie = { ...sameTimeNewer, id: 'exact-tie' }
  const saved = child('saved', car.id, 'report', { recordedAt: 'invalid', savedAt: '2026-03-20T00:00:00Z' })
  const fallback = child('fallback', car.id, 'report', {}, { updated: '2026-03-10T00:00:00Z' })
  const archived = child('archived', car.id, 'report', { recordedAt: '2026-12-01T00:00:00Z' }, { archived: true })
  const records = [saved, car, first, fallback, sameTimeNewer, archived, exactTie]
  const before = records.slice()
  assert.deepEqual(sortedVehicleReports(records).map(record => record.id), ['archived', 'newer', 'exact-tie', 'first', 'saved', 'fallback'])
  assert.deepEqual(records, before)
  const value = createVehicleFilterValues(records, 'en').get(car.id)!.latestDove
  assert.deepEqual(value, { key: key('2026-04-01T10:00:00'), label: '2026-04-01T10:00:00' })
  const newestWithoutReportedDate = child('newest-blank', car.id, 'report', { recordedAt: '', savedAt: '2027-01-01T00:00:00Z' })
  assert.equal(createVehicleFilterValues([...records, newestWithoutReportedDate], 'en').get(car.id)!.latestDove.key, '[]', 'Never substitute an older populated date')
})

test('column filters use OR within each column and AND between columns, with exact whole-cell matching', () => {
  const cars = [vehicle('a', { project: 'A', owner: 'Alice' }), vehicle('b', { project: 'B', owner: 'Alice' }), vehicle('c', { project: 'B', owner: 'Bob' }), vehicle('d', { project: 'C', owner: 'Alice' })]
  const values = createVehicleFilterValues(cars, 'en')
  const filters: VehicleColumnFilters = { project: [key('A'), key('B')], owner: [key('Alice')], notes: [] }
  assert.deepEqual(cars.filter(car => matchesVehicleColumnFilters(values.get(car.id)!, filters)).map(car => car.id), ['a', 'b'])
  assert(cars.every(car => matchesVehicleColumnFilters(values.get(car.id)!, {})))
  assert(matchesVehicleColumnFilters(values.get('a')!, { owner: undefined }), 'An omitted optional criterion does not filter records')
  assert(!matchesVehicleColumnFilters(values.get('a')!, { project: [key('a')] }), 'Stored-value choices are exact, not substring/case-folded queries')
  assert(!matchesVehicleColumnFilters(values.get('a')!, { owner: [key('Missing')] }))
})

test('options use the complete supplied archive-eligible list across pages and do not inherit other column filters', () => {
  const cars = Array.from({ length: 23 }, (_, index) => vehicle(String(index), { project: index < 22 ? 'A' : 'Across pages', owner: index === 22 ? 'Other' : 'Alice' }))
  const archived = vehicle('archived', { project: 'Archived only' }, { archived: true })
  const all = [...cars, archived], values = createVehicleFilterValues(all, 'en')
  assert.deepEqual(vehicleColumnFilterOptions('project', cars, values, [], 'en').map(value => value.label), ['A', 'Across pages'])
  assert.equal(vehicleColumnFilterOptions('project', all, values, [], 'en').length, 3)
  const filtered = cars.filter(car => matchesVehicleColumnFilters(values.get(car.id)!, { owner: [key('Alice')] }))
  assert.equal(filtered.length, 22)
  assert(vehicleColumnFilterOptions('project', cars, values, [], 'en').some(value => value.label === 'Across pages'), 'Options still use the base list, not currently filtered rows')
  assert.deepEqual(vehicleColumnFilterOptions('project', [], values, [], 'en'), [])
})

test('unmatched selections remain available, deduplicate and relabel after language changes or data refreshes', () => {
  const removed = vehicle('removed', { status: 'testing', thermal: 'No Heat Pump' }, { version: 5 })
  const oldEnglish = createVehicleFilterValues([removed], 'en').get(removed.id)!
  const oldChinese = createVehicleFilterValues([removed], 'zh').get(removed.id)!
  const current = vehicle('current', { status: 'available' })
  const values = createVehicleFilterValues([current], 'zh')
  for (const column of ['vehicle', 'plate', 'updated', 'status', 'thermal'] as const) {
    const selected = oldEnglish[column].key
    const options = vehicleColumnFilterOptions(column, [current], values, [selected, selected], 'zh')
    assert.equal(options.filter(value => value.key === selected).length, 1)
    assert.equal(options.find(value => value.key === selected)!.label, oldChinese[column].label)
  }
  const blankAndDash = vehicleColumnFilterOptions('owner', [], values, ['[]', key('—')], 'zh')
  assert.equal(blankAndDash.length, 2)
  assert.equal(blankAndDash.find(value => value.key === '[]')!.label, '（空白）')
  assert.equal(blankAndDash.find(value => value.key === key('—'))!.label, '—')
  assert.deepEqual(vehicleColumnFilterOptions('notes', [], values, ['legacy-undecodable', '{"invalid":1}'], 'en').map(value => value.label).sort(), ['legacy-undecodable', '{"invalid":1}'].sort())
})

test('hiding columns clears their filters without mutation, while unchanged visibility and reordered columns retain the same state', () => {
  const filters: VehicleColumnFilters = { project: [key('A')], vcuType: [key('Open ECU')], notes: [] }
  assert.equal(visibleVehicleColumnFilters(filters, ['vehicle', 'project', 'notes', 'vcuType', 'actions']), filters)
  assert.equal(visibleVehicleColumnFilters(filters, ['vehicle', 'vcuType', 'project', 'notes', 'actions']), filters)
  const next = visibleVehicleColumnFilters(filters, ['vehicle', 'project', 'actions'])
  assert.deepEqual(next, { project: [key('A')] })
  assert.notEqual(next, filters)
  assert.equal(next.project, filters.project)
  assert.deepEqual(filters, { project: [key('A')], vcuType: [key('Open ECU')], notes: [] })
  assert.equal(visibleVehicleColumnFilters(next, ['vehicle', 'project', 'actions']), next)
})

test('fresh record snapshots reflect controller changes while retaining unavailable old selections as zero-match choices', () => {
  const car = vehicle('a'), controller = child('vcu', car.id, 'part', { category: 'controller', name: 'VCU', controllerType: 'Open ECU' })
  const before = createVehicleFilterValues([car, controller], 'en')
  const selected = before.get(car.id)!.vcuType.key
  const after = createVehicleFilterValues([car, { ...controller, data: { ...controller.data, controllerType: 'Close ECU' }, version: 2 }], 'en')
  assert.equal(before.get(car.id)!.vcuType.label, 'Open ECU')
  assert.equal(after.get(car.id)!.vcuType.label, 'Close ECU')
  assert(!matchesVehicleColumnFilters(after.get(car.id)!, { vcuType: [selected] }))
  assert.deepEqual(vehicleColumnFilterOptions('vcuType', [car], after, [selected], 'en').map(value => value.label), ['Close ECU', 'Open ECU'])
})
