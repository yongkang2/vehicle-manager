import { test } from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { createApp } from '../server/app.js'
import type { Status, TeamDocument } from '../shared/types.js'

test('separate local accounts join one team, require approval and never expose credentials', async () => {
  const root = await fs.mkdtemp(path.join(import.meta.dirname, 'test-data-'))
  const shared = path.join(root, 'shared'); await fs.mkdir(shared)
  const clients = ['alpha', 'beta'].map(name => {
    const client = createApp({ dataDir: path.join(root, name) })
    return { ...client, server: client.app.listen(0, '127.0.0.1'), cookie: '', workspaceToken: '' }
  })
  for (const client of clients) if (!client.server.listening) await new Promise(resolve => client.server.once('listening', resolve))
  async function request(client: typeof clients[number], url: string, method = 'GET', body?: unknown) {
    const address = client.server.address() as { port: number }
    const response = await fetch(`http://127.0.0.1:${address.port}${url}`, { method, headers: { Cookie: client.cookie, 'X-Workspace-Token': client.workspaceToken, 'X-App-Request': 'vehicle-manager', ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined })
    client.workspaceToken = response.headers.get('x-workspace-token') || client.workspaceToken
    const cookie = response.headers.get('set-cookie')
    if (cookie) client.cookie = cookie.split(';')[0]
    return { status: response.status, data: await response.json() }
  }
  try {
    const [alpha, beta] = clients
    assert.equal((await request(alpha, '/api/status')).status, 401)
    for (const client of clients) assert.equal((await request(client, '/api/register', 'POST', { username: 'same-name', displayName: 'Member', password: 'setup-test-password' })).status, 201)
    assert.notEqual(alpha.store.db.prepare('SELECT id FROM accounts').get()!.id, beta.store.db.prepare('SELECT id FROM accounts').get()!.id)
    const unconfigured = (await request(alpha, '/api/status')).data as Status
    assert.equal(unconfigured.access, 'unconfigured'); assert.equal(unconfigured.sharedPath, null)
    const absent = await request(alpha, '/api/setup/check', 'POST', { path: path.join(root, 'absent') })
    assert.equal(absent.data.error, 'SHARE_UNAVAILABLE')
    assert.equal((await request(alpha, '/api/setup/configure', 'POST', { path: shared, mode: 'create', teamName: 'Engineering' })).status, 409)
    const created = await request(alpha, '/api/setup/configure', 'POST', { path: shared, mode: 'create', teamName: 'Engineering', confirmed: true })
    assert.equal(created.status, 200); assert.equal(created.data.member.role, 'admin')
    const check = await request(beta, '/api/setup/check', 'POST', { path: shared })
    const joined = await request(beta, '/api/setup/configure', 'POST', { path: shared, mode: 'join', teamId: check.data.teamId })
    assert.equal(joined.data.access, 'pending')
    assert.equal((await request(beta, '/api/team')).status, 403)
    const team = (await request(alpha, '/api/team')).data as TeamDocument
    assert.equal((await request(alpha, `/api/team/requests/${team.requests[0].id}/approve`, 'POST', { role: 'member', memberId: null, reason: 'Verified device and person' })).status, 200)
    const approved = (await request(beta, '/api/status')).data as Status
    assert.equal(approved.access, 'approved'); assert.equal(approved.member!.role, 'member')
    assert.equal((await request(beta, `/api/team/members/${approved.member!.id}`, 'POST', { role: 'admin', enabled: true, reason: 'Self promotion' })).status, 403)
    const sharedText = await fs.readFile(path.join(shared, 'team.json'), 'utf8')
    assert.ok(!sharedText.includes('setup-test-password')); assert.ok(!sharedText.includes('"hash"')); assert.ok(!sharedText.includes('"salt"'))
    await fs.rename(shared, `${shared}-offline`)
    const offline = (await request(beta, '/api/status')).data as Status
    assert.equal(offline.online, false); assert.equal(offline.access, 'approved')
    assert.equal((await request(alpha, '/api/team')).status, 503)
    await fs.rename(`${shared}-offline`, shared)
    assert.equal((await request(alpha, `/api/team/members/${approved.member!.id}`, 'POST', { role: 'member', enabled: false, reason: 'Access removed' })).status, 200)
    assert.equal((await request(beta, '/api/status')).data.access, 'disabled')
    assert.equal((await request(alpha, '/api/logout', 'POST')).status, 200)
    assert.equal((await request(alpha, '/api/status')).status, 401)
    assert.equal((await request(alpha, '/api/login', 'POST', { username: 'same-name', password: 'wrong' })).status, 401)
    assert.equal((await request(alpha, '/api/login', 'POST', { username: 'same-name', password: 'setup-test-password' })).status, 200)
    assert.equal(alpha.store.db.prepare('PRAGMA integrity_check').get()!.integrity_check, 'ok')
  } finally {
    for (const client of clients) { await new Promise<void>(resolve => client.server.close(() => resolve())); client.store.db.close() }
    await fs.rm(root, { recursive: true, force: true })
  }
})