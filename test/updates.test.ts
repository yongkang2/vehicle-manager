import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ApplicationUpdates } from '../server/updates.js'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { createApp } from '../server/app.js'

test('ordinary portable and development builds cannot install updates', async () => {
  const updates = new ApplicationUpdates()
  assert.equal(updates.status().supported, false)
  await assert.rejects(updates.run('check'), { code: 'UPDATE_NOT_INSTALLED' })
  await assert.rejects(updates.install(async () => {}), { code: 'UPDATE_NOT_INSTALLED' })
})

test('update preparation requires a download and successful preflight, and preserves retry state', async () => {
  const prepared: string[] = []
  const updates = new ApplicationUpdates({
    async run(command) { return { version: '1.2.0', downloaded: command === 'download' ? '1.2.0' : null } },
    async prepare(version) { prepared.push(version) },
  })
  await updates.run('check')
  await assert.rejects(updates.install(async () => {}), { code: 'UPDATE_NOT_READY' })
  await updates.run('download')
  await assert.rejects(updates.install(async () => { throw new Error('pending changes') }), /pending changes/)
  assert.equal(updates.installing, false)
  assert.equal(updates.status().phase, 'ready')
  assert.deepEqual(prepared, [])
  await updates.install(async () => { assert.equal(updates.installing, true) })
  assert.deepEqual(prepared, ['1.2.0'])
  assert.equal(updates.installing, true)
  await assert.rejects(updates.run('check'), { code: 'UPDATE_BUSY' })
})

test('an unavailable update source does not lock the application', async () => {
  const updates = new ApplicationUpdates({ async run() { throw new Error('offline') }, async prepare() {} })
  await assert.rejects(updates.run('check'), { code: 'UPDATE_SOURCE_UNAVAILABLE' })
  assert.equal(updates.installing, false)
  assert.equal(updates.status().phase, 'idle')
})

