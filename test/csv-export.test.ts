import { test } from 'node:test'
import assert from 'node:assert/strict'
import unzipper from 'unzipper'
import type { BusinessRecord, RecordKind } from '../shared/business.js'
import { entryFields, partFields, vehicleFields } from '../shared/business.js'
import { defaultExportConfiguration, exportColumns, exportFilterFields, exportKinds, matchesExportVehicle, MAX_EXPORT_ID_LENGTH, MAX_EXPORT_VEHICLES, parseExportConfiguration, recordsForExport } from '../shared/csv-export.js'
import type { ExportConfiguration } from '../shared/csv-export.js'
import { buildCsvExport } from '../server/csv-export.js'

const vehicleId = '11111111-1111-4111-8111-111111111111'
const otherId = '22222222-2222-4222-8222-222222222222'
const record = (kind: RecordKind, id: string, data: BusinessRecord['data'] = {}, parent: string | null = kind === 'vehicle' ? null : vehicleId, archived = false): BusinessRecord => ({ id, kind, vehicleId: parent, data, archived, version: 3, updated: '2026-10-23T02:03:04.000Z' })
const car = (id = vehicleId, overrides: BusinessRecord['data'] = {}, archived = false) => record('vehicle', id, { name: '昵称', project: 'Project A', model: 'Model A', vin: 'TEST0000000000001', status: 'available', owner: 'Alice', physicalLocation: 'Bay 1', thermal: 'Indirect Heat Pump', ...overrides }, null, archived)
const allColumns = (language: 'en' | 'zh' = 'en'): ExportConfiguration => ({ ...defaultExportConfiguration(language), columns: Object.fromEntries(exportKinds.map(kind => [kind, exportColumns[kind].map(column => column.id)])) })

async function contents(bytes: Buffer): Promise<Map<string, Buffer>> {
  const zip = await unzipper.Open.buffer(bytes)
  return new Map(await Promise.all(zip.files.map(async entry => [entry.path, await entry.buffer()] as const)))
}

// Small independent reader verifies quoting and embedded CR/LF without normalizing stored values.
function csvRows(bytes: Buffer): string[][] {
  const csv = bytes.toString('utf8').replace(/^\ufeff/, ''), rows: string[][] = []
  let row: string[] = [], value = '', quoted = false
  for (let index = 0; index < csv.length; index++) {
    const char = csv[index]
    if (quoted) {
      if (char === '"' && csv[index + 1] === '"') { value += '"'; index++ }
      else if (char === '"') quoted = false
      else value += char
    } else if (char === '"') quoted = true
    else if (char === ',') { row.push(value); value = '' }
    else if (char === '\r' && csv[index + 1] === '\n') { row.push(value); rows.push(row); row = []; value = ''; index++ }
    else value += char
  }
  assert.equal(quoted, false)
  assert.equal(value, '')
  assert.equal(row.length, 0)
  return rows
}

test('CSV configuration catalog covers only supported fields with independent bilingual defaults', () => {
  const first = defaultExportConfiguration('en'), second = defaultExportConfiguration('zh')
  assert.deepEqual(first.columns, { vehicle: [...vehicleFields] })
  assert.deepEqual(first.filters, { search: '', project: [], model: [], status: [], owner: [], physicalLocation: [], thermal: [] })
  assert.equal(first.includeArchived, false)
  assert.equal(second.language, 'zh')
  first.filters.project.push('changed'); first.columns.vehicle!.reverse()
  assert.deepEqual(second.filters.project, [])
  assert.deepEqual(second.columns.vehicle, [...vehicleFields])
  for (const kind of exportKinds) {
    const catalog = exportColumns[kind]
    assert.equal(new Set(catalog.map(column => column.id)).size, catalog.length)
    assert(catalog.every(column => column.label?.length === 2 && column.label.every(label => Boolean(label))))
    assert(catalog.some(column => column.id === 'id'))
    if (kind !== 'vehicle') for (const id of ['vehicleId', 'vehicleVin']) assert(catalog.some(column => column.id === id))
  }
  for (const field of partFields) assert(exportColumns.part.some(column => column.id === field))
  for (const kind of ['modification', 'equipment'] as const) for (const field of entryFields) assert(exportColumns[kind].some(column => column.id === field))
  for (const field of ['coolingArchitecture', 'vehicleSnapshot', 'parsed', 'controllers', 'faults', 'warnings', 'sheets']) assert(!exportKinds.some(kind => exportColumns[kind].some(column => column.id === field)))
  assert.equal(exportColumns.vehicle.find(column => column.id === 'name')!.label[0], 'Nick Name')
})

