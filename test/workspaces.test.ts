import { test } from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { createApp } from '../server/app.js'
import { LocalStore } from '../server/store.js'
import type { TeamDocument } from '../shared/types.js'

async function fixture() {
  const root = await fs.mkdtemp(path.join(import.meta.dirname, 'test-data-workspaces-'))
  const client = createApp({ dataDir: path.join(root, 'local') }), server = client.app.listen(0, '127.0.0.1')
  if (!server.listening) await new Promise(resolve => server.once('listening', resolve))
  const sessions = new Map<string, { cookie: string; token: string }>()
  async function request(url: string, body?: unknown, sessionName = 'first', override?: string) {
    const session = sessions.get(sessionName) || { cookie: '', token: '' }
    const response = await fetch(`http://127.0.0.1:${(server.address() as { port: number }).port}/api${url}`, { method: body ? 'POST' : 'GET', headers: { 'X-App-Request': 'vehicle-manager', 'X-Workspace-Token': override ?? session.token, Cookie: session.cookie, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined })
    const cookie = response.headers.get('set-cookie'); if (cookie) session.cookie = cookie.split(';')[0]
    if (response.ok) session.token = response.headers.get('x-workspace-token') || session.token
    sessions.set(sessionName, session)
    return { status: response.status, data: await response.json() }
  }
  async function team(name: string, sessionName = 'first') {
    const shared = path.join(root, name); await fs.mkdir(shared)
    const response = await request('/setup/configure', { path: shared, mode: 'create', teamName: name, confirmed: true, retainPending: true }, sessionName)
    assert.equal(response.status, 200, JSON.stringify(response.data))
    return { id: response.data.teamId as string, shared }
  }
  async function closeServer() { await new Promise<void>(resolve => server.close(() => resolve())) }
  async function close() { await closeServer(); await client.close(); await fs.rm(root, { recursive: true, force: true }) }
  return { root, client, request, team, close, closeServer, sessions }
}
const account = { username: 'workspace-user', displayName: 'Workspace user', password: 'workspace-test-password' }

test('shutdown waits for workspace polling, stops overlapping ticks and closes each database only once', async () => {
  const fixtureData = await fixture(), { client, request, team } = fixtureData
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  try {
    await request('/register', account)
    const first = await team('first')
    await request('/login', account, 'second')
    const second = await team('second')
    let entered!: () => void, calls = 0
    const started = new Promise<void>(resolve => { entered = resolve })
    for (const id of [first.id, second.id]) client.workspaces.get(id).tick = async () => { calls++; entered(); await gate }
    const poll = client.tick()
    await started
    assert.equal(client.tick(), poll)
    const closing = client.close()
    assert.equal(client.close(), closing)
    assert.equal(client.store.db.prepare('SELECT 1 AS open').get()!.open, 1)
    await client.tick()
    assert.equal(calls, 1)
    release()
    await Promise.all([poll, closing])
    await client.tick()
    await client.close()
    assert.equal(calls, 1)
    assert.throws(() => client.store.db.prepare('SELECT 1'), { code: 'ERR_INVALID_STATE' })
  } finally { release(); await fixtureData.close() }
})

test('in-flight requests block switching and a new login invalidates old-page tokens even for the same team', async () => {
  const fixtureData = await fixture(), { client, request, team, sessions } = fixtureData
  try {
    await request('/register', account)
    const first = await team('first'), second = await team('second')
    await request('/workspaces/select', { teamId: first.id })
    const workspace = client.workspaces.get(first.id), read = workspace.teams.read.bind(workspace.teams)
    let release!: () => void, entered!: () => void, hold = true
    const gate = new Promise<void>(resolve => { release = resolve }), started = new Promise<void>(resolve => { entered = resolve })
    workspace.teams.read = async (...args) => { if (hold) { hold = false; entered(); await gate }; return read(...args) }
    const ongoing = request('/business/records')
    try {
      await started
      assert.equal((await request('/workspaces/select', { teamId: second.id })).data.error, 'WORKSPACE_BUSY')
    } finally { release(); await ongoing; workspace.teams.read = read }
    const staleToken = sessions.get('first')!.token
    await request('/login', account)
    assert.equal((await request('/status')).data.teamId, first.id)
    assert.notEqual(sessions.get('first')!.token, staleToken)
    assert.equal((await request('/business/records', { kind: 'vehicle' }, 'first', staleToken)).data.error, 'WORKSPACE_CHANGED')
  } finally { await fixtureData.close() }
})

test('workspace switching isolates offline records, originals, sessions and stale requests; retained changes require explicit resume', async () => {
  const fixtureData = await fixture(), { client, request, team, sessions } = fixtureData
  try {
    assert.equal((await request('/register', account)).status, 201)
    const first = await team('first-team'), original = client.workspaces.get(first.id)
    await fs.rename(first.shared, `${first.shared}-offline`)
    const car = await request('/business/records', { kind: 'vehicle', data: { vin: 'TEST0000000000001', status: 'available', complianceLevel: 'Eu7', project: 'First' }, reason: 'Keep offline data' })
    assert.equal(car.status, 201)
    await client.synchronization.settle()
    const blob = await original.business.blob(Buffer.from('first-team original'))
    const oldToken = sessions.get('first')!.token
    assert.equal((await request('/workspaces/disconnect', { confirmed: true })).data.error, 'PENDING_BEFORE_SWITCH')
    assert.equal((await request('/status')).data.teamId, first.id)
    assert.equal((await request('/login', account, 'second')).status, 200)
    assert.equal((await request('/status', undefined, 'second')).data.teamId, first.id)
    const second = await team('second-team')
    assert.notEqual(client.workspaces.get(second.id).store.directory, original.store.directory)
    assert.equal((await request('/business/records')).data.length, 0)
    assert.equal((await request('/business/records', undefined, 'second')).data.length, 1)
    assert.equal((await request('/business/records', { kind: 'vehicle', data: { vin: 'TEST0000000000002' }, reason: 'Stale form' }, 'first', oldToken)).data.error, 'WORKSPACE_CHANGED')
    assert.equal((await request('/business/records', { kind: 'vehicle' }, 'first', '')).data.error, 'WORKSPACE_CHANGED')
    assert.equal((await original.business.readBlob(blob)).toString(), 'first-team original')
    await assert.rejects(client.workspaces.get(second.id).business.readBlob(blob))
    assert.equal(original.synchronization.status().pending, 1)
    assert.equal((await request('/workspaces/select', { teamId: first.id })).data.syncPaused, true)
    assert.equal((await request('/business/records')).data[0].id, car.data.id)
    assert.equal((await request('/business/sync', {})).data.error, 'CONFIRM_RESUME')
    await fs.rename(`${first.shared}-offline`, first.shared)
    await client.tick()
    assert.equal(original.synchronization.status().pending, 1)
    assert.equal((await request('/workspaces/resume', { confirmed: true })).status, 200)
    assert.equal((await request('/business/sync', {})).data.pending, 0)
    assert.equal((await request('/workspaces/select', { teamId: second.id })).status, 200)
    assert.equal((await request('/business/records')).data.length, 0)
    assert.equal((await request('/register', { ...account, username: 'different-user' }, 'third')).status, 201)
    assert.deepEqual((await request('/workspaces', undefined, 'third')).data, [])
    assert.equal((await request('/workspaces/select', { teamId: first.id }, 'third')).data.error, 'WORKSPACE_NOT_FOUND')
    assert.equal((await request('/workspaces/disconnect', { confirmed: true })).data.access, 'unconfigured')
    assert.ok(original.business.get(car.data.id))
  } finally { await fixtureData.close() }
})

test('applicant withdrawal cannot be approved; inaccessible shares never pretend a remote withdrawal succeeded', async () => {
  const fixtureData = await fixture(), { client, request, team } = fixtureData
  try {
    await request('/register', account)
    const first = await team('team')
    await request('/register', { ...account, username: 'applicant' }, 'applicant')
    assert.equal((await request('/setup/configure', { path: first.shared, teamId: first.id, mode: 'join' }, 'applicant')).data.access, 'pending')
    const roster = (await request('/team')).data as TeamDocument, requestId = roster.requests[0].id
    await fs.rename(first.shared, `${first.shared}-offline`)
    assert.equal((await request('/workspaces/cancel-request', { confirmed: true }, 'applicant')).data.error, 'SHARE_UNAVAILABLE')
    assert.equal((await request('/status', undefined, 'applicant')).data.access, 'pending')
    await fs.rename(`${first.shared}-offline`, first.shared)
    assert.equal((await request('/workspaces/cancel-request', { confirmed: true }, 'applicant')).data.access, 'unbound')
    assert.equal((await request(`/team/requests/${requestId}/approve`, { role: 'member', memberId: null, reason: 'Too late' })).data.error, 'REQUEST_CHANGED')
    assert.equal((await request('/setup/configure', { path: first.shared, teamId: first.id, mode: 'join' }, 'applicant')).data.access, 'pending')
    const updated = (await request('/team')).data as TeamDocument
    assert.equal(updated.requests[0].status, 'cancelled'); assert.equal(updated.requests[1].status, 'pending')
    assert.equal(client.workspaces.get(first.id).store.db.prepare('PRAGMA integrity_check').get()!.integrity_check, 'ok')
  } finally { await fixtureData.close() }
})

test('legacy upgrade backs up before schema changes, retries safely and preserves records, queues, identity and sessions in place', async () => {
  const fixtureData = await fixture(), { root, client, request, team } = fixtureData
  const directory = client.store.directory
  let stopped = false
  try {
    await request('/register', account)
    const first = await team('legacy-team'), workspace = client.workspaces.get(first.id)
    await fs.rename(first.shared, `${first.shared}-offline`)
    const car = await request('/business/records', { kind: 'vehicle', data: { vin: 'TEST0000000000001', status: 'available', complianceLevel: 'Eu7' }, reason: 'Legacy offline record' })
    await client.synchronization.settle()
    const deviceId = client.store.deviceId
    const blob = await workspace.business.blob(Buffer.from('legacy original'))
    await fixtureData.closeServer()
    await client.close(); stopped = true
    const legacy = new DatabaseSync(path.join(directory, 'local.sqlite'))
    legacy.exec('DROP TABLE quarantined_operations; DROP TABLE vehicle_deletions; DROP TABLE account_workspaces; DROP TABLE workspaces; ALTER TABLE sessions DROP COLUMN workspace_id; ALTER TABLE sessions DROP COLUMN workspace_epoch; ALTER TABLE sessions DROP COLUMN sync_enabled; PRAGMA user_version=2;')
    legacy.close()
    await fs.writeFile(path.join(directory, 'migration-backups'), 'prevent backup')
    assert.throws(() => new LocalStore(directory))
    const untouched = new DatabaseSync(path.join(directory, 'local.sqlite'))
    assert.equal(untouched.prepare('PRAGMA user_version').get()!.user_version, 2); untouched.close()
    await fs.rm(path.join(directory, 'migration-backups'))
    const upgraded = new LocalStore(directory)
    try {
      assert.equal(upgraded.deviceId, deviceId)
      assert.equal(upgraded.db.prepare('PRAGMA user_version').get()!.user_version, 5)
      assert.equal(upgraded.db.prepare('SELECT directory FROM workspaces WHERE id=?').get(first.id)!.directory, '.')
      assert.equal(upgraded.db.prepare('SELECT id FROM records').get()!.id, car.data.id)
      assert.equal(upgraded.db.prepare("SELECT COUNT(*) AS total FROM outbox WHERE state='pending'").get()!.total, 1)
      assert.ok(upgraded.db.prepare('SELECT workspace_id FROM sessions WHERE workspace_id=?').get(first.id))
      assert.equal((await fs.readFile(path.join(directory, 'blobs', blob))).toString(), 'legacy original')
      const backups = await fs.readdir(path.join(directory, 'migration-backups'))
      assert.equal(backups.length, 1)
      const backup = new DatabaseSync(path.join(directory, 'migration-backups', backups[0]), { readOnly: true })
      assert.equal(backup.prepare('PRAGMA integrity_check').get()!.integrity_check, 'ok')
      assert.equal(backup.prepare('PRAGMA user_version').get()!.user_version, 2); backup.close()
      assert.equal(upgraded.db.prepare('PRAGMA foreign_key_check').all().length, 0)
    } finally { upgraded.db.close() }
  } finally {
    if (!stopped) await fixtureData.close()
    else await fs.rm(root, { recursive: true, force: true })
  }
})