test('update API requires login and confirmation, checks all local data and blocks requests during restart', async () => {
  const root = await fs.mkdtemp(path.join(import.meta.dirname, 'test-data-'))
  let prepared = 0, shutdown = 0
  const client = createApp({ dataDir: root, onShutdown: () => { shutdown++ }, updateBackend: {
    async run(command) { return { version: '1.2.0', downloaded: command === 'download' ? '1.2.0' : null } },
    async prepare() { prepared++ },
  } })
  const server = client.app.listen(0, '127.0.0.1')
  await new Promise<void>(resolve => server.once('listening', resolve))
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  let cookie = ''
  async function request(endpoint: string, method = 'GET', body?: unknown, header = true) {
    const response = await fetch(url + endpoint, { method, headers: { Cookie: cookie, ...(header ? { 'X-App-Request': 'vehicle-manager' } : {}), 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
    cookie = response.headers.get('set-cookie')?.split(';')[0] || cookie
    return { status: response.status, data: await response.json() }
  }
  try {
    assert.equal((await request('/api/updates')).status, 401)
    await request('/api/register', 'POST', { username: 'updater', displayName: 'Updater', password: 'update-test-password' })
    assert.equal((await request('/api/updates/check', 'POST', {}, false)).status, 403)
    assert.equal((await request('/api/updates/install', 'POST')).data.error, 'UPDATE_CONFIRMATION_REQUIRED')
    assert.equal((await request('/api/updates/install', 'POST', { confirmed: true })).data.error, 'UPDATE_NOT_READY')
    assert.equal((await request('/api/updates/download', 'POST')).data.phase, 'ready')
    client.store.set('pendingDeletionImports', [{}])
    assert.equal((await request('/api/updates/install', 'POST', { confirmed: true })).data.error, 'UPDATE_PENDING_CHANGES')
    assert.equal(prepared, 0)
    assert.equal((await request('/api/bootstrap')).status, 200)
    client.store.set('pendingDeletionImports', [])
    assert.equal((await request('/api/updates/install', 'POST', { confirmed: true })).data.phase, 'restarting')
    assert.equal(prepared, 1); assert.equal(shutdown, 1)
    assert.equal((await request('/api/register', 'POST', {})).data.error, 'MAINTENANCE_IN_PROGRESS')
    assert.equal((await request('/api/updates/install', 'POST', { confirmed: true })).status, 503)
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()))
    await client.close()
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('a disconnected install request still shuts down once after update preparation completes', async () => {
  const root = await fs.mkdtemp(path.join(import.meta.dirname, 'test-data-'))
  let preparationStarted!: () => void, finishPreparation!: () => void, responseClosed!: () => void
  const started = new Promise<void>(resolve => { preparationStarted = resolve })
  const preparation = new Promise<void>(resolve => { finishPreparation = resolve })
  const disconnected = new Promise<void>(resolve => { responseClosed = resolve })
  let shutdown = 0
  const client = createApp({ dataDir: root, onShutdown: () => { shutdown++ }, updateBackend: {
    async run() { return { version: '1.2.0', downloaded: '1.2.0' } },
    async prepare() { preparationStarted(); await preparation },
  } })
  const server = client.app.listen(0, '127.0.0.1')
  server.on('request', (request, response) => { if (request.url === '/api/updates/install') response.once('close', responseClosed) })
  await new Promise<void>(resolve => server.once('listening', resolve))
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  try {
    const registration = await fetch(url + '/api/register', { method: 'POST', headers: { 'X-App-Request': 'vehicle-manager', 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'update-review', displayName: 'Review', password: 'isolated-review-password' }) })
    const headers = { Cookie: registration.headers.get('set-cookie')!.split(';')[0], 'X-App-Request': 'vehicle-manager', 'Content-Type': 'application/json' }
    await registration.arrayBuffer()
    await (await fetch(url + '/api/updates/download', { method: 'POST', headers })).arrayBuffer()
    const abort = new AbortController()
    const installation = fetch(url + '/api/updates/install', { method: 'POST', headers, body: JSON.stringify({ confirmed: true }), signal: abort.signal }).catch(() => null)
    await started
    abort.abort(); await installation; await disconnected
    assert.equal(shutdown, 0)
    finishPreparation()
    await new Promise<void>(resolve => setImmediate(resolve))
    assert.equal(shutdown, 1)
  } finally {
    finishPreparation()
    await new Promise<void>(resolve => server.close(() => resolve()))
    await client.close()
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('startup checks reject business writes and require authenticated health before activation', async () => {
  const previous = process.env.VEHICLE_MANAGER_STARTUP_CHECK
  process.env.VEHICLE_MANAGER_STARTUP_CHECK = '1'
  const root = await fs.mkdtemp(path.join(import.meta.dirname, 'test-data-'))
  const token = 'a'.repeat(64)
  const client = createApp({ dataDir: root, controlToken: token })
  if (previous === undefined) delete process.env.VEHICLE_MANAGER_STARTUP_CHECK
  else process.env.VEHICLE_MANAGER_STARTUP_CHECK = previous
  const server = client.app.listen(0, '127.0.0.1')
  await new Promise<void>(resolve => server.once('listening', resolve))
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  async function post(endpoint: string, authenticated = true) {
    const result = await fetch(url + endpoint, { method: 'POST', headers: { 'X-App-Request': 'vehicle-manager', ...(authenticated ? { 'X-Control-Token': token } : {}) } })
    await result.arrayBuffer(); return result.status
  }
  try {
    assert.equal(await post('/api/register'), 503)
    assert.equal(await post('/api/local/update-health', false), 403)
    assert.equal(await post('/api/local/update-activate'), 409)
    assert.equal(await post('/api/local/update-health'), 200)
    assert.equal(await post('/api/register'), 503)
    assert.equal(await post('/api/local/update-activate'), 200)
    assert.equal(await post('/api/register'), 400)
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()))
    await client.close(); await fs.rm(root, { recursive: true, force: true })
  }
})