test('CSV configuration validation rejects arbitrary columns, categories, extra keys and unsafe shapes', () => {
  const valid = allColumns('zh')
  assert.deepEqual(parseExportConfiguration(valid), valid)
  const parsed = parseExportConfiguration(valid)!
  parsed.columns.vehicle!.reverse(); parsed.filters.model.push('new')
  assert.notDeepEqual(parsed, valid)
  const cases: unknown[] = [null, [], 'x', {}, { ...valid, version: 2 }, { ...valid, language: 'fr' }, { ...valid, includeArchived: 'yes' }, { ...valid, vehicleIds: [vehicleId] }, { ...valid, columns: {} }, { ...valid, columns: { vehicle: [] } }, { ...valid, columns: { vehicle: ['vin', 'vin'] } }, { ...valid, columns: { vehicle: ['__proto__'] } }, { ...valid, columns: { vehicle: ['vehicleSnapshot'] } }, { ...valid, columns: { audit: ['name'] } }, { ...valid, columns: { vehicle: 'vin' } }, { ...valid, filters: { ...valid.filters, owner: [null] } }, { ...valid, filters: { ...valid.filters, owner: ['Alice', 'Alice'] } }, { ...valid, filters: { ...valid.filters, search: 'x'.repeat(4001) } }, { ...valid, filters: { ...valid.filters, thermal: ['x'.repeat(4001)] } }, { ...valid, filters: { ...valid.filters, unexpected: [] } }, { ...valid, filters: { search: '' } }, JSON.parse(JSON.stringify(valid).replace('"columns":{', '"columns":{"__proto__":["vin"],'))]
  for (const candidate of cases) assert.equal(parseExportConfiguration(candidate), null)
  assert.equal(parseExportConfiguration({ ...valid, filters: { ...valid.filters, model: new Array(1) } }), null)
  assert.equal(parseExportConfiguration({ ...valid, columns: { vehicle: new Array(1) } }), null)
})

test('CSV filters use AND across fields, OR inside each field, scalar current-field search and archive opt-in', () => {
  const configuration = defaultExportConfiguration('en'), vehicle = car()
  for (const field of exportFilterFields) {
    configuration.filters[field] = ['wrong', String(vehicle.data[field])]
    assert(matchesExportVehicle(vehicle, configuration), field)
  }
  configuration.filters.model = ['wrong']
  assert.equal(matchesExportVehicle(vehicle, configuration), false)
  configuration.filters.model = ['Model A']
  configuration.filters.search = '  BAY 1  '
  assert(matchesExportVehicle(vehicle, configuration))
  configuration.filters.search = '昵称'
  assert(matchesExportVehicle(vehicle, configuration))
  configuration.filters.search = 'not found'
  assert.equal(matchesExportVehicle({ ...vehicle, data: { ...vehicle.data, secret: 'not found', coolingArchitecture: 'not found' } }, configuration), false)
  configuration.filters.search = ''
  assert.equal(matchesExportVehicle({ ...vehicle, archived: true }, configuration), false)
  configuration.includeArchived = true
  assert(matchesExportVehicle({ ...vehicle, archived: true }, configuration))
  assert.equal(matchesExportVehicle(record('part', 'part', vehicle.data), configuration), false)
  const blank = defaultExportConfiguration('en'); blank.filters.physicalLocation = ['']
  assert(matchesExportVehicle(car(vehicleId, { physicalLocation: undefined }), blank))
  assert(matchesExportVehicle(car(vehicleId, { physicalLocation: '' }), blank))
})

test('CSV row selection excludes other parents, orphans and archived parents/children unless opted in', () => {
  const rows = [car(), car(otherId, {}, true), record('part', 'active'), record('part', 'archived', {}, vehicleId, true), record('part', 'other', {}, otherId), record('part', 'orphan', {}, 'missing'), record('part', 'parentless', {}, null)]
  const selected = new Set([vehicleId, otherId, 'missing'])
  assert.deepEqual(recordsForExport(rows, 'vehicle', selected, false).map(row => row.id), [vehicleId])
  assert.deepEqual(recordsForExport(rows, 'part', selected, false).map(row => row.id), ['active'])
  assert.deepEqual(recordsForExport(rows, 'part', selected, true).map(row => row.id), ['active', 'archived', 'other'])
  assert.deepEqual(recordsForExport(rows, 'part', new Set(), true), [])
})

