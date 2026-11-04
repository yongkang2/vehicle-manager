import { test } from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { LocalStore } from '../server/store.js'
import { Business } from '../server/business.js'
import { SharedBusinessSnapshot } from '../server/deletions.js'

for (const protocol of [1, 2, 3]) test(`protocol ${protocol} opens, publishes without downgrade and preserves records`, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vehicle-compat-')), store = new LocalStore(path.join(root, 'local')), business = new Business(store), team = randomUUID()
  const atomic = async (file: string, bytes: Buffer | string) => { await fs.writeFile(file, bytes) }
  try {
    let snapshot = await SharedBusinessSnapshot.open(business, root, team, atomic)
    await snapshot.publish(team, protocol as 1 | 2 | 3); await snapshot.close()
    snapshot = await SharedBusinessSnapshot.open(business, root, team, atomic)
    assert.equal(snapshot.head?.protocol, protocol)
    await snapshot.publish(team, 1); assert.equal(snapshot.head?.protocol, protocol); await snapshot.close()
  } finally { store.db.close(); await fs.rm(root, { recursive: true, force: true }) }
})

test('future shared protocol requires upgrade without changing local rows, pending work or shared HEAD', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vehicle-future-')), store = new LocalStore(path.join(root, 'local')), business = new Business(store), team = randomUUID()
  try {
    business.write({ kind: 'vehicle', data: { vin: 'TEST0000000000001', status: 'available' }, actor: { id: 'admin', name: 'Admin', deviceId: store.deviceId, role: 'admin' }, reason: 'Fictional pending record' })
    await fs.mkdir(path.join(root, 'business'))
    const file = path.join(root, 'business', 'HEAD.json'), bytes = JSON.stringify({ protocol: 4, teamId: team, revision: randomUUID(), sequence: 1, checksum: 'a'.repeat(64) })
    await fs.writeFile(file, bytes)
    const before = JSON.stringify(['records', 'outbox', 'settings'].map(table => store.db.prepare(`SELECT * FROM ${table}`).all()))
    await assert.rejects(SharedBusinessSnapshot.readHead(business, root, team), { code: 'CLIENT_UPGRADE_REQUIRED' })
    assert.equal(await fs.readFile(file, 'utf8'), bytes)
    assert.equal(JSON.stringify(['records', 'outbox', 'settings'].map(table => store.db.prepare(`SELECT * FROM ${table}`).all())), before)
  } finally { store.db.close(); await fs.rm(root, { recursive: true, force: true }) }
})

test('schema5 databases reopen without changing their version or existing records', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vehicle-schema5-'))
  let store = new LocalStore(root)
  try {
    store.set('sentinel', { preserved: true }); store.db.exec('PRAGMA user_version=5'); store.db.close()
    store = new LocalStore(root)
    assert.equal(store.db.prepare('PRAGMA user_version').get()!.user_version, 5)
    assert.deepEqual(store.get('sentinel'), { preserved: true })
  } finally { store.db.close(); await fs.rm(root, { recursive: true, force: true }) }
})

test('release can access a team gated by protocol3 development version 1.2.0', async () => {
  const { TeamDirectory } = await import('../server/team.js')
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vehicle-version-floor-'))
  const development = new TeamDirectory(null, '1.2.0'), current = new TeamDirectory(), older = new TeamDirectory(null, '1.1.5')
  const admin = { deviceId: 'alpha', deviceName: 'Alpha', localUserId: 'a', displayName: 'Admin' }, second = { deviceId: 'beta', deviceName: 'Beta', localUserId: 'b', displayName: 'Second' }
  try {
    const team = await development.create(root, 'Fictional', admin)
    const pending = await development.join(root, team.id, second)
    await development.approve(root, team.id, admin, pending.requests[0].id, 'admin', null, 'Approve')
    await development.enableUpgradeGate(root, team.id, admin, 'Require protocol3 client')
    await assert.rejects(older.read(root, team.id), { code: 'CLIENT_UPGRADE_REQUIRED' })
    assert.equal((await current.read(root, team.id)).minWritableVersion, '1.2.0')
  } finally { await fs.rm(root, { recursive: true, force: true }) }
})
