import { test } from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ZipArchive } from 'archiver'
import unzipper from 'unzipper'
import { Business, normalizeFields } from '../server/business.js'
import { createApp } from '../server/app.js'
import { createBackup, restoreBackup } from '../server/backup.js'
import { LocalStore } from '../server/store.js'
import type { Actor, BusinessRecord } from '../shared/business.js'

test('vehicle location is optional, trimmed, validated, editable and recorded without backfilling legacy rows', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vehicle-location-business-'))
  const store = new LocalStore(root), business = new Business(store)
  const actor: Actor = { id: 'member', name: 'Member', deviceId: store.deviceId, role: 'member' }
  const base = { vin: 'TEST0000000000001', status: 'available' }
  try {
    assert.equal(normalizeFields('vehicle', base).physicalLocation, '')
    assert.equal(normalizeFields('vehicle', { ...base, physicalLocation: '   ' }).physicalLocation, '')
    assert.equal(normalizeFields('vehicle', { ...base, physicalLocation: '  Workshop A / Bay 2  ' }).physicalLocation, 'Workshop A / Bay 2')
    assert.equal(String(normalizeFields('vehicle', { ...base, physicalLocation: 'x'.repeat(4000) }).physicalLocation).length, 4000)
    for (const physicalLocation of ['x'.repeat(4001), 123, [], {}]) {
      assert.throws(() => normalizeFields('vehicle', { ...base, physicalLocation }), { code: 'INVALID_INPUT' })
    }
    const car = business.write({ kind: 'vehicle', data: { ...base, physicalLocation: '  Workshop A  ' }, actor, reason: 'Register vehicle location' })
    assert.equal(car.data.physicalLocation, 'Workshop A')
    assert.throws(() => business.write({ id: car.id, kind: 'vehicle', data: { ...car.data, physicalLocation: 'Bay 2' }, version: 0, actor, reason: 'Stale move' }), { code: 'VERSION_CONFLICT' })
    assert.throws(() => business.write({ id: car.id, kind: 'vehicle', data: { ...car.data, physicalLocation: 'Bay 2' }, version: car.version, actor, reason: '  ' }), { code: 'REASON_REQUIRED' })
    const moved = business.write({ id: car.id, kind: 'vehicle', data: { ...car.data, physicalLocation: '  Parking B  ' }, version: car.version, actor, reason: 'Move vehicle' })
    assert.equal(business.get(car.id).data.physicalLocation, 'Parking B')
    const change = business.history(car.id).find(item => item.reason === 'Move vehicle')!
    assert.equal(change.before!.physicalLocation, 'Workshop A')
    assert.equal(change.after.physicalLocation, 'Parking B')
    assert.equal(change.actor.id, actor.id)
    const operation = JSON.parse(store.db.prepare('SELECT payload FROM outbox ORDER BY seq DESC LIMIT 1').get()!.payload as string)
    assert.equal(operation.desired.data.physicalLocation, 'Parking B')
    const cleared = business.write({ id: car.id, kind: 'vehicle', data: { ...moved.data, physicalLocation: '' }, version: moved.version, actor, reason: 'Clear outdated location' })
    assert.equal(cleared.data.physicalLocation, '')

    const legacy = business.write({ kind: 'vehicle', data: { ...base, vin: 'TEST0000000000002' }, actor, reason: 'Legacy fixture' })
    const legacyData = { ...legacy.data }; delete legacyData.physicalLocation
    store.db.prepare('UPDATE records SET data=? WHERE id=?').run(JSON.stringify(legacyData), legacy.id)
    assert.equal(business.get(legacy.id).data.physicalLocation, undefined)
    assert.equal(JSON.parse(store.db.prepare('SELECT data FROM records WHERE id=?').get(legacy.id)!.data as string).physicalLocation, undefined)
    const edited = business.write({ id: legacy.id, kind: 'vehicle', data: { ...legacyData, owner: 'Updated owner' }, version: legacy.version, actor, reason: 'Edit legacy vehicle' })
    assert.equal(edited.data.physicalLocation, '')
    assert.equal(edited.data.owner, 'Updated owner')
    assert.equal(store.db.prepare('PRAGMA integrity_check').get()!.integrity_check, 'ok')
  } finally { store.db.close(); await fs.rm(root, { recursive: true, force: true }) }
})