test('CSV ZIP includes all six categories with independent rows, ordered columns, references and scalar report summaries', async () => {
  const configuration = allColumns()
  configuration.columns.vehicle = ['vin', 'name', 'thermal', 'physicalLocation', 'id', 'updated']
  const rows = [car(), car(otherId), record('part', 'part', Object.fromEntries(partFields.map(field => [field, 'part-' + field]))), record('modification', 'mod', Object.fromEntries(entryFields.map(field => [field, 'mod-' + field]))), record('equipment', 'equip', Object.fromEntries(entryFields.map(field => [field, 'equip-' + field]))), record('report', 'report', { name: '源文件.xlsx', checksum: 'abc', size: 0, recordedAt: '2026-10-23 02h03', savedAt: '2026-10-23T02:03:04.000Z', parserVersion: 'v1', parsed: { vin: 'TEST0000000000001', rawVin: 'TEST-0000000000001', software: '000001', mileage: 0, soc: 0, vehicleMode: 'test', controllers: [{ secret: 'CONTROLLER_SECRET' }], faults: [{ secret: 'FAULT_SECRET' }], warnings: ['WARN_SECRET'], sheets: ['SHEET_SECRET'] }, vehicleSnapshot: { secret: 'SNAPSHOT_SECRET' } }), record('attachment', 'attachment', { name: 'photo.png', checksum: 'xyz', size: 12, savedAt: '2026-10-23T02:03:04.000Z' })]
  const { bytes, counts } = await buildCsvExport(rows, { vehicleIds: [vehicleId], configuration })
  assert.deepEqual(counts, { vehicle: 1, part: 1, modification: 1, equipment: 1, report: 1, attachment: 1 })
  const zip = await contents(bytes)
  assert.deepEqual([...zip.keys()], ['vehicles.csv', 'parts-controllers.csv', 'modifications.csv', 'equipment.csv', 'report-summaries.csv', 'attachments.csv'])
  for (const entry of zip.values()) { assert.equal(entry.subarray(0, 3).toString('hex'), 'efbbbf'); assert.equal(csvRows(entry).length, 2) }
  assert.deepEqual(csvRows(zip.get('vehicles.csv')!)[0], ['VIN', 'Nick Name', 'Thermal System Type', 'Physical location', 'Record ID', 'Last updated'])
  assert.deepEqual(csvRows(zip.get('vehicles.csv')!)[1], ['TEST0000000000001', '昵称', 'Indirect Heat Pump', 'Bay 1', vehicleId, '2026-10-23T02:03:04.000Z'])
  for (const [kind, filename, prefix, fields] of [['part', 'parts-controllers.csv', 'part', partFields], ['modification', 'modifications.csv', 'mod', entryFields], ['equipment', 'equipment.csv', 'equip', entryFields]] as const) {
    const values = csvRows(zip.get(filename)!)[1]
    for (const field of fields) assert.equal(values[configuration.columns[kind]!.indexOf(field)], prefix + '-' + field)
  }
  const report = csvRows(zip.get('report-summaries.csv')!)
  const reportValue = Object.fromEntries(configuration.columns.report!.map((id, index) => [id, report[1][index]]))
  assert.equal(reportValue.vehicleId, vehicleId); assert.equal(reportValue.vehicleVin, 'TEST0000000000001')
  assert.equal(reportValue.mileage, '0'); assert.equal(reportValue.soc, '0'); assert.equal(reportValue.size, '0'); assert.equal(reportValue.software, '000001')
  assert.equal(reportValue.recordedAt, '2026-10-23 02h03'); assert.equal(reportValue.rawVin, 'TEST-0000000000001')
  assert.equal(reportValue.archived, 'false'); assert.equal(reportValue.version, '3')
  for (const entry of zip.values()) assert(!/CONTROLLER_SECRET|FAULT_SECRET|WARN_SECRET|SHEET_SECRET|SNAPSHOT_SECRET/.test(entry.toString()))
})

test('CSV ZIP uses Chinese headers and headers-only files for empty selected categories', async () => {
  const { bytes, counts } = await buildCsvExport([car()], { vehicleIds: [vehicleId], configuration: allColumns('zh') })
  const files = await contents(bytes)
  assert.equal(files.size, 6)
  assert.equal(csvRows(files.get('vehicles.csv')!)[0][0], '昵称')
  for (const [name, entry] of files) if (name !== 'vehicles.csv') assert.equal(csvRows(entry).length, 1)
  assert.deepEqual(counts, { vehicle: 1, part: 0, modification: 0, equipment: 0, report: 0, attachment: 0 })
  const chosen = { ...defaultExportConfiguration('en'), columns: { attachment: ['name'] } }
  const single = await contents((await buildCsvExport([car()], { vehicleIds: [vehicleId], configuration: chosen })).bytes)
  assert.deepEqual([...single.keys()], ['attachments.csv'])
})

