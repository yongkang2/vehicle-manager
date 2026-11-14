import { test } from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { LocalStore } from '../server/store.js'
import { Business } from '../server/business.js'
import { BusinessSync } from '../server/sync.js'
import { SharedBusinessSnapshot } from '../server/deletions.js'
import { TeamDirectory } from '../server/team.js'
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

test('unchanged background checks skip snapshots, but local edits, remote edits and explicit sync do not', async t => {
  const f = await fixture(); t.after(f.close)
  const open = t.mock.method(SharedBusinessSnapshot, 'open')
  for (let index = 0; index < 10; index++) assert.equal((await f.sync(1)).phase, 'ready')
  assert.equal(open.mock.callCount(), 0, 'ten unchanged polls must not download or open a database snapshot')
  f.edit(1, 'Local edit'); assert.equal((await f.sync(1)).pending, 0)
  assert.equal(open.mock.callCount(), 1)
  await f.sync(0); assert.equal(f.clients[0].business.get(f.car.id).data.owner, 'Local edit')
  f.edit(0, 'Remote edit'); await f.sync(0); await f.sync(1)
  assert.equal(f.clients[1].business.get(f.car.id).data.owner, 'Remote edit')
  const before = open.mock.callCount(); await f.sync(1, false)
  assert.equal(open.mock.callCount(), before + 1, 'manual synchronization performs a full check')
  const currentTime = Date.now(); const clock = t.mock.method(Date, 'now', () => currentTime + 300001)
  await f.sync(1); clock.mock.restore()
  assert.equal(open.mock.callCount(), before + 2, 'background full validation is bounded to five minutes')
})

test('unchanged background checks do not acquire the publication lock and recheck access after HEAD', async t => {
  const f = await fixture(); t.after(f.close)
  const locked = t.mock.method(f.teams, 'withAccess')
  assert.equal((await f.sync(1)).phase, 'ready')
  assert.equal(locked.mock.callCount(), 0)
  const readHead = SharedBusinessSnapshot.readHead.bind(SharedBusinessSnapshot)
  t.mock.method(SharedBusinessSnapshot, 'readHead', async (...args) => {
    const head = await readHead(...args)
    await f.teams.changeMember(f.shared, f.team.id, f.clients[0].identity, f.actors[1].id, 'member', false, 'Revoke during check')
    return head
  })
  assert.equal((await f.sync(1)).error, 'ACCESS_DISABLED')
})

test('unchanged checks complete while another client holds the team lock', async t => {
  const f = await fixture(); t.after(f.close)
  let entered!: () => void, release!: () => void
  const acquired = new Promise<void>(resolve => { entered = resolve }), gate = new Promise<void>(resolve => { release = resolve })
  const holder = f.teams.withAccess(f.shared, f.team.id, f.clients[0].identity, false, async () => { entered(); await gate })
  await acquired
  try { assert.equal((await f.sync(1)).phase, 'ready') } finally { release(); await holder }
})

test('fast checks preserve conflicts, revocation, rollback and corrupted HEAD detection', async t => {
  const f = await fixture(); t.after(f.close)
  f.edit(0, 'Admin'); f.edit(1, 'Member'); await f.sync(0)
  const conflict = await f.sync(1); assert.equal(conflict.phase, 'conflict'); assert.ok(conflict.conflicts.length)
  assert.equal((await f.sync(1)).phase, 'conflict')
  const headPath = path.join(f.shared, 'business', 'HEAD.json'), headBytes = await fs.readFile(headPath)
  const head = JSON.parse(headBytes.toString()); head.sequence--
  await fs.writeFile(headPath, JSON.stringify(head)); assert.equal((await f.sync(0)).error, 'BUSINESS_ROLLBACK')
  await fs.writeFile(headPath, headBytes); await f.sync(0)
  await fs.writeFile(headPath, '{broken'); assert.equal((await f.sync(0)).error, 'SHARE_CORRUPTED')
  await fs.writeFile(headPath, headBytes); await f.sync(0)
  await f.teams.changeMember(f.shared, f.team.id, f.clients[0].identity, f.actors[1].id, 'member', false, 'Revoke access')
  assert.equal((await f.sync(1)).error, 'ACCESS_DISABLED')
})

test('failed attachment ingestion is retried even when the shared revision is unchanged', async t => {
  const f = await fixture(); t.after(f.close)
  const bytes = Buffer.from('test attachment'), checksum = await f.clients[0].business.blob(bytes)
  f.clients[0].business.write({ kind: 'attachment', vehicleId: f.car.id, data: { name: 'file.txt', checksum, size: bytes.length }, actor: f.actors[0], reason: 'Attach', internal: true })
  await f.sync(0)
  const filename = path.join(f.shared, 'business', 'blobs', checksum)
  await fs.writeFile(filename, 'corrupted')
  assert.equal((await f.sync(1)).error, 'FILE_CORRUPTED')
  await fs.writeFile(filename, bytes)
  assert.equal((await f.sync(1)).phase, 'ready')
  assert.deepEqual(await f.clients[1].business.readBlob(checksum), bytes)
  const snapshotHead = JSON.parse(await fs.readFile(path.join(f.shared, 'business', 'HEAD.json'), 'utf8'))
  await fs.writeFile(path.join(f.shared, 'business', 'snapshots', `${snapshotHead.revision}.sqlite`), 'corrupted')
  assert.equal((await f.sync(1, false)).error, 'SHARE_CORRUPTED', 'manual sync never trusts the background cache')
})

test('one publication verifies and transfers each referenced blob only once', async t => {
  const f = await fixture(); t.after(f.close)
  const bytes = Buffer.from('shared attachment bytes'), checksum = await f.clients[0].business.blob(bytes)
  for (const name of ['first.txt', 'second.txt']) f.clients[0].business.write({ kind: 'attachment', vehicleId: f.car.id, data: { name, checksum, size: bytes.length }, actor: f.actors[0], reason: 'Attach', internal: true })
  const read = t.mock.method(f.clients[0].business, 'readBlob')
  assert.equal((await f.sync(0, false)).phase, 'ready')
  assert.equal(read.mock.callCount(), 1)
  assert.equal((await f.sync(1, false)).phase, 'ready')
  assert.deepEqual(await f.clients[1].business.readBlob(checksum), bytes)
})

test('ingestion reuses record and history statements as fleet size grows', async t => {
  const f = await fixture(); t.after(f.close)
  for (let index = 2; index <= 32; index++) f.clients[0].business.write({ kind: 'vehicle', data: { vin: `TEST${String(index).padStart(13, '0')}`, status: 'available' }, actor: f.actors[0], reason: 'Fleet fixture' })
  assert.equal((await f.sync(0, false)).phase, 'ready')
  const prepare = t.mock.method(f.clients[1].store.db, 'prepare')
  assert.equal((await f.sync(1, false)).phase, 'ready')
  const count = (sql: string) => prepare.mock.calls.filter(call => call.arguments[0] === sql).length
  assert.equal(count('SELECT * FROM records WHERE id=?'), 1, 'compile the lookup once per ingest, not once per row')
  assert.equal(count('INSERT OR IGNORE INTO changes VALUES(?,?,?,?,?)'), 2, 'one statement for each canonical acceptance; no third history copy')
  assert.equal(f.clients[1].business.list('vehicle').length, 32)
  assert.deepEqual(f.clients[1].store.db.prepare('SELECT * FROM changes ORDER BY id').all(), f.clients[0].store.db.prepare('SELECT * FROM changes ORDER BY id').all())
})