test('record APIs create, update, clear and export vehicle location with existing access and version checks', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vehicle-location-api-')), shared = path.join(root, 'shared')
  await fs.mkdir(shared)
  const services = createApp({ dataDir: path.join(root, 'local') })
  const server = services.app.listen(0, '127.0.0.1')
  if (!server.listening) await once(server, 'listening')
  const origin = 'http://127.0.0.1:' + (server.address() as { port: number }).port
  let cookie = '', workspaceToken = ''
  async function request(endpoint: string, method = 'GET', body?: unknown, authenticated = true) {
    const response = await fetch(origin + '/api' + endpoint, {
      method, headers: { 'X-App-Request': 'vehicle-manager', 'X-Workspace-Token': workspaceToken, ...(authenticated && cookie ? { Cookie: cookie } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    })
    const nextCookie = response.headers.get('set-cookie')
    if (nextCookie) cookie = nextCookie.split(';')[0]
    if (response.ok) workspaceToken = response.headers.get('x-workspace-token') || workspaceToken
    const data = await response.json()
    await services.synchronization.settle()
    return { status: response.status, data }
  }
  try {
    assert.equal((await request('/register', 'POST', { username: 'location-user', displayName: 'Location tester', password: 'location-test-password' })).status, 201)
    assert.equal((await request('/setup/configure', 'POST', { path: shared, mode: 'create', teamName: 'Location test team', confirmed: true })).status, 200)
    const payload = { kind: 'vehicle', data: { vin: 'TEST0000000000001', status: 'available', physicalLocation: '  Workshop A  ' }, reason: 'Register location' }
    assert.equal((await request('/business/records', 'POST', payload, false)).status, 401)
    const created = await request('/business/records', 'POST', payload)
    assert.equal(created.status, 201); const car = created.data as BusinessRecord
    assert.equal(car.data.physicalLocation, 'Workshop A')
    const blank = await request('/business/records', 'POST', { kind: 'vehicle', data: { vin: 'TEST0000000000002', status: 'available' }, reason: 'Location not yet known' })
    assert.equal(blank.status, 201); assert.equal(blank.data.data.physicalLocation, '')
    assert.equal((await request('/business/records/' + car.id, 'PUT', { data: { ...car.data, physicalLocation: 'Parking B' }, version: 0, reason: 'Stale edit' })).status, 409)
    assert.equal((await request('/business/records/' + car.id, 'PUT', { data: { ...car.data, physicalLocation: 'Parking B' }, version: car.version, reason: '' })).status, 400)
    const moved = await request('/business/records/' + car.id, 'PUT', { data: { ...car.data, physicalLocation: '  Parking B  ' }, version: car.version, reason: 'Move to parking' })
    assert.equal(moved.status, 200); assert.equal(moved.data.data.physicalLocation, 'Parking B')
    const records = await request('/business/records')
    assert.equal(records.data.find((record: BusinessRecord) => record.id === car.id).data.physicalLocation, 'Parking B')
    const exported = await request('/business/export')
    assert.equal(exported.status, 200)
    assert.equal(exported.data.records.find((record: BusinessRecord) => record.id === car.id).data.physicalLocation, 'Parking B')
    const history = await request('/business/history?vehicleId=' + car.id)
    assert.ok(history.data.some((change: { reason: string; after: { physicalLocation?: string } }) => change.reason === 'Move to parking' && change.after.physicalLocation === 'Parking B'))
    const cleared = await request('/business/records/' + car.id, 'PUT', { data: { ...moved.data.data, physicalLocation: '' }, version: moved.data.version, reason: 'Clear location' })
    assert.equal(cleared.status, 200); assert.equal(cleared.data.data.physicalLocation, '')
    assert.equal((await request('/business/records')).data.find((record: BusinessRecord) => record.id === car.id).data.physicalLocation, '')
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()))
    await services.close()
    await fs.rm(root, { recursive: true, force: true })
  }
})

async function zipManifest(manifest: unknown): Promise<Buffer> {
  const archive = new ZipArchive({ zlib: { level: 6 } }), chunks: Buffer[] = []
  const completed = new Promise<Buffer>((resolve, reject) => {
    archive.on('data', (chunk: Buffer) => chunks.push(chunk))
    archive.once('error', reject); archive.once('end', () => resolve(Buffer.concat(chunks)))
  })
  archive.append(JSON.stringify(manifest), { name: 'manifest.json' }); void archive.finalize()
  return completed
}

test('backups preserve vehicle location and pre-location backups restore with blank location', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vehicle-location-backup-'))
  const stores = ['source', 'current-restore', 'legacy-restore'].map(name => new LocalStore(path.join(root, name)))
  const [source, current, legacy] = stores.map(store => new Business(store))
  const actor: Actor = { id: 'admin', name: 'Administrator', deviceId: stores[0].deviceId, role: 'admin' }
  const teamId = 'location-backup-team'
  try {
    const car = source.write({ kind: 'vehicle', data: { vin: 'TEST0000000000001', status: 'available', physicalLocation: 'Test centre / Bay 4' }, actor, reason: 'Register vehicle' })
    const bytes = await createBackup(source, teamId)
    const archive = await unzipper.Open.buffer(bytes)
    const manifest = JSON.parse((await archive.files.find(file => file.path === 'manifest.json')!.buffer()).toString())
    assert.equal(manifest.records[0].data.physicalLocation, 'Test centre / Bay 4')
    assert.equal(manifest.changes[0].after.physicalLocation, 'Test centre / Bay 4')
    assert.equal(manifest.pendingOperations[0].desired.data.physicalLocation, 'Test centre / Bay 4')
    assert.equal((await restoreBackup(current, bytes, teamId, { ...actor, deviceId: stores[1].deviceId }, 'Restore current backup')).changed, 1)
    assert.equal(current.get(car.id).data.physicalLocation, 'Test centre / Bay 4')
    assert.ok(current.history(car.id).some(change => change.after.physicalLocation === 'Test centre / Bay 4'))

    for (const record of manifest.records) delete record.data.physicalLocation
    for (const change of manifest.changes) { if (change.before) delete change.before.physicalLocation; delete change.after.physicalLocation }
    for (const operation of manifest.pendingOperations) {
      if (operation.base) delete operation.base.data.physicalLocation
      delete operation.desired.data.physicalLocation
      for (const change of operation.changes) { if (change.before) delete change.before.physicalLocation; delete change.after.physicalLocation }
    }
    const legacyBytes = await zipManifest(manifest)
    assert.equal((await restoreBackup(legacy, legacyBytes, teamId, { ...actor, deviceId: stores[2].deviceId }, 'Restore pre-location backup')).changed, 1)
    assert.equal(legacy.get(car.id).data.physicalLocation, '')
    assert.equal(legacy.get(car.id).data.vin, car.data.vin)
  } finally { for (const store of stores) store.db.close(); await fs.rm(root, { recursive: true, force: true }) }
})