test('CSV preserves quoting, multiline Unicode, blank/zero values and protects spreadsheet formulas', async () => {
  const values: unknown[] = ['a,b', 'say "hi"', 'line1\r\nline2\nline3', '中文 🚗', '00000123', '2026-01-02', '', undefined, null, 0, -12, false, '=1+1', '+SUM(A1)', '-1+1', '@SUM(A1)', ' \t\r\n=SUM(A1)', '\u0000\u0001@SUM(A1)', '\ufeff+SUM(A1)', { secret: 'not scalar' }, ['not scalar']]
  const rows = [car(), ...values.map((notes, index) => record('equipment', 'equipment-' + index, { notes }))]
  const configuration = { ...defaultExportConfiguration('en'), columns: { equipment: ['notes'] } }
  const zip = await contents((await buildCsvExport(rows, { vehicleIds: [vehicleId], configuration })).bytes)
  const actual = csvRows(zip.get('equipment.csv')!).slice(1).map(row => row[0])
  const expected = ['a,b', 'say "hi"', 'line1\r\nline2\nline3', '中文 🚗', '00000123', '2026-01-02', '', '', '', '0', '-12', 'false', "'=1+1", "'+SUM(A1)", "'-1+1", "'@SUM(A1)", "' \t\r\n=SUM(A1)", "'\u0000\u0001@SUM(A1)", "'\ufeff+SUM(A1)", '', '']
  assert.deepEqual(actual, expected)
  const raw = zip.get('equipment.csv')!.toString()
  assert(raw.includes('"a,b"\r\n')); assert(raw.includes('"say ""hi"""\r\n')); assert(raw.endsWith('\r\n'))
})

test('CSV selection cannot retarget a removed UUID to a newly registered vehicle with the same VIN', async () => {
  const configuration = defaultExportConfiguration('en')
  for (const rows of [[], [car(otherId)], [car(vehicleId, {}, true)]]) await assert.rejects(buildCsvExport(rows, { vehicleIds: [vehicleId], configuration }), { code: 'EXPORT_SELECTION_CHANGED', status: 409 })
  configuration.filters.project = ['Project B']
  await assert.rejects(buildCsvExport([car()], { vehicleIds: [vehicleId], configuration }), { code: 'EXPORT_SELECTION_CHANGED' })
  configuration.filters.project = []; configuration.includeArchived = true
  const result = await buildCsvExport([car(vehicleId, {}, true)], { vehicleIds: [vehicleId], configuration })
  assert.equal(result.counts.vehicle, 1)
  for (const vehicleIds of [[], [vehicleId, vehicleId], [123], ['x'.repeat(121)]]) await assert.rejects(buildCsvExport([car()], { vehicleIds: vehicleIds as string[], configuration }), { code: 'INVALID_INPUT' })
  await assert.rejects(buildCsvExport([car()], { vehicleIds: [vehicleId], configuration: { ...configuration, columns: { vehicle: ['vehicleSnapshot'] } } }), { code: 'INVALID_INPUT' })
  await assert.rejects(buildCsvExport(new Array(200001), { vehicleIds: [vehicleId], configuration }), { code: 'EXPORT_TOO_LARGE', status: 413 })
})

test('CSV selection limits are shared, enforce identifier bounds and accept the full select-all limit', async () => {
  assert.equal(MAX_EXPORT_VEHICLES, 20000); assert.equal(MAX_EXPORT_ID_LENGTH, 120)
  const configuration = { ...defaultExportConfiguration('en'), columns: { vehicle: ['id'] } }
  const ids = Array.from({ length: MAX_EXPORT_VEHICLES }, (_, index) => `11111111-1111-4111-8111-${String(index).padStart(12, '0')}`)
  const rows = ids.map(id => car(id))
  const result = await buildCsvExport(rows, { vehicleIds: ids, configuration })
  assert.equal(result.counts.vehicle, MAX_EXPORT_VEHICLES)
  const zip = await contents(result.bytes)
  assert.equal(csvRows(zip.get('vehicles.csv')!).length, MAX_EXPORT_VEHICLES + 1)
  await assert.rejects(buildCsvExport(rows, { vehicleIds: [...ids, otherId], configuration }), { code: 'INVALID_INPUT' })
  const longestId = 'a'.repeat(MAX_EXPORT_ID_LENGTH)
  assert.equal((await buildCsvExport([car(longestId)], { vehicleIds: [longestId], configuration })).counts.vehicle, 1)
  await assert.rejects(buildCsvExport([car(longestId + 'b')], { vehicleIds: [longestId + 'b'], configuration }), { code: 'INVALID_INPUT' })
})
