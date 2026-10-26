import { test } from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ZipArchive } from 'archiver'
import unzipper from 'unzipper'
import ExcelJS from 'exceljs'
import { Business, normalizeFields, validateManualPartFields } from '../server/business.js'
import { LocalStore } from '../server/store.js'
import { DoveService } from '../server/dove.js'
import { createBackup, restoreBackup } from '../server/backup.js'
import { buildCsvExport } from '../server/csv-export.js'
import { batteryFields, batteryLifeStatuses, configurationFields, controllerEditFields, controllerFields, controllerTypes, partFields } from '../shared/business.js'
import type { Actor, Fields } from '../shared/business.js'
import { defaultExportConfiguration, exportColumns } from '../shared/csv-export.js'

const carData = { vin: 'TEST0000000000001', status: 'available' }
const controllerData = { name: 'VCU', category: 'controller', type: 'ETK' }, batteryData = { name: 'HV Battery', category: 'battery', batteryStatus: 'healthy' }
export async function metadataWorkbook(vin = carData.vin, software = '2.0') {
  const book = new ExcelJS.Workbook()
  book.addWorksheet('DOVE').addRows([['Vin :', vin], ['Date of record', '2026-10-26'], ['Vehicle milage', '1234 km']])
  book.addWorksheet('Identification').addRows([['ECU', 'Description', 'Network', 'Supplier'], ['EVCU', 'Synthetic controller', 'CAN UDS', 'Demo supplier', 'FN', 'PN', software, '', 'CAL', '2', '', '', '', '000123']])
  book.addWorksheet('Defauts').addRow(['EVCU', '', 'CAN UDS', 'P123456 (2Fh - Permanent) Synthetic fault'])
  return Buffer.from(await book.xlsx.writeBuffer())
}
async function fixture() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'vehicle-part-metadata-')), stores = ['source', 'target'].map(name => new LocalStore(path.join(directory, name)))
  const [source, target] = stores.map(store => new Business(store)), actor: Actor = { id: 'admin', name: 'Metadata tester', role: 'admin', deviceId: stores[0].deviceId }
  return { source, target, actor, stores, async close() { for (const store of stores) store.db.close(); await fs.rm(directory, { recursive: true, force: true }) } }
}
function legacy(data: Fields) { const copy = { ...data }; delete copy.controllerType; delete copy.lifeStatus; return copy }

test('manual classification catalogs are separate from the twelve DOVE observations and legacy fields', () => {
  assert.deepEqual(controllerTypes, ['Open ECU', 'Close ECU'])
  assert.deepEqual(batteryLifeStatuses, ['BOL', '2Y Aged', '8Y Aged', '10Y Aged', '15Y Aged', 'EOL'])
  assert.deepEqual(controllerEditFields, ['name', 'controllerType', ...controllerFields.filter(field => field !== 'name')])
  assert.equal(controllerFields.length, 12)
  assert(!controllerFields.some(field => String(field) === 'controllerType'))
  assert(!configurationFields.some(field => ['controllerType', 'lifeStatus'].includes(field)))
  assert.equal(batteryFields.at(-1), 'lifeStatus')
  for (const field of ['type', 'batteryStatus', 'controllerType', 'lifeStatus']) assert(partFields.some(value => value === field))
})

test('central enum validation trims each allowed option but keeps legacy and imported missing values valid', () => {
  for (const [field, values, data] of [['controllerType', controllerTypes, controllerData], ['lifeStatus', batteryLifeStatuses, batteryData]] as const) {
    for (const value of values) assert.equal(normalizeFields('part', { ...data, [field]: `  ${value}  ` })[field], value)
    for (const value of [undefined, null, '', '   ']) assert.equal(normalizeFields('part', { ...data, [field]: value })[field], '')
    for (const value of [123, false, [], {}, 'invalid', 'x'.repeat(4001)]) assert.throws(() => normalizeFields('part', { ...data, [field]: value }), { code: 'INVALID_INPUT' })
  }
  assert.equal(normalizeFields('part', controllerData).type, 'ETK')
  assert.equal(normalizeFields('part', batteryData).batteryStatus, 'healthy')
  assert.throws(() => validateManualPartFields('part', controllerData), { code: 'CONTROLLER_TYPE_REQUIRED' })
  assert.throws(() => validateManualPartFields('part', batteryData), { code: 'BATTERY_LIFE_STATUS_REQUIRED' })
  assert.doesNotThrow(() => validateManualPartFields('part', { name: 'Motor', category: 'motor' }))
})

test('DOVE configuration updates retain manual classifications and new controllers remain unclassified', async () => {
  const f = await fixture()
  try {
    const car = f.source.write({ kind: 'vehicle', data: carData, actor: f.actor, reason: 'Register fictional vehicle' })
    const part = f.source.write({ kind: 'part', vehicleId: car.id, data: { ...controllerData, controllerType: 'Open ECU', software: '1.0' }, actor: f.actor, reason: 'Classify controller' })
    const battery = f.source.write({ kind: 'part', vehicleId: car.id, data: { ...batteryData, lifeStatus: '8Y Aged' }, actor: f.actor, reason: 'Classify battery' })
    const dove = new DoveService(f.source), draft = await dove.preview(await metadataWorkbook(), 'synthetic.xlsx', f.actor.id)
    await dove.save(draft.id, f.actor.id, f.actor, { confirmed: true })
    assert.equal(f.source.get(part.id).data.controllerType, 'Open ECU')
    assert.equal(f.source.get(part.id).data.type, 'ETK')
    assert.equal(f.source.get(part.id).data.software, '2.0')
    assert.equal(f.source.get(battery.id).data.lifeStatus, '8Y Aged')
    const other = f.source.write({ kind: 'vehicle', data: { ...carData, vin: 'TEST0000000000002' }, actor: f.actor, reason: 'Register second vehicle' })
    const fresh = await dove.preview(await metadataWorkbook(String(other.data.vin)), 'unclassified.xlsx', f.actor.id)
    await dove.save(fresh.id, f.actor.id, f.actor, { confirmed: true })
    assert.equal(f.source.list('part', other.id)[0].data.controllerType, '')
    assert.equal(Object.hasOwn(fresh.parsed.controllers[0], 'controllerType'), false)
  } finally { await f.close() }
})

test('CSV and format 2 backup preserve both classifications, legacy meanings and history', async () => {
  const f = await fixture()
  try {
    const car = f.source.write({ kind: 'vehicle', data: carData, actor: f.actor, reason: 'Register vehicle' })
    const controller = f.source.write({ kind: 'part', vehicleId: car.id, data: { ...controllerData, controllerType: 'Close ECU' }, actor: f.actor, reason: 'Closed production controller' })
    const battery = f.source.write({ kind: 'part', vehicleId: car.id, data: { ...batteryData, lifeStatus: '15Y Aged' }, actor: f.actor, reason: 'Battery life classification' })
    const backup = await createBackup(f.source, 'metadata-team')
    assert.equal((await restoreBackup(f.target, backup, 'metadata-team', f.actor, 'Restore metadata')).changed, 3)
    for (const item of [controller, battery]) assert.deepEqual(f.target.get(item.id).data, item.data)
    assert(f.target.history(car.id).some(change => change.after.controllerType === 'Close ECU'))
    assert(f.target.history(car.id).some(change => change.after.lifeStatus === '15Y Aged'))
    for (const language of ['en', 'zh'] as const) {
      const columns = ['name', 'controllerType', 'lifeStatus', 'type', 'batteryStatus'], configuration = { ...defaultExportConfiguration(language), columns: { part: columns } }
      const exported = await buildCsvExport(f.target.list(), { vehicleIds: [car.id], configuration }), zip = await unzipper.Open.buffer(exported.bytes)
      const csv = (await zip.files.find(file => file.path === 'parts-controllers.csv')!.buffer()).toString('utf8')
      const headers = columns.map(id => exportColumns.part.find(column => column.id === id)!.label[language === 'zh' ? 1 : 0])
      assert(csv.startsWith('\ufeff' + headers.join(',') + '\r\n'))
      assert(csv.includes('VCU,Close ECU,,ETK,\r\n'))
      assert(csv.includes('HV Battery,,15Y Aged,,healthy\r\n'))
    }
  } finally { await f.close() }
})

for (const format of [1, 2]) test(`format ${format} legacy backups without classifications restore missing values without changing legacy fields`, async () => {
  const f = await fixture()
  try {
    const car = f.source.write({ kind: 'vehicle', data: carData, actor: f.actor, reason: 'Legacy vehicle' })
    const controller = f.source.write({ kind: 'part', vehicleId: car.id, data: legacy(normalizeFields('part', controllerData)), actor: f.actor, reason: 'Legacy controller', internal: true })
    const battery = f.source.write({ kind: 'part', vehicleId: car.id, data: legacy(normalizeFields('part', batteryData)), actor: f.actor, reason: 'Legacy battery', internal: true })
    const source = await unzipper.Open.buffer(await createBackup(f.source, 'metadata-team')), archive = new ZipArchive(), chunks: Buffer[] = []
    const complete = new Promise<Buffer>((resolve, reject) => { archive.on('data', chunk => chunks.push(chunk)); archive.once('error', reject); archive.once('end', () => resolve(Buffer.concat(chunks))) })
    for (const entry of source.files) {
      const content = await entry.buffer()
      if (entry.path === 'manifest.json') { const manifest = JSON.parse(content.toString()); manifest.format = format; if (format === 1) { delete manifest.deletions; delete manifest.quarantinedOperations } archive.append(JSON.stringify(manifest), { name: entry.path }) }
      else archive.append(content, { name: entry.path })
    }
    void archive.finalize()
    assert.equal((await restoreBackup(f.target, await complete, 'metadata-team', f.actor, 'Restore old classifications')).changed, 3)
    assert.equal(f.target.get(controller.id).data.controllerType, '')
    assert.equal(f.target.get(controller.id).data.type, 'ETK')
    assert.equal(f.target.get(battery.id).data.lifeStatus, '')
    assert.equal(f.target.get(battery.id).data.batteryStatus, 'healthy')
  } finally { await f.close() }
})
