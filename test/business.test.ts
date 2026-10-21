import { test } from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { LocalStore } from '../server/store.js'
import { Business } from '../server/business.js'
import type { Actor } from '../shared/business.js'

test('business transactions keep history and queue together, validate VIN, support multiple parts and protect archiving', async () => {
  const directory = await fs.mkdtemp(path.join(import.meta.dirname, 'test-data-'))
  const store = new LocalStore(directory), business = new Business(store)
  const actor: Actor = { id: 'member', name: 'Member', role: 'member', deviceId: store.deviceId }
  try {
    assert.equal(business.list().length, 0)
    const car = business.write({ kind: 'vehicle', data: { name: 'Test vehicle', vin: 'TEST0000000000001', status: 'available' }, actor, reason: 'Register vehicle' })
    assert.equal(car.version, 1)
    assert.equal(store.db.prepare('SELECT COUNT(*) AS total FROM changes').get()!.total, 1)
    assert.equal(store.db.prepare('SELECT COUNT(*) AS total FROM outbox').get()!.total, 1)
    assert.throws(() => business.write({ kind: 'vehicle', data: car.data, actor, reason: 'duplicate' }), { code: 'VIN_EXISTS' })
    assert.throws(() => business.write({ id: car.id, kind: 'vehicle', data: { ...car.data, owner: 'Changed' }, version: 0, actor, reason: 'stale edit' }), { code: 'VERSION_CONFLICT' })
    assert.equal(business.history(car.id).length, 1)
    for (const position of ['Front', 'Rear']) business.write({ kind: 'part', vehicleId: car.id, data: { name: 'Motor', category: 'motor', position, serial: '0000123' }, actor, reason: 'Install' })
    assert.equal(business.list('part', car.id).length, 2)
    assert.equal(business.list('part', car.id)[0].data.serial, '0000123')
    assert.throws(() => business.write({ id: car.id, kind: 'vehicle', data: car.data, version: 1, archived: true, actor, reason: 'archive' }), { code: 'ADMIN_REQUIRED' })
    const admin = { ...actor, role: 'admin' as const }
    const archived = business.write({ id: car.id, kind: 'vehicle', data: car.data, version: 1, archived: true, actor: admin, reason: 'Archive' })
    assert.throws(() => business.write({ kind: 'equipment', vehicleId: car.id, data: { name: 'Logger' }, actor, reason: 'Install' }), { code: 'PARENT_ARCHIVED' })
    const restored = business.write({ id: car.id, kind: 'vehicle', data: car.data, version: archived.version, archived: false, actor: admin, reason: 'Restore' })
    assert.equal(restored.archived, false)
    const bytes = Buffer.from('Original attachment')
    const key = await business.blob(bytes)
    assert.deepEqual(await business.readBlob(key), bytes)
    assert.throws(() => business.write({ kind: 'vehicle', data: { name: 'Invalid', vin: 'bad', status: 'available' }, actor, reason: 'invalid' }), { code: 'INVALID_VIN' })
    assert.equal(store.db.prepare('PRAGMA integrity_check').get()!.integrity_check, 'ok')
  } finally { store.db.close(); await fs.rm(directory, { recursive: true, force: true }) }
})