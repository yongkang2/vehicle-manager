import { test } from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Business, normalizeFields } from '../server/business.js'
import { createApp } from '../server/app.js'
import { createBackup, restoreBackup } from '../server/backup.js'
import { LocalStore } from '../server/store.js'
import { thermalSystemTypes, vehicleFields } from '../shared/business.js'
import type { Actor, BusinessRecord } from '../shared/business.js'
import { translateBusiness } from '../src/business-i18n.js'

const base = { vin: 'TEST0000000000001', status: 'available' }

test('vehicle fields replace cooling architecture with the bilingual thermal type choices', () => {
  assert.equal(vehicleFields.includes('thermal'), true)
  assert.equal(vehicleFields.some(field => String(field) === 'coolingArchitecture'), false)
  assert.deepEqual(thermalSystemTypes, ['Indirect Heat Pump', 'Direct Heat Pump', 'No Heat Pump'])
  const english = translateBusiness('en'), chinese = translateBusiness('zh')
  assert.equal(english('thermal'), 'Thermal System Type')
  assert.equal(chinese('thermal'), '热管理系统类型')
  for (const value of thermalSystemTypes) {
    const data = normalizeFields('vehicle', { ...base, thermal: `  ${value}  `, coolingArchitecture: 'INDIRECT HEAT PUMP' })
    assert.equal(data.thermal, value)
    assert.equal(data.coolingArchitecture, 'INDIRECT HEAT PUMP')
    assert.equal(english(value), value)
    assert.notEqual(chinese(value), value)
  }
  assert.equal(normalizeFields('vehicle', base).thermal, '')
  assert.equal(normalizeFields('vehicle', { ...base, thermal: undefined }).thermal, '')
  assert.equal(normalizeFields('vehicle', { ...base, thermal: '  ' }).thermal, '')
  assert.equal(normalizeFields('vehicle', { ...base, thermal: 'Legacy thermal notes' }).thermal, 'Legacy thermal notes')
  for (const thermal of [123, [], {}, 'x'.repeat(4001)]) assert.throws(() => normalizeFields('vehicle', { ...base, thermal }), { code: 'INVALID_INPUT' })
})

test('thermal choices can be created, edited, cleared and reopened with history and version checks intact', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'vehicle-thermal-business-'))
  let store = new LocalStore(directory), business = new Business(store)
  const actor: Actor = { id: 'admin', name: 'Thermal tester', role: 'admin', deviceId: store.deviceId }
  try {
    let car = business.write({ kind: 'vehicle', data: base, actor, reason: 'Register with no thermal type' })
    assert.equal(car.data.thermal, '')
    for (const thermal of thermalSystemTypes) {
      const previous = car
      assert.throws(() => business.write({ id: car.id, kind: 'vehicle', data: { ...car.data, thermal }, version: car.version - 1, actor, reason: 'Stale thermal update' }), { code: 'VERSION_CONFLICT' })
      car = business.write({ id: car.id, kind: 'vehicle', data: { ...car.data, thermal }, version: car.version, actor, reason: `Set ${thermal}` })
      const change = business.history(car.id).find(change => change.reason === `Set ${thermal}`)!
      assert.equal(change.before!.thermal, previous.data.thermal)
      assert.equal(change.after.thermal, thermal)
      assert.equal(business.get(car.id).data.thermal, thermal)
    }
    assert.throws(() => business.write({ id: car.id, kind: 'vehicle', data: { ...car.data, thermal: '' }, version: car.version, actor, reason: ' ' }), { code: 'REASON_REQUIRED' })
    car = business.write({ id: car.id, kind: 'vehicle', data: { ...car.data, thermal: undefined }, version: car.version, actor, reason: 'Clear thermal type' })
    assert.equal(car.data.thermal, '')
    store.db.close(); store = new LocalStore(directory); business = new Business(store)
    assert.equal(business.get(car.id).data.thermal, '')
    assert.equal(business.history(car.id).length, 5)
    assert.equal(store.db.prepare('PRAGMA integrity_check').get()!.integrity_check, 'ok')
  } finally { store.db.close(); await fs.rm(directory, { recursive: true, force: true }) }
})

