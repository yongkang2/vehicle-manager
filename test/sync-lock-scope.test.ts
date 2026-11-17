import { test } from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { LocalStore } from '../server/store.js'
import { Business } from '../server/business.js'
import { BusinessSync } from '../server/sync.js'
import { AppError, TeamDirectory } from '../server/team.js'
import type { Actor } from '../shared/business.js'

async function fixture() {
  const root = await fs.mkdtemp(path.join(import.meta.dirname, 'test-data-refresh-')), shared = path.join(root, 'shared')
  await fs.mkdir(shared)
  const teams = new TeamDirectory()
  const clients = ['admin', 'member'].map(name => {
    const store = new LocalStore(path.join(root, name)), business = new Business(store)
    return { store, business, sync: new BusinessSync(business, teams), identity: { deviceId: store.deviceId, deviceName: name, localUserId: name, displayName: name } }
  })
  const [admin, member] = clients, team = await teams.create(shared, 'Refresh tests', admin.identity)
  const joined = await teams.join(shared, team.id, member.identity)
  const approved = await teams.approve(shared, team.id, admin.identity, joined.requests[0].id, 'member', null, 'Verified member')
  const actors = clients.map((client, index) => ({ id: approved.bindings.find(binding => binding.deviceId === client.store.deviceId)!.memberId, deviceId: client.store.deviceId, name: client.identity.displayName, role: index ? 'member' : 'admin' } as Actor))
  const car = admin.business.write({ kind: 'vehicle', data: { vin: 'TEST0000000000001', name: 'Refresh car', status: 'available' }, actor: actors[0], reason: 'Register' })
  const sync = (index: number, ifChanged = true) => clients[index].sync.synchronize(shared, team.id, clients[index].identity, { ifChanged })
  await sync(0); await sync(1)
  const edit = (index: number, owner: string) => {
    const current = clients[index].business.get(car.id)
    return clients[index].business.write({ id: car.id, kind: 'vehicle', data: { ...current.data, owner }, version: current.version, actor: actors[index], reason: 'Update owner' })
  }
  const close = async () => { for (const client of clients) { await client.sync.settle(); client.store.db.close() }; assert.equal(path.dirname(root), import.meta.dirname); await fs.rm(root, { recursive: true, force: true }) }
  return { root, shared, teams, team, clients, actors, car, sync, edit, close }
}

for (const revoke of [false, true]) test(`local ingestion releases publication lease and preserves originals (revoke=${revoke})`, async t => {
  const f = await fixture(); t.after(f.close)
  const bytes = Buffer.from('immutable original retained across concurrent publication'), key = await f.clients[0].business.blob(bytes)
  f.clients[0].business.write({ kind: 'attachment', vehicleId: f.car.id, data: { name: 'original.txt', checksum: key, size: bytes.length }, actor: f.actors[0], reason: 'Attach', internal: true })
  await f.sync(0)
  f.edit(1, 'Member pending edit')
  let entered!: () => void, release!: () => void
  const enteredIO = new Promise<void>(resolve => { entered = resolve }), gate = new Promise<void>(resolve => { release = resolve })
  const read = fs.readFile.bind(fs)
  const original = path.join(f.shared, 'business', 'blobs', key)
  t.mock.method(fs, 'readFile', async (...args: Parameters<typeof fs.readFile>) => {
    if (String(args[0]) === original) { entered(); await gate }
    return read(...args)
  })
  const job = f.sync(1, false)
  await enteredIO
  try {
    assert.equal(f.clients[1].sync.status().progress?.stage, 'refreshing')
    assert.equal((await fs.readdir(path.join(f.clients[1].store.directory, 'sync-work'))).length, 1)
    await f.teams.withAccess(f.shared, f.team.id, f.clients[0].identity, false, async () => {
      assert.deepEqual(await read(original), bytes)
    })
    // A second client can publish while the first is blocked in local ingestion.
    const current = f.clients[0].business.get(f.car.id)
    f.clients[0].business.write({ id: f.car.id, kind: 'vehicle', data: { ...current.data, notes: 'Concurrent administrator edit' }, version: current.version, actor: f.actors[0], reason: 'Concurrent edit' })
    assert.equal((await f.sync(0, false)).phase, 'ready')
    if (revoke) await f.teams.changeMember(f.shared, f.team.id, f.clients[0].identity, f.actors[1].id, 'member', false, 'Revoke during local ingestion')
  } finally { release() }
  const state = await job
  assert.equal(state.error, revoke ? 'ACCESS_DISABLED' : null)
  assert.equal(state.phase, revoke ? 'offline' : 'ready')
  assert.equal(state.pending, 0)
  assert.deepEqual(await f.clients[1].business.readBlob(key), bytes)
  assert.equal(f.clients[1].business.get(f.car.id).data.owner, 'Member pending edit')
  assert.ok(f.clients[1].business.history(f.car.id).length >= 3)
  assert.deepEqual(await fs.readdir(path.join(f.clients[1].store.directory, 'sync-work')), [])
})


test('a lease release failure disposes the retained private snapshot before retry', async t => {
  const f = await fixture(); t.after(f.close)
  f.edit(1, 'Published before release failed')
  const withAccess = f.teams.withAccess.bind(f.teams)
  const failure = t.mock.method(f.teams, 'withAccess', async (...args: Parameters<typeof f.teams.withAccess>) => {
    await withAccess(...args)
    throw new AppError('SHARE_LOCK_LOST', 409)
  })
  const state = await f.sync(1, false)
  assert.equal(state.error, 'SHARE_LOCK_LOST')
  assert.equal(state.pending, 1, 'publication acknowledgement waits until the private refresh')
  assert.deepEqual(await fs.readdir(path.join(f.clients[1].store.directory, 'sync-work')), [])
  failure.mock.restore()
  assert.equal((await f.sync(1, false)).pending, 0)
  assert.equal(f.clients[1].business.get(f.car.id).data.owner, 'Published before release failed')
})
