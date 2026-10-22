import { test } from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs, existsSync } from 'node:fs'
import path from 'node:path'
import ExcelJS from 'exceljs'
import { parseDove } from '../server/dove-parser.js'
import { DoveService, compareReports } from '../server/dove.js'
import { Business } from '../server/business.js'
import { LocalStore } from '../server/store.js'
import { doveRecordedTime, keyControllerName, validControllerValue } from '../shared/business.js'
import type { DoveImportConfirmation } from '../shared/business.js'

test('key controller aliases and placeholder values are recognized without fuzzy matching', () => {
  for (const name of ['BMS', 'msb', ' BMS/MSB ', 'MSB/BMS']) assert.equal(keyControllerName(name), 'BMS/MSB')
  for (const name of ['VCU', ' evcu ']) assert.equal(keyControllerName(name), 'VCU')
  assert.equal(keyControllerName('mcu'), 'MCU')
  for (const name of ['BMS2', 'MCU_FRONT', '', 'ABS']) assert.equal(keyControllerName(name), null)
  for (const value of ['', ' ', 'invalide', 'INVALID', 'N/A', 'unknown', '\u2014', '--', null]) assert.equal(validControllerValue(value), false)
  for (const value of ['0.00', '000123', '98.741.952.80']) assert.equal(validControllerValue(value), true)
  assert.equal(doveRecordedTime('2026-07-29 18h34'), Date.parse('2026-07-29T18:34:00'))
  assert.ok(doveRecordedTime('2026-07-29 18h34') > doveRecordedTime('2026-07-24 17h46'))
  assert.ok(Number.isNaN(doveRecordedTime('')))
})

export async function sampleWorkbook(vin = 'TEST0000000000001', software = '1.0'): Promise<Buffer> {
  const book = new ExcelJS.Workbook(), summary = book.addWorksheet('DOVE'), identification = book.addWorksheet('Identification'), defects = book.addWorksheet('Defauts')
  summary.addRows([['Vin :', vin], ['Date of record', '2026-10-21'], ['Vehicle milage', '1234.5 km'], ['Value SOC', '80']])
  identification.addRow(['ECU', 'Description', 'Network', 'Supplier'])
  identification.addRow(['EVCU', 'Vehicle control', 'CAN UDS', 'Supplier', 'FN1', 'PN1', software, '', 'CAL1', '2', '2026-10-01', '', '2026-09-01', '000123'])
  defects.addRow(['EVCU', '', 'CAN UDS', 'P123456 (2Fh - Permanent) Example fault', 'raw response'])
  return Buffer.from(await book.xlsx.writeBuffer())
}

