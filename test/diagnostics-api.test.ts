import { test } from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { once } from 'node:events'
import { createApp } from '../server/app.js'

test('failed and successful authentication and malformed requests have safe correlated diagnostics', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vm-diagnostics-api-'))
  const client = createApp({ dataDir: root }), server = client.app.listen(0, '127.0.0.1')
  if (!server.listening) await once(server, 'listening')
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  const secret = 'diagnostic-private-password', username = 'private-username'
  const headers = { 'Content-Type': 'application/json', 'X-App-Request': 'vehicle-manager', 'X-Request-Id': 'untrusted-secret' }
  try {
    const failed = await fetch(`${url}/api/login?secret=private-query`, { method: 'POST', headers, body: JSON.stringify({ username, password: secret }) })
    assert.equal(failed.status, 401)
    const alias = await fetch(`${url}/API/login`, { method: 'POST', headers, body: JSON.stringify({ username, password: secret }) })
    assert.equal(alias.status, 401); assert.match(alias.headers.get('x-request-id') || '', /^[a-f0-9-]{36}$/)
    const id = failed.headers.get('x-request-id'); assert.match(id || '', /^[a-f0-9-]{36}$/)
    assert.deepEqual(await failed.json(), { error: 'INVALID_CREDENTIALS' })
    const registered = await fetch(`${url}/api/register`, { method: 'POST', headers, body: JSON.stringify({ username, displayName: 'Private User', password: secret }) })
    assert.equal(registered.status, 201)
    const login = await fetch(`${url}/API/Login/`, { method: 'POST', headers, body: JSON.stringify({ username, password: secret }) })
    assert.equal(login.status, 200)
    const broken = await fetch(`${url}/api/login`, { method: 'POST', headers, body: '{"password":"private-body",' })
    assert.equal(broken.status, 400)
    const loginCookie = login.headers.get('set-cookie')!.split(';')[0]
    const bootstrap = await fetch(`${url}/api/bootstrap?private-query`, { headers: { Cookie: loginCookie } })
    assert.equal(bootstrap.status, 200)
    const shared = path.join(root, 'shared'); await fs.mkdir(shared)
    const setup = await fetch(`${url}/api/setup/configure`, { method: 'POST', headers: { ...headers, Cookie: loginCookie, 'X-Workspace-Token': login.headers.get('x-workspace-token')! }, body: JSON.stringify({ path: shared, mode: 'create', teamName: 'Diagnostic test', confirmed: true }) })
    assert.equal(setup.status, 200)
    const body = new FormData(); body.append('file', new Blob(['not-an-excel-workbook']), 'private-report.xlsx')
    const parse = await fetch(`${url}/api/business/dove/preview`, { method: 'POST', headers: { Cookie: loginCookie, 'X-App-Request': 'vehicle-manager', 'X-Workspace-Token': setup.headers.get('x-workspace-token')! }, body })
    assert.equal(parse.status, 422)
    const parseId = parse.headers.get('x-request-id')
    const listed = await fetch(`${url}/api/workspaces`, { headers: { Cookie: loginCookie } })
    assert.equal(listed.status, 200); assert.equal((await listed.json() as unknown[]).length, 1)
    const setupData = await setup.json() as { teamId: string }, workspace = client.workspaces.get(setupData.teamId)
    const { AppError } = await import('../server/team.js')
    const offline = t.mock.method(workspace.teams, 'read', async () => { throw new AppError('SHARE_UNAVAILABLE', 409) })
    for (let index = 0; index < 2; index++) {
      const status = await fetch(`${url}/api/status`, { headers: { Cookie: loginCookie } })
      assert.equal(status.status, 200); assert.equal((await status.json() as { error: string }).error, 'SHARE_UNAVAILABLE')
    }
    offline.mock.restore()
    assert.equal((await fetch(`${url}/api/status`, { headers: { Cookie: loginCookie } })).status, 200)
    const raw = await fs.readFile(path.join(root, 'logs', 'diagnostics.jsonl'), 'utf8')
    const entries = raw.trim().split('\n').map(line => JSON.parse(line))
    assert(entries.some(entry => entry.requestId === id && entry.code === 'INVALID_CREDENTIALS' && entry.route === '/api/login'))
    assert(entries.some(entry => entry.event === 'auth.succeeded' && entry.route === '/api/login'))
    assert(entries.some(entry => entry.event === 'parser.failed' && entry.requestId === parseId))
    assert(!entries.some(entry => entry.route === '/api/bootstrap'))
    assert.equal(entries.filter(entry => entry.event === 'workspace.status_failed').length, 1)
    assert(entries.some(entry => entry.event === 'workspace.status_recovered'))
    assert(entries.some(entry => entry.status === 400 && entry.code === 'INVALID_INPUT'))
    for (const value of [secret, username, 'Private User', 'private-query', 'private-body', 'untrusted-secret', 'vdm_session', 'private-report.xlsx', 'not-an-excel-workbook']) assert(!raw.includes(value), value)
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); await client.close(); await fs.rm(root, { recursive: true, force: true }) }
})