test('legacy thermal text survives an unrelated edit and backup restore without rewriting history', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'vehicle-thermal-backup-'))
  const stores = ['source', 'restore'].map(name => new LocalStore(path.join(directory, name)))
  const [source, restored] = stores.map(store => new Business(store))
  const actor: Actor = { id: 'admin', name: 'Thermal tester', role: 'admin', deviceId: stores[0].deviceId }
  try {
    const legacy = source.write({ kind: 'vehicle', data: { ...normalizeFields('vehicle', base), coolingArchitecture: 'WITHOUT HEAT PUMP', thermal: 'Legacy thermal notes' }, actor, reason: 'Legacy vehicle', internal: true })
    assert.equal(source.get(legacy.id).data.coolingArchitecture, 'WITHOUT HEAT PUMP')
    const edited = source.write({ id: legacy.id, kind: 'vehicle', data: { ...legacy.data, owner: 'New owner', coolingArchitecture: 'Changed by ordinary editor' }, version: legacy.version, actor, reason: 'Change owner only' })
    assert.equal(edited.data.thermal, 'Legacy thermal notes')
    assert.equal(edited.data.coolingArchitecture, 'WITHOUT HEAT PUMP')
    assert.equal(source.history(legacy.id).find(change => change.reason === 'Legacy vehicle')!.after.coolingArchitecture, 'WITHOUT HEAT PUMP')
    const bytes = await createBackup(source, 'thermal-test-team')
    assert.equal((await restoreBackup(restored, bytes, 'thermal-test-team', { ...actor, deviceId: stores[1].deviceId }, 'Restore thermal data')).changed, 1)
    assert.equal(restored.get(legacy.id).data.thermal, 'Legacy thermal notes')
    assert.equal(restored.get(legacy.id).data.owner, 'New owner')
    assert.equal(restored.get(legacy.id).data.coolingArchitecture, 'WITHOUT HEAT PUMP')
    assert.ok(restored.history(legacy.id).some(change => change.after.coolingArchitecture === 'WITHOUT HEAT PUMP'))
    const updated = restored.write({ id: legacy.id, kind: 'vehicle', data: { ...restored.get(legacy.id).data, thermal: 'Direct Heat Pump' }, version: restored.get(legacy.id).version, actor, reason: 'Select new thermal type' })
    assert.equal(updated.data.thermal, 'Direct Heat Pump')
  } finally { for (const store of stores) store.db.close(); await fs.rm(directory, { recursive: true, force: true }) }
})

test('vehicle APIs save each thermal type, preserve legacy cooling architecture and export the current selection', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'vehicle-thermal-api-')), shared = path.join(directory, 'shared')
  await fs.mkdir(shared)
  const services = createApp({ dataDir: path.join(directory, 'local') }), server = services.app.listen(0, '127.0.0.1')
  if (!server.listening) await once(server, 'listening')
  const origin = 'http://127.0.0.1:' + (server.address() as { port: number }).port
  let cookie = '', workspaceToken = ''
  async function request(endpoint: string, method = 'GET', body?: unknown) {
    const response = await fetch(origin + '/api' + endpoint, { method, headers: { Cookie: cookie, 'X-App-Request': 'vehicle-manager', 'X-Workspace-Token': workspaceToken, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined })
    const nextCookie = response.headers.get('set-cookie')
    if (nextCookie) cookie = nextCookie.split(';')[0]
    if (response.ok) workspaceToken = response.headers.get('x-workspace-token') || workspaceToken
    const data = await response.json()
    await services.synchronization.settle()
    return { status: response.status, data }
  }
  try {
    assert.equal((await request('/register', 'POST', { username: 'thermal-user', displayName: 'Thermal tester', password: 'thermal-test-password' })).status, 201)
    assert.equal((await request('/setup/configure', 'POST', { path: shared, mode: 'create', teamName: 'Thermal test team', confirmed: true })).status, 200)
    for (const [index, thermal] of thermalSystemTypes.entries()) {
      const created = await request('/business/records', 'POST', { kind: 'vehicle', data: { ...base, vin: `TEST000000000000${index + 1}`, complianceLevel: 'Eu7', thermal, coolingArchitecture: 'INDIRECT HEAT PUMP' }, reason: 'Register thermal type' })
      assert.equal(created.status, 201)
      const car = created.data as BusinessRecord
      assert.equal(car.data.thermal, thermal)
      assert.equal(car.data.coolingArchitecture, 'INDIRECT HEAT PUMP')
      const cleared = await request('/business/records/' + car.id, 'PUT', { data: { ...car.data, thermal: '' }, version: car.version, reason: 'Clear thermal type' })
      assert.equal(cleared.status, 200); assert.equal(cleared.data.data.thermal, ''); assert.equal(cleared.data.data.coolingArchitecture, 'INDIRECT HEAT PUMP')
    }
    const car = (await request('/business/records')).data[0] as BusinessRecord
    const updated = await request('/business/records/' + car.id, 'PUT', { data: { ...car.data, thermal: 'Direct Heat Pump' }, version: car.version, reason: 'Select direct heat pump' })
    assert.equal(updated.status, 200)
    const exported = await request('/business/export')
    assert.equal(exported.status, 200)
    assert.equal(exported.data.records.find((record: BusinessRecord) => record.id === car.id).data.thermal, 'Direct Heat Pump')
    assert.equal(exported.data.records.find((record: BusinessRecord) => record.id === car.id).data.coolingArchitecture, 'INDIRECT HEAT PUMP')
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()))
    await services.close()
    await fs.rm(directory, { recursive: true, force: true })
  }
})