test('DOVE validates VIN, retains exact bytes, prevents unmatched retention and compares only same vehicle', async () => {
  const directory = await fs.mkdtemp(path.join(import.meta.dirname, 'test-data-')), store = new LocalStore(directory), business = new Business(store), service = new DoveService(business)
  const actor = { id: 'member', name: 'Member', role: 'member' as const, deviceId: store.deviceId }
  try {
    const bytes = await sampleWorkbook(), parsed = await parseDove(bytes)
    assert.equal(parsed.controllers[0].serial, '000123'); assert.equal(parsed.faults.length, 1); assert.equal(parsed.soc, 80)
    const unmatched = await service.preview(bytes, 'unmatched.xlsx', 'member')
    await assert.rejects(service.save(unmatched.id, 'member', actor), { code: 'VIN_NOT_MATCHED' })
    const car = business.write({ kind: 'vehicle', data: { name: 'Vehicle', vin: parsed.vin, status: 'available' }, actor, reason: 'Register' })
    await assert.rejects(service.save(unmatched.id, 'member', actor), { code: 'IMPORT_CONFIRMATION_REQUIRED' })
    assert.equal(business.list('report').length, 0)
    assert.equal(business.list('part').length, 0)
    const first = await service.save(unmatched.id, 'member', actor, { confirmed: true })
    assert.equal(first.vehicleId, car.id); assert.deepEqual(await business.readBlob(String(first.data.checksum)), bytes)
    assert.equal(business.list('part', car.id).length, 1)
    assert.equal(business.list('part', car.id)[0].data.name, 'VCU')
    assert.equal(business.list('part', car.id)[0].data.description, 'Vehicle control')
    assert.equal(business.list('part', car.id)[0].data.software, '1.0')
    const repeated = await service.preview(bytes, 'renamed.xlsx', 'member')
    assert.equal(repeated.existingId, first.id)
    assert.equal((await service.save(repeated.id, 'member', actor, { confirmed: true })).id, first.id)
    const secondDraft = await service.preview(await sampleWorkbook(parsed.vin, '2.0'), 'second.xlsx', 'member')
    const second = await service.save(secondDraft.id, 'member', actor, { confirmed: true })
    assert.equal(business.list('part', car.id).length, 1)
    assert.equal(business.list('part', car.id)[0].data.software, '2.0')
    assert.equal(compareReports(first, second).controllers[0].status, 'changed')
    const aliasReport = (name: string) => ({ ...first, data: { ...first.data, parsed: { ...parsed, controllers: [{ ...parsed.controllers[0], name }] } } })
    const aliasComparison = compareReports(aliasReport('MSB'), aliasReport('bms'))
    assert.equal(aliasComparison.controllers.length, 1)
    assert.equal(aliasComparison.controllers[0].key, 'BMS/MSB|CAN UDS')
    assert.equal(aliasComparison.controllers[0].status, 'unchanged')
    assert.throws(() => compareReports(first, { ...second, vehicleId: 'different' }), { code: 'REPORT_VIN_MISMATCH' })
    const wrong = new ExcelJS.Workbook(); wrong.addWorksheet('Other')
    await assert.rejects(parseDove(Buffer.from(await wrong.xlsx.writeBuffer())), /UNSUPPORTED_REPORT/)
    const inconsistent = new ExcelJS.Workbook(); inconsistent.addWorksheet('DOVE').addRow(['Vin :', parsed.vin]); inconsistent.addWorksheet('Identification').getCell('A5').value = 'Vin : TEST0000000000002'; inconsistent.addWorksheet('Defauts')
    await assert.rejects(parseDove(Buffer.from(await inconsistent.xlsx.writeBuffer())), /VIN_MISMATCH/)
    assert.equal(business.get(car.id).data.software, undefined)
    const changing = await service.preview(await sampleWorkbook(parsed.vin, '3.0'), 'concurrent.xlsx', 'member')
    const originalBlob = business.blob.bind(business)
    business.blob = async bytes => {
      const key = await originalBlob(bytes)
      const current = business.get(car.id)
      business.write({ id: car.id, kind: 'vehicle', data: { ...current.data, vin: 'TEST0000000000009' }, version: current.version, actor, reason: 'VIN changed during file persistence' })
      return key
    }
    await assert.rejects(service.save(changing.id, 'member', actor, { confirmed: true }), { code: 'VIN_NOT_MATCHED' })
    business.blob = originalBlob
  } finally { store.db.close(); await fs.rm(directory, { recursive: true, force: true }) }
})

