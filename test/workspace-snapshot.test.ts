import { test } from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { once } from 'node:events'
import { randomUUID } from 'node:crypto'
import { createApp } from '../server/app.js'
import { SharedBusinessSnapshot } from '../server/deletions.js'
import type { BusinessRecord } from '../shared/business.js'

test('workspace snapshots show local data promptly, refresh changes, and preserve access, deletion and paused-session rules', async t => {
  const root = await fs.mkdtemp(path.join(import.meta.dirname, 'test-data-workspace-refresh-')), shared = path.join(root, 'shared')
  await fs.mkdir(shared)
  const clients = ['admin', 'member'].map(name => {
    const client = createApp({ dataDir: path.join(root, name) })
    return { ...client, server: client.app.listen(0, '127.0.0.1'), cookie: '', token: '' }
  })
  for (const client of clients) if (!client.server.listening) await once(client.server, 'listening')
  t.after(async () => {
    for (const client of clients) { await new Promise<void>(resolve => client.server.close(() => resolve())); await client.close() }
    assert.equal(path.dirname(root), import.meta.dirname); await fs.rm(root, { recursive: true, force: true })
  })
  const [admin, member] = clients
  async function request(client: typeof admin, route: string, method = 'GET', body?: unknown) {
    const response = await fetch(`http://127.0.0.1:${(client.server.address() as { port: number }).port}/api${route}`, { method, headers: { Cookie: client.cookie, 'X-Workspace-Token': client.token, 'X-App-Request': 'vehicle-manager', ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(5000) })
    if (response.ok) client.token = response.headers.get('x-workspace-token') || client.token
    const cookie = response.headers.get('set-cookie'); if (cookie) client.cookie = cookie.split(';')[0]
    return { status: response.status, data: await response.json() }
  }
  assert.equal((await request(member, '/business/workspace?local=1')).status, 401)
  for (const [index, client] of clients.entries()) await request(client, '/register', 'POST', { username: `refresh-${index}`, displayName: `Tester ${index}`, password: 'refresh-test-password' })
  const setup = await request(admin, '/setup/configure', 'POST', { path: shared, mode: 'create', teamName: 'Refresh test', confirmed: true })
  const teamId = setup.data.teamId
  await request(member, '/setup/configure', 'POST', { path: shared, mode: 'join', teamId })
  assert.equal((await request(member, '/business/workspace?local=1')).status, 403)
  const team = (await request(admin, '/team')).data
  await request(admin, `/team/requests/${team.requests[0].id}/approve`, 'POST', { role: 'member', memberId: null, reason: 'Approve test user' })
  const created = await request(admin, '/business/records', 'POST', { kind: 'vehicle', data: { name: 'Fast load car', vin: 'TEST0000000000001', status: 'available', complianceLevel: 'Eu7' }, reason: 'Register' })
  assert.equal(created.status, 201); const car = created.data as BusinessRecord
  await admin.synchronization.settle()
  const first = await request(member, '/business/workspace')
  assert.equal(first.status, 200); assert.equal(first.data.data.records[0].id, car.id)
  assert.ok(first.data.data.changes.length)
  const open = t.mock.method(SharedBusinessSnapshot, 'open')
  const unchanged = await request(member, `/business/workspace?known=${first.data.revision}`)
  assert.equal(unchanged.status, 200); assert.equal(unchanged.data.data, undefined)
  assert.equal(open.mock.callCount(), 0)
  assert.equal((await request(member, '/business/workspace?local=1&audit=1')).status, 403)
  assert.equal((await request(admin, '/business/workspace?local=1&audit=1')).status, 200)
  const current = (await request(admin, '/business/workspace?local=1')).data.data.records[0]
  const edited = await request(admin, `/business/records/${car.id}`, 'PUT', { data: { ...current.data, owner: 'Updated remotely' }, version: current.version, reason: 'Edit' })
  assert.equal(edited.status, 200); await admin.synchronization.settle()

  // Hold a real shared sync open: local reading must not wait for it.
  const originalOpen = SharedBusinessSnapshot.open
  let release!: () => void, entered!: () => void
  const gate = new Promise<void>(resolve => { release = resolve }), started = new Promise<void>(resolve => { entered = resolve })
  const blocked = t.mock.method(SharedBusinessSnapshot, 'open', async function (...args: Parameters<typeof SharedBusinessSnapshot.open>) { entered(); await gate; return originalOpen.apply(SharedBusinessSnapshot, args) })
  const remoteRequest = request(member, `/business/workspace?known=${first.data.revision}`)
  try {
    await started
    const local = await request(member, '/business/workspace?local=1')
    assert.equal(local.status, 200); assert.equal(local.data.data.records[0].data.owner, '')
  } finally { release(); blocked.mock.restore() }
  const refreshed = await remoteRequest
  assert.equal(refreshed.data.data.records[0].data.owner, 'Updated remotely')

  // Session pause prevents publication, but a local edit still changes the UI revision.
  member.store.db.prepare('UPDATE sessions SET sync_enabled=0').run()
  const beforeLocal = (await request(member, '/business/workspace?local=1')).data
  const localCar = beforeLocal.data.records[0]
  await request(member, `/business/records/${car.id}`, 'PUT', { data: { ...localCar.data, notes: 'Offline retained note' }, version: localCar.version, reason: 'Local edit' })
  await member.synchronization.settle()
  const paused = await request(member, `/business/workspace?known=${beforeLocal.revision}`)
  assert.equal(paused.data.data.records[0].data.notes, 'Offline retained note'); assert.equal(paused.data.sync.pending, 1)
  assert.equal((await request(member, '/business/sync', 'POST')).data.error, 'CONFIRM_RESUME')
  assert.equal((await request(admin, '/business/workspace?local=1')).data.data.records[0].data.notes, '')
  await request(member, '/workspaces/resume', 'POST', { confirmed: true }); await request(member, '/business/workspace')

  // Remote deletion must invalidate a warmed fingerprint and remove the vehicle.
  const live = (await request(admin, '/business/workspace')).data.data.records[0]
  await request(admin, `/business/records/${car.id}/archive`, 'POST', { archived: true, version: live.version, reason: 'Archive' })
  await admin.synchronization.settle(); const archived = (await request(member, '/business/workspace')).data
  const preview = (await request(admin, `/business/vehicles/${car.id}/delete-preview`)).data
  const deleted = await request(admin, `/business/vehicles/${car.id}`, 'DELETE', { previewToken: preview.token, version: preview.version, vin: preview.vin, confirmation: 'DELETE', reason: 'Remove test vehicle', requestId: randomUUID() })
  assert.equal(deleted.status, 200)
  const afterDeletion = await request(member, `/business/workspace?known=${archived.revision}`)
  assert.equal(afterDeletion.status, 200); assert.equal(afterDeletion.data.data.records.length, 0)
  const validToken = member.token; member.token = 'old-workspace-token'
  assert.equal((await request(member, '/business/workspace?local=1')).data.error, 'WORKSPACE_CHANGED'); member.token = validToken
  const roster = (await request(admin, '/team')).data
  const memberId = roster.bindings.find((binding: { deviceId: string }) => binding.deviceId === member.store.deviceId).memberId
  await request(admin, `/team/members/${memberId}`, 'POST', { role: 'member', enabled: false, reason: 'Revoke test access' })
  assert.equal((await request(member, `/business/workspace?local=1&known=${afterDeletion.data.revision}`)).status, 403)
})
