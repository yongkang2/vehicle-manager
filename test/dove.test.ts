import { test } from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs, existsSync } from 'node:fs'
import path from 'node:path'
import ExcelJS from 'exceljs'
import { parseDove } from '../server/dove-parser.js'
import { DoveService, compareReports } from '../server/dove.js'
import { Business } from '../server/business.js'
import { LocalStore } from '../server/store.js'

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
    const first = await service.save(unmatched.id, 'member', actor)
    assert.equal(first.vehicleId, car.id); assert.deepEqual(await business.readBlob(String(first.data.checksum)), bytes)
    const repeated = await service.preview(bytes, 'renamed.xlsx', 'member')
    assert.equal(repeated.existingId, first.id)
    assert.equal((await service.save(repeated.id, 'member', actor)).id, first.id)
    const secondDraft = await service.preview(await sampleWorkbook(parsed.vin, '2.0'), 'second.xlsx', 'member')
    const second = await service.save(secondDraft.id, 'member', actor)
    assert.equal(compareReports(first, second).controllers[0].status, 'changed')
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
    await assert.rejects(service.save(changing.id, 'member', actor), { code: 'VIN_NOT_MATCHED' })
    business.blob = originalBlob
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