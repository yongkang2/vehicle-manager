import { test } from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import unzipper from 'unzipper'
import { Business, normalizeFields } from '../server/business.js'
import { createBackup, restoreBackup } from '../server/backup.js'
import { buildCsvExport } from '../server/csv-export.js'
import { LocalStore } from '../server/store.js'
import { activeHvBatteries, batteryFields, partFields, vehicleHvBatteries } from '../shared/business.js'
import type { Actor, BusinessRecord, Fields } from '../shared/business.js'
import { defaultExportConfiguration, exportColumns } from '../shared/csv-export.js'
import { translateBusiness } from '../src/business-i18n.js'

const carData = { vin: 'TEST0000000000001', status: 'available' }
const batteryData = { name: 'HV Battery', category: 'battery', productPart: 'P001234', serial: '0000123', maturity: 'B1' }
const battery = (id: string, data: Fields = {}, options: Partial<BusinessRecord> = {}): BusinessRecord => ({ id, kind: 'part', vehicleId: 'vehicle', data: { ...batteryData, ...data }, archived: false, version: 1, updated: '2026-10-23T00:00:00.000Z', ...options })

test('HV Battery uses existing battery part fields and has bilingual labels independent from controller labels', () => {
  assert.deepEqual(batteryFields, ['productPart', 'serial', 'maturity'])
  for (const field of batteryFields) assert(partFields.includes(field))
  const english = translateBusiness('en'), chinese = translateBusiness('zh')
  assert.equal(english('part'), 'Controller')
  assert.equal(english('parts'), 'Controllers')
  assert.equal(english('addPart'), 'Add controller')
  assert.equal(chinese('part'), '控制器')
  assert.equal(chinese('addPart'), '新增控制器')
  const labels = { hvBattery: 'HV Battery', partNumber: 'Part Number', serialNumber: 'Serial Number', partMaturityLevel: 'Part Maturity Level', hvBatteryMaturityLevel: 'HV Battery Maturity Level' }
  for (const [key, label] of Object.entries(labels)) {
    assert.equal(english(key), label)
    assert.notEqual(chinese(key), key)
    assert.notEqual(chinese(key), label)
    assert.match(chinese(key), /[\u3400-\u9fff]/)
  }
})

test('battery selectors preserve multiple legacy batteries, retain removed history and never mix vehicles or controllers', () => {
  const records = [
    battery('b', { maturity: 'B1' }),
    battery('removed', { maturity: 'A1', removedAt: '2026-10-22' }),
    battery('archived', { maturity: 'A0' }, { archived: true }),
    battery('a', { maturity: 'B2', removedAt: '' }),
    battery('latest', { maturity: 'C1' }, { updated: '2026-10-23T01:00:00.000Z' }),
    battery('legacy-blank-removal', { removedAt: '  ' }),
    battery('other-vehicle', {}, { vehicleId: 'another-vehicle' }),
    battery('bms-controller', { category: 'controller', name: 'BMS/MSB', maturity: 'not a battery' }),
    battery('motor', { category: 'motor' }),
    battery('wrong-kind', {}, { kind: 'equipment' }),
  ]
  const originalOrder = records.map(record => record.id)
  assert.deepEqual(vehicleHvBatteries(records, 'vehicle').map(record => record.id), ['latest', 'a', 'b', 'legacy-blank-removal', 'removed'])
  assert.deepEqual(activeHvBatteries(records, 'vehicle').map(record => record.id), ['latest', 'a', 'b', 'legacy-blank-removal'])
  assert.deepEqual(vehicleHvBatteries(records, 'vehicle', true).map(record => record.id), ['latest', 'a', 'archived', 'b', 'legacy-blank-removal', 'removed'])
  assert.deepEqual(activeHvBatteries(records, 'another-vehicle').map(record => record.id), ['other-vehicle'])
  assert.deepEqual(activeHvBatteries(records, 'empty-vehicle'), [])
  assert.deepEqual(records.map(record => record.id), originalOrder)
  assert.deepEqual(activeHvBatteries([...records].reverse(), 'vehicle'), activeHvBatteries(records, 'vehicle'))
})

test('battery number, serial and maturity inherit trimming, blank handling and the 4000-character limit', () => {
  for (const field of batteryFields) {
    assert.equal(normalizeFields('part', { ...batteryData, [field]: '  0000123  ' })[field], '0000123')
    assert.equal(normalizeFields('part', { ...batteryData, [field]: '   ' })[field], '')
    assert.equal(normalizeFields('part', { ...batteryData, [field]: undefined })[field], '')
    assert.equal(normalizeFields('part', { ...batteryData, [field]: 'x'.repeat(4000) })[field], 'x'.repeat(4000))
    for (const invalid of ['x'.repeat(4001), 123, [], {}]) assert.throws(() => normalizeFields('part', { ...batteryData, [field]: invalid }), { code: 'INVALID_INPUT' })
  }
})

test('ordinary members can create, update and clear battery details with reason/version checks and durable history', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'vehicle-hv-battery-business-'))
  let store = new LocalStore(directory), business = new Business(store)
  const actor: Actor = { id: 'member', name: 'Battery tester', deviceId: store.deviceId, role: 'member' }
  try {
    const car = business.write({ kind: 'vehicle', data: carData, actor, reason: 'Register test vehicle' })
    let pack = business.write({ kind: 'part', vehicleId: car.id, data: { ...batteryData, productPart: '  P001234  ', serial: '  0000123  ', maturity: '  B1  ' }, actor, reason: 'Install battery' })
    assert.equal(pack.data.productPart, 'P001234')
    assert.equal(pack.data.serial, '0000123')
    assert.equal(pack.data.maturity, 'B1')
    assert.equal(activeHvBatteries(business.list(), car.id)[0].id, pack.id)
    assert.throws(() => business.write({ id: pack.id, kind: 'part', vehicleId: car.id, data: { ...pack.data, maturity: 'B2' }, version: 0, actor, reason: 'Stale maturity update' }), { code: 'VERSION_CONFLICT' })
    assert.throws(() => business.write({ id: pack.id, kind: 'part', vehicleId: car.id, data: { ...pack.data, maturity: 'B2' }, version: pack.version, actor, reason: ' ' }), { code: 'REASON_REQUIRED' })
    assert.equal(business.history(car.id).length, 2)
    pack = business.write({ id: pack.id, kind: 'part', vehicleId: car.id, data: { ...pack.data, maturity: '  B2  ' }, version: pack.version, actor, reason: 'Update battery maturity' })
    const change = business.history(car.id).find(change => change.reason === 'Update battery maturity')!
    assert.equal(change.before!.maturity, 'B1')
    assert.equal(change.after.maturity, 'B2')
    assert.equal(change.actor.id, actor.id)
    const operation = JSON.parse(store.db.prepare('SELECT payload FROM outbox ORDER BY seq DESC LIMIT 1').get()!.payload as string)
    assert.equal(operation.desired.data.maturity, 'B2')
    assert.equal(operation.desired.data.serial, '0000123')
    assert.equal(activeHvBatteries(business.list(), car.id)[0].data.maturity, 'B2')
    pack = business.write({ id: pack.id, kind: 'part', vehicleId: car.id, data: { ...pack.data, productPart: '', serial: '', maturity: '' }, version: pack.version, actor, reason: 'Clear unknown battery details' })
    const second = business.write({ kind: 'part', vehicleId: car.id, data: { ...batteryData, name: 'Legacy second battery', maturity: 'C1' }, actor, reason: 'Preserve second installed battery' })
    assert.equal(activeHvBatteries(business.list(), car.id).length, 2)
    assert.equal(business.get(car.id).data.hvBatteryMaturityLevel, undefined)
    store.db.close(); store = new LocalStore(directory); business = new Business(store)
    assert.equal(business.get(pack.id).data.maturity, '')
    assert.equal(business.get(pack.id).data.productPart, '')
    assert.equal(business.get(pack.id).data.serial, '')
    assert.equal(business.get(second.id).data.maturity, 'C1')
    assert.equal(business.history(car.id).length, 5)
    assert.equal(store.db.prepare('PRAGMA integrity_check').get()!.integrity_check, 'ok')
  } finally { store.db.close(); await fs.rm(directory, { recursive: true, force: true }) }
})

test('removed/archived battery state updates the live vehicle projection without deleting legacy records', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'vehicle-hv-battery-lifecycle-'))
  const store = new LocalStore(directory), business = new Business(store)
  const actor: Actor = { id: 'member', name: 'Battery tester', deviceId: store.deviceId, role: 'member' }, admin: Actor = { ...actor, id: 'admin', role: 'admin' }
  try {
    const car = business.write({ kind: 'vehicle', data: carData, actor, reason: 'Register test vehicle' })
    let pack = business.write({ kind: 'part', vehicleId: car.id, data: batteryData, actor, reason: 'Install battery' })
    const otherPack = business.write({ kind: 'part', vehicleId: car.id, data: { ...batteryData, name: 'Spare battery', maturity: 'B2' }, actor, reason: 'Register second battery' })
    pack = business.write({ id: pack.id, kind: 'part', vehicleId: car.id, data: { ...pack.data, removedAt: '2026-10-23' }, version: pack.version, actor, reason: 'Remove original battery' })
    assert.deepEqual(activeHvBatteries(business.list(), car.id).map(record => record.id), [otherPack.id])
    assert.equal(vehicleHvBatteries(business.list(), car.id).length, 2)
    assert.throws(() => business.write({ id: otherPack.id, kind: 'part', vehicleId: car.id, data: otherPack.data, archived: true, version: otherPack.version, actor, reason: 'Unauthorized archive' }), { code: 'ADMIN_REQUIRED' })
    const archived = business.write({ id: otherPack.id, kind: 'part', vehicleId: car.id, data: otherPack.data, archived: true, version: otherPack.version, actor: admin, reason: 'Archive spare battery' })
    assert.deepEqual(activeHvBatteries(business.list(), car.id), [])
    assert.equal(vehicleHvBatteries(business.list(), car.id).length, 1)
    assert.equal(vehicleHvBatteries(business.list(), car.id, true).length, 2)
    business.write({ id: archived.id, kind: 'part', vehicleId: car.id, data: archived.data, archived: false, version: archived.version, actor: admin, reason: 'Restore spare battery' })
    assert.equal(activeHvBatteries(business.list(), car.id)[0].data.maturity, 'B2')
    assert.equal(business.get(pack.id).data.removedAt, '2026-10-23')
  } finally { store.db.close(); await fs.rm(directory, { recursive: true, force: true }) }
})

test('existing battery identity and fields survive backup restoration and CSV export without migration', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'vehicle-hv-battery-backup-'))
  const stores = ['source', 'restored'].map(name => new LocalStore(path.join(directory, name)))
  const [source, restored] = stores.map(store => new Business(store))
  const actor: Actor = { id: 'admin', name: 'Battery tester', deviceId: stores[0].deviceId, role: 'admin' }
  try {
    const car = source.write({ kind: 'vehicle', data: carData, actor, reason: 'Register test vehicle' })
    const legacyBattery = source.write({ kind: 'part', vehicleId: car.id, data: { ...batteryData, name: 'Original battery', supplier: 'Demo supplier', batteryStatus: 'healthy', position: 'Underfloor', notes: 'Existing data must remain intact' }, actor, reason: 'Legacy battery installed' })
    const bytes = await createBackup(source, 'battery-test-team')
    const archive = await unzipper.Open.buffer(bytes)
    const manifest = JSON.parse((await archive.files.find(file => file.path === 'manifest.json')!.buffer()).toString())
    const saved = manifest.records.find((record: BusinessRecord) => record.id === legacyBattery.id)
    assert.equal(saved.kind, 'part')
    assert.deepEqual(saved.data, legacyBattery.data)
    assert.equal(manifest.changes.find((change: { recordId: string }) => change.recordId === legacyBattery.id).after.maturity, 'B1')
    assert.equal(manifest.pendingOperations.find((operation: { recordId: string }) => operation.recordId === legacyBattery.id).desired.data.serial, '0000123')
    assert.equal((await restoreBackup(restored, bytes, 'battery-test-team', { ...actor, deviceId: stores[1].deviceId }, 'Restore existing batteries')).changed, 2)
    assert.deepEqual(restored.get(legacyBattery.id).data, legacyBattery.data)
    assert.equal(activeHvBatteries(restored.list(), car.id)[0].id, legacyBattery.id)
    assert.ok(restored.history(car.id).some(change => change.id === source.history(car.id).find(change => change.recordId === legacyBattery.id)!.id))
    for (const language of ['en', 'zh'] as const) {
      const configuration = { ...defaultExportConfiguration(language), columns: { part: ['id', 'vehicleId', 'category', ...batteryFields, 'batteryStatus', 'supplier'] } }
      const exported = await buildCsvExport(restored.list(), { vehicleIds: [car.id], configuration })
      assert.equal(exported.counts.part, 1)
      const zip = await unzipper.Open.buffer(exported.bytes)
      const csv = (await zip.files.find(file => file.path === 'parts-controllers.csv')!.buffer()).toString('utf8')
      const headers = configuration.columns.part.map(id => exportColumns.part.find(column => column.id === id)!.label[language === 'zh' ? 1 : 0])
      assert.equal(csv, '\ufeff' + headers.join(',') + '\r\n' + [legacyBattery.id, car.id, 'battery', 'P001234', '0000123', 'B1', 'healthy', 'Demo supplier'].join(',') + '\r\n')
    }
    assert.equal(stores[1].db.prepare('PRAGMA integrity_check').get()!.integrity_check, 'ok')
  } finally { for (const store of stores) store.db.close(); await fs.rm(directory, { recursive: true, force: true }) }
})