test('DOVE retention fills exactly three controllers, preserves missing and invalid values, and defers conflicting aliases', async () => {
  const directory = await fs.mkdtemp(path.join(import.meta.dirname, 'test-data-')), store = new LocalStore(directory), business = new Business(store), service = new DoveService(business)
  const actor = { id: 'member', name: 'Member', role: 'member' as const, deviceId: store.deviceId }
  const vin = 'TEST0000000000001'
  const car = business.write({ kind: 'vehicle', data: { vin, status: 'available' }, actor, reason: 'Register' })
  async function retain(names: string[], software: string, date: string, options: Partial<DoveImportConfirmation> = {}) {
    const book = new ExcelJS.Workbook()
    book.addWorksheet('DOVE').addRows([['Vin :', vin], ['Date of record', date]])
    const sheet = book.addWorksheet('Identification')
    sheet.addRow(['ECU', 'Description', 'Network', 'Supplier'])
    for (const name of names) sheet.addRow([name, `${name} description`, 'CAN UDS', 'Supplier', 'FN', 'PN', software, '', 'CAL', '0.00', '21/06/26', '', '29/03/26', '000123'])
    book.addWorksheet('Defauts')
    const draft = await service.preview(Buffer.from(await book.xlsx.writeBuffer()), 'controllers.xlsx', actor.id)
    return service.save(draft.id, actor.id, actor, { ...options, confirmed: true })
  }
  try {
    const first = await retain(['VCU', 'MCU', 'MSB'], '1.0', '2026-10-21 18h34')
    assert.deepEqual(business.list('part', car.id).map(part => part.data.name).sort(), ['BMS/MSB', 'MCU', 'VCU'])
    for (const part of business.list('part', car.id)) {
      assert.equal(part.data.reportId, first.id)
      assert.equal(part.data.serial, '000123')
      assert.equal(part.data.calibrationVersion, '0.00')
      assert.ok(business.history(car.id).some(change => change.recordId === part.id && change.sourceId === first.id))
    }
    const battery = business.list('part', car.id).find(part => part.data.name === 'BMS/MSB')!
    const second = await retain(['BMS'], '2.0', '2026-10-22 18h34')
    assert.equal(business.list('part', car.id).length, 3)
    assert.equal(business.get(battery.id).data.software, '2.0')
    assert.equal(business.get(battery.id).data.reportId, second.id)
    assert.equal(business.list('part', car.id).find(part => part.data.name === 'MCU')!.data.software, '1.0')
    await retain(['MSB'], 'invalide', '2026-10-23 18h34')
    assert.equal(business.get(battery.id).data.software, '2.0')
    const current = business.get(battery.id)
    await assert.rejects(retain(['BMS', 'MSB'], '3.0', '2026-10-24 18h34'), { code: 'IMPORT_SOURCE_REQUIRED' })
    await retain(['BMS', 'MSB'], '3.0', '2026-10-24 18h34', { reportOnly: true })
    assert.deepEqual(business.get(battery.id), current)
    await assert.rejects(retain(['BMS'], 'old', '2026-10-20 18h34'), { code: 'OLDER_REPORT_CONFIRMATION_REQUIRED' })
    await retain(['BMS'], 'old', '2026-10-20 18h34', { reportOnly: true })
    assert.deepEqual(business.get(battery.id), current)
    const beforeConflict = business.list(), beforeHistory = business.history()
    await assert.rejects(retain(['VCU', 'MCU', 'BMS', 'MSB'], '4.0', '2026-10-25 18h34'), { code: 'IMPORT_SOURCE_REQUIRED' })
    assert.deepEqual(business.list(), beforeConflict)
    assert.deepEqual(business.history(), beforeHistory)
    await retain(['BMS', 'MSB'], '3.0', '2026-10-24 18h34', { selections: { 'BMS/MSB': 1 } })
    assert.equal(business.get(battery.id).data.software, '3.0')
    assert.equal(business.get(battery.id).data.sourceName, 'MSB')
    await retain(['BMS'], 'older-confirmed', '2026-10-20 18h34', { allowOlder: true })
    assert.equal(business.get(battery.id).data.software, 'older-confirmed')
    assert.throws(() => business.write({ kind: 'part', vehicleId: car.id, data: { name: 'MSB', category: 'controller' }, actor, reason: 'Duplicate' }), { code: 'CONTROLLER_EXISTS' })
  } finally { store.db.close(); await fs.rm(directory, { recursive: true, force: true }) }
})

for (const [name, expected] of [
  ['DOVE_D85_02329_FDB_BSample_eP64_Cal_AftTest_DTC_Set__24.07.2026_17.46.01s.xlsx', [54, 89]],
  ['DOVE_eP64_51187_CATL_POCSample_Itr04_BfrClr__29.07.2026_18.34.01s.xlsx', [39, 56]],
] as const) {
  const filename = path.join(process.env.USERPROFILE || '', 'Desktop', name)
  test(`known DOVE template ${expected.join('/')}`, { skip: !existsSync(filename) }, async () => {
    const bytes = await fs.readFile(filename)
    const report = await parseDove(bytes); assert.equal(report.controllers.length, expected[0]); assert.equal(report.faults.length, expected[1])
    const directory = await fs.mkdtemp(path.join(import.meta.dirname, 'test-data-')), store = new LocalStore(directory)
    try {
      const isolated = await new DoveService(new Business(store)).preview(bytes, 'known-template.xlsx', 'test-user')
      assert.equal(isolated.parsed.controllers.length, expected[0]); assert.equal(isolated.parsed.faults.length, expected[1]); assert.equal(isolated.match, 'unmatched')
    } finally { store.db.close(); await fs.rm(directory, { recursive: true, force: true }) }
  })
}