import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { EventEmitter, once } from 'node:events'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fork } from 'node:child_process'
import { WebSocket } from 'ws'
import { BrowserPresence, installBrowserPresence } from '../server/browser-presence.js'
import type { PresenceDocument } from '../server/browser-presence.js'
import { createApp } from '../server/app.js'
import { Diagnostics } from '../server/diagnostics.js'

class PageSocket extends EventEmitter {
  readyState: number = WebSocket.OPEN
  pings = 0
  terminated = 0
  ping(callback?: (error?: Error) => void): void { this.pings++; callback?.() }
  terminate(): void { this.terminated++; this.close() }
  close(): void { this.readyState = WebSocket.CLOSED; this.emit('close') }
  asSocket(): WebSocket { return this as unknown as WebSocket }
}
function registered(monitor: BrowserPresence): PresenceDocument {
  const document = { ...monitor.createDocument(), generation: 0 }
  assert.equal(monitor.registerDocument(document).canClose, true)
  return document
}

test('no document or no acknowledged HTML initialization never authorizes automatic shutdown', context => {
  context.mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'], now: 0 })
  let stopped = 0
  const empty = new BrowserPresence({ onEmpty: () => { stopped++ } })
  empty.start(); empty.start(); context.mock.timers.tick(1200000)
  assert.equal(stopped, 0); assert.equal(empty.state.documents, 0); empty.stop()
  const pending = new BrowserPresence({ onEmpty: () => { stopped++ } })
  pending.createDocument(); pending.start(); context.mock.timers.tick(1200000)
  assert.equal(stopped, 0); assert.equal(pending.state.pendingPages, 1); pending.stop()
})

test('hidden or inactive pages remain open; a closed transport becomes uncertain without a deadline', context => {
  context.mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'], now: 0 })
  let stopped = 0
  const monitor = new BrowserPresence({ onEmpty: () => { stopped++ } }), document = registered(monitor), page = new PageSocket()
  monitor.attach(page.asSocket(), document); monitor.start()
  context.mock.timers.tick(300000); assert.equal(page.pings, 1); page.emit('pong')
  context.mock.timers.tick(300000); assert.equal(page.pings, 2); page.emit('pong')
  assert.equal(monitor.state.openPages, 1); assert.equal(stopped, 0)
  page.close(); assert.equal(monitor.count, 0); assert.equal(monitor.state.uncertainPages, 1)
  context.mock.timers.tick(1800000); assert.equal(stopped, 0)
  const reconnected = new PageSocket()
  monitor.registerDocument(document); monitor.attach(reconnected.asSocket(), document)
  assert.equal(monitor.state.documents, 1); assert.equal(monitor.state.openPages, 1); monitor.stop()
})

test('missed pong and a lost close event release sockets but never confirm document closure', context => {
  context.mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'], now: 0 })
  let stopped = 0
  const monitor = new BrowserPresence({ onEmpty: () => { stopped++ } }), first = registered(monitor), second = registered(monitor)
  const timeout = new PageSocket(), lostClose = new PageSocket()
  monitor.attach(timeout.asSocket(), first); monitor.attach(lostClose.asSocket(), second); monitor.start()
  lostClose.readyState = WebSocket.CLOSED
  context.mock.timers.tick(300000); context.mock.timers.tick(10000)
  assert.equal(timeout.terminated, 1); assert.equal(monitor.count, 0); assert.equal(monitor.state.uncertainPages, 2)
  context.mock.timers.tick(1800000); assert.equal(stopped, 0); monitor.stop()
})

test('all registered documents must explicitly close before the five-minute check and five-second grace stop once', context => {
  context.mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'], now: 0 })
  let stopped = 0
  const monitor = new BrowserPresence({ onEmpty: state => { stopped++; assert.equal(state.closedPages, 2) } })
  const first = registered(monitor), second = registered(monitor)
  monitor.start(); monitor.confirmClosed(first)
  context.mock.timers.tick(299998); assert.equal(stopped, 0); monitor.confirmClosed(second)
  context.mock.timers.tick(2); assert.equal(stopped, 0)
  context.mock.timers.tick(4997); assert.equal(stopped, 0)
  assert.equal(monitor.confirmClosed(second), true, 'Duplicate close is idempotent and does not reset grace')
  context.mock.timers.tick(1); assert.equal(stopped, 1)
  context.mock.timers.tick(900000); monitor.check(); monitor.start(); assert.equal(stopped, 1)
  const late = new PageSocket(); monitor.attach(late.asSocket(), first); assert.equal(late.terminated, 1)
})

test('pending HTML for a slow reload cancels closure grace until that document explicitly closes', context => {
  context.mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'], now: 0 })
  let stopped = 0
  const monitor = new BrowserPresence({ onEmpty: () => { stopped++ } }), old = registered(monitor)
  monitor.start(); context.mock.timers.tick(299999); monitor.confirmClosed(old); context.mock.timers.tick(1)
  context.mock.timers.tick(4000); const pending = monitor.createDocument()
  context.mock.timers.tick(900000); assert.equal(stopped, 0); assert.equal(monitor.state.pendingPages, 1)
  const replacement = { ...pending, generation: 0 }
  monitor.registerDocument(replacement); monitor.confirmClosed(replacement)
  context.mock.timers.tick(5000); monitor.check(); assert.equal(stopped, 1)
})

test('new generations reject stale closes and sockets; confirmed closure cannot be reopened by a late registration', context => {
  context.mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'], now: 0 })
  const monitor = new BrowserPresence({ onEmpty() {} }), old = registered(monitor), oldSocket = new PageSocket()
  monitor.attach(oldSocket.asSocket(), old)
  const resumed = { ...old, generation: 1 }
  monitor.registerDocument(resumed); assert.equal(oldSocket.terminated, 1)
  assert.equal(monitor.confirmClosed(old), false); assert.equal(monitor.state.closedPages, 0)
  assert.throws(() => monitor.registerDocument(old), { code: 'INVALID_REQUEST', status: 409 })
  const late = new PageSocket(); monitor.attach(late.asSocket(), old); assert.equal(late.terminated, 1)
  assert.equal(monitor.confirmClosed(resumed), true)
  assert.throws(() => monitor.registerDocument({ ...resumed, generation: 2 }), { code: 'INVALID_REQUEST', status: 409 })
  assert.equal(monitor.canAttach(resumed), false); monitor.stop()
})

test('unanchored or legacy pages remain uncertain even after another page confirms closure', context => {
  context.mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'], now: 0 })
  let stopped = 0
  const monitor = new BrowserPresence({ onEmpty: () => { stopped++ } }), anchored = registered(monitor)
  const cached = { pageId: randomUUID(), pageToken: randomBytes(32).toString('hex'), generation: 7 }
  assert.equal(monitor.registerDocument(cached).canClose, false)
  assert.throws(() => monitor.confirmClosed(cached), { code: 'INVALID_REQUEST', status: 403 })
  const legacy = new PageSocket(); monitor.attach(legacy.asSocket()); legacy.close()
  monitor.confirmClosed(anchored); monitor.start(); context.mock.timers.tick(1800000)
  assert.equal(stopped, 0); assert.equal(monitor.state.legacyPages, 1); assert.equal(monitor.state.uncertainPages, 1); monitor.stop()
})

test('sleep-delayed heartbeat retries and manual stop clear timers without an automatic-stop callback', context => {
  context.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] })
  let now = 0, stopped = 0
  const monitor = new BrowserPresence({ onEmpty: () => { stopped++ }, now: () => now }), document = registered(monitor), page = new PageSocket()
  monitor.attach(page.asSocket(), document); monitor.check(); now = 300000
  context.mock.timers.tick(10000); assert.equal(page.pings, 2); assert.equal(page.terminated, 0)
  page.emit('pong'); monitor.stop(); monitor.stop()
  context.mock.timers.tick(1800000); assert.equal(page.terminated, 1); assert.equal(stopped, 0)
})

async function until(predicate: () => boolean): Promise<void> {
  for (let attempts = 0; attempts < 100 && !predicate(); attempts++) await new Promise(resolve => setTimeout(resolve, 10))
  assert.ok(predicate(), 'Expected connection lifecycle change')
}
async function apiFixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vehicle-presence-api-')), staticDir = path.join(root, 'static')
  await fs.mkdir(path.join(staticDir, 'assets'), { recursive: true })
  await fs.writeFile(path.join(staticDir, 'index.html'), '<!doctype html><html><head><title>Fictional app</title></head><body>Fixture</body></html>')
  await fs.writeFile(path.join(staticDir, 'assets', 'fixture-hash.js'), 'window.fixture=true')
  const token = 'a'.repeat(64), monitor = new BrowserPresence({ onEmpty() {} }), client = createApp({ dataDir: path.join(root, 'local'), staticDir, browserPresence: monitor, presenceToken: token })
  const server = client.app.listen(0, '127.0.0.1'), dispose = installBrowserPresence(server, monitor, { token }), sockets: WebSocket[] = []
  if (!server.listening) await once(server, 'listening')
  const origin = 'http://127.0.0.1:' + (server.address() as { port: number }).port
  const headers = { 'X-App-Request': 'vehicle-manager', Origin: origin, 'Content-Type': 'application/json' }
  const post = (route: string, body?: unknown, supplied = headers) => fetch(origin + route, { method: 'POST', headers: supplied, body: body === undefined ? undefined : JSON.stringify(body) })
  const query = (document: PresenceDocument) => new URLSearchParams({ token, pageId: document.pageId, pageToken: document.pageToken, generation: String(document.generation) }).toString()
  async function connect(parameters: string, suppliedOrigin?: string, accepted = true) {
    const socket = new WebSocket(origin.replace('http:', 'ws:') + '/api/local/browser-presence?' + parameters, suppliedOrigin ? { origin: suppliedOrigin } : {})
    sockets.push(socket); socket.on('error', () => {})
    if (accepted) await once(socket, 'open')
    else {
      const status = await new Promise<number>((resolve, reject) => {
        socket.once('unexpected-response', (_request, response) => { response.resume(); resolve(response.statusCode || 0); socket.terminate() })
        socket.once('open', () => reject(new Error('Unsafe presence connection accepted')))
      })
      assert.equal(status, 403)
    }
    return socket
  }
  async function close() {
    monitor.stop(); dispose(); for (const socket of sockets) socket.terminate()
    await new Promise<void>(resolve => server.close(() => resolve())); await client.close()
    assert.equal(path.dirname(root), path.resolve(os.tmpdir())); await fs.rm(root, { recursive: true, force: true })
  }
  return { root, token, monitor, client, origin, headers, post, query, connect, close }
}

test('HTML gets distinct pending capabilities before JavaScript, is not cached, and leaves hashed asset caching unchanged', async () => {
  const f = await apiFixture()
  try {
    const first = await fetch(f.origin + '/'), html = await first.text(), second = await fetch(f.origin + '/index.html', { headers: { 'If-None-Match': first.headers.get('etag') || '' } }), other = await second.text()
    assert.equal(first.headers.get('cache-control'), 'no-store'); assert.equal(second.status, 200); assert.equal(second.headers.get('cache-control'), 'no-store')
    const match = /<meta name="vehicle-manager-presence" content="([a-f0-9-]{36})" data-token="([a-f0-9]{64})">/.exec(html)!, next = /content="([a-f0-9-]{36})" data-token="([a-f0-9]{64})"/.exec(other)!
    assert(match); assert(next); assert.notEqual(match[1], next[1]); assert.notEqual(match[2], next[2]); assert.equal(f.monitor.state.pendingPages, 2)
    const asset = await fetch(f.origin + '/assets/fixture-hash.js'); await asset.text()
    assert.notEqual(asset.headers.get('cache-control'), 'no-store'); assert.equal(f.monitor.state.pendingPages, 2)
    const document = { pageId: match[1], pageToken: match[2], generation: 0 }, response = await f.post('/api/local/browser-presence-token', document)
    assert.deepEqual(await response.json(), { token: f.token, pageId: document.pageId, generation: 0, canClose: true })
    assert.equal(f.monitor.state.documents, 2); assert.equal(f.monitor.state.pendingPages, 1)
  } finally { await f.close() }
})

test('registration, WebSocket and close enforce origin, epoch, capability and monotonic document scope', async () => {
  const f = await apiFixture()
  try {
    const document = { ...f.monitor.createDocument(), generation: 0 }, tokenRoute = '/api/local/browser-presence-token', closeRoute = '/api/local/browser-presence/close'
    assert.equal((await f.post(tokenRoute, document, { ...f.headers, 'X-App-Request': 'wrong' })).status, 403)
    assert.equal((await f.post(tokenRoute, document, { ...f.headers, Origin: 'http://example.com' })).status, 403)
    assert.equal((await f.post(tokenRoute, document, { ...f.headers, Origin: '' })).status, 403)
    assert.equal((await f.post(tokenRoute, { ...document, pageId: 'invalid' })).status, 400)
    assert.equal((await f.post(tokenRoute, { ...document, pageToken: 'b'.repeat(64) })).status, 403)
    assert.equal((await f.post(tokenRoute, document)).status, 200)
    await f.connect(f.query(document), undefined, false)
    await f.connect(f.query(document), 'http://example.com', false)
    await f.connect(f.query(document), f.origin.replace('127.0.0.1', 'localhost'), false)
    await f.connect(f.query(document) + '&token=' + f.token, f.origin, false)
    await f.connect(f.query({ ...document, pageToken: 'b'.repeat(64) }), f.origin, false)
    const socket = await f.connect(f.query(document), f.origin); await until(() => f.monitor.count === 1)
    assert.equal((await f.post(closeRoute, { ...document, token: 'b'.repeat(64) })).status, 403)
    assert.equal((await f.post(closeRoute, { ...document, pageToken: 'b'.repeat(64), token: f.token })).status, 403)
    assert.equal((await f.post(closeRoute, { ...document, token: f.token }, { ...f.headers, Origin: 'null' })).status, 403)
    const newer = { ...document, generation: 1 }
    assert.equal((await f.post(tokenRoute, newer)).status, 200); await until(() => socket.readyState === WebSocket.CLOSED)
    const stale = await f.post(closeRoute, { ...document, token: f.token }); assert.deepEqual(await stale.json(), { ok: true, closed: false }); assert.equal(f.monitor.state.closedPages, 0)
    const confirmed = await f.post(closeRoute, { ...newer, token: f.token }); assert.deepEqual(await confirmed.json(), { ok: true, closed: true })
    assert.equal((await f.post(tokenRoute, { ...newer, generation: 2 })).status, 409)
    await f.connect(f.query(newer), f.origin, false)
  } finally { await f.close() }
})

test('legacy requests and a cached document after backend restart are retained without shutdown authority', async () => {
  const f = await apiFixture()
  try {
    const legacy = await f.post('/api/local/browser-presence-token'); assert.deepEqual(await legacy.json(), { token: f.token }); assert.equal(f.monitor.state.legacyPages, 1)
    const cached = { pageId: randomUUID(), pageToken: randomBytes(32).toString('hex'), generation: 12 }
    const rebound = await f.post('/api/local/browser-presence-token', cached)
    assert.deepEqual(await rebound.json(), { token: f.token, pageId: cached.pageId, generation: 12, canClose: false })
    await f.connect(f.query(cached), f.origin)
    assert.equal((await f.post('/api/local/browser-presence/close', { ...cached, token: f.token })).status, 403)
    assert.equal(f.monitor.state.openPages, 1)
  } finally { await f.close() }
})

test('bootstrap exposes only the current authenticated local workspace token without opening a team', async context => {
  const f = await apiFixture()
  try {
    context.mock.method(f.client.workspaces, 'get', () => { throw new Error('Bootstrap must not open a team workspace') })
    const anonymous = await fetch(f.origin + '/api/bootstrap', { headers: { 'X-Workspace-Token': 'untrusted-token' } })
    assert.equal((await anonymous.json()).user, null); assert.equal(anonymous.headers.get('x-workspace-token'), null)
    const registered = await f.post('/api/register', { username: 'bootstrap-fixture', displayName: 'Fictional bootstrap reader', password: 'fictional-bootstrap-password' })
    assert.equal(registered.status, 201); const account = await registered.json()
    const cookie = registered.headers.get('set-cookie')!.split(';')[0], expected = registered.headers.get('x-workspace-token')!
    const current = await fetch(f.origin + '/api/bootstrap', { headers: { Cookie: cookie, 'X-Workspace-Token': 'stale-token' } })
    assert.equal(current.status, 200); assert.equal((await current.json()).user.id, account.id); assert.equal(current.headers.get('x-workspace-token'), expected)
    f.client.store.db.exec('UPDATE sessions SET workspace_epoch=workspace_epoch+1')
    const changed = await fetch(f.origin + '/api/bootstrap', { headers: { Cookie: cookie, 'X-Workspace-Token': expected } })
    await changed.json(); assert.notEqual(changed.headers.get('x-workspace-token'), expected)
    f.client.store.db.exec('UPDATE sessions SET expires=0')
    const expired = await fetch(f.origin + '/api/bootstrap', { headers: { Cookie: cookie } })
    assert.equal((await expired.json()).user, null); assert.equal(expired.headers.get('x-workspace-token'), null)
  } finally { await f.close() }
})

test('presence diagnostics retain safe counts and shutdown reasons without document identities or capabilities', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vehicle-presence-diagnostics-')), monitor = new BrowserPresence({ onEmpty() {} })
  try {
    const document = registered(monitor)
    new Diagnostics(root).write('info', 'presence.changed', { ...monitor.state, ...document, token: 'c'.repeat(64), shutdownReason: 'confirmed-pages-closed', businessData: 'secret' })
    const raw = await fs.readFile(path.join(root, 'logs', 'diagnostics.jsonl'), 'utf8'), entry = JSON.parse(raw)
    assert.equal(entry.documents, 1); assert.equal(entry.uncertainPages, 1); assert.equal(entry.shutdownReason, 'confirmed-pages-closed')
    for (const secret of [document.pageId, document.pageToken, 'c'.repeat(64), 'secret']) assert(!raw.includes(secret))
  } finally { monitor.stop(); await fs.rm(root, { recursive: true, force: true }) }
})

test('manual service shutdown closes an open presence socket and removes its state file', { timeout: 20000 }, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vehicle-presence-main-'))
  const child = fork(path.join(import.meta.dirname, '..', 'server', 'main.ts'), [], {
    execArgv: ['--import', 'tsx'], env: { ...process.env, PORT: '0', VEHICLE_MANAGER_DATA_DIR: root },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true,
  })
  let diagnostics = ''
  child.stdout?.on('data', bytes => { diagnostics += bytes })
  child.stderr?.on('data', bytes => { diagnostics += bytes })
  let socket: WebSocket | undefined
  const exited = once(child, 'exit')
  try {
    const ready = await new Promise<{ port: number }>((resolve, reject) => {
      child.once('message', message => resolve(message as { port: number }))
      child.once('error', reject)
      child.once('exit', () => reject(new Error(`Service exited before ready: ${diagnostics}`)))
    })
    assert.ok(ready.port, diagnostics)
    child.disconnect()
    const origin = `http://127.0.0.1:${ready.port}`, headers = { 'X-App-Request': 'vehicle-manager', Origin: origin }
    const tokenResponse = await fetch(`${origin}/api/local/browser-presence-token`, { method: 'POST', headers })
    const { token } = await tokenResponse.json() as { token: string }
    socket = new WebSocket(`ws://127.0.0.1:${ready.port}/api/local/browser-presence?token=${token}`, { origin })
    await once(socket, 'open')
    const socketClosed = once(socket, 'close')
    const { controlToken } = JSON.parse(await fs.readFile(path.join(root, 'service.json'), 'utf8')) as { controlToken: string }
    const response = await fetch(`${origin}/api/local/shutdown`, { method: 'POST', headers: { ...headers, 'X-Control-Token': controlToken } })
    assert.equal(response.status, 200)
    await socketClosed
    const [exitCode] = await exited
    assert.equal(exitCode, 0, diagnostics)
    assert.equal(await fs.access(path.join(root, 'service.json')).then(() => true, () => false), false)
    const log = await fs.readFile(path.join(root, 'logs', 'diagnostics.jsonl'), 'utf8')
    for (const event of ['service.starting', 'service.ready', 'service.stopping', 'service.stopped']) assert(log.includes(event), event)
    assert(!log.includes(controlToken)); assert(!log.includes(token))
  } finally {
    socket?.terminate()
    if (child.exitCode === null && child.signalCode === null) { child.kill(); await exited }
    await fs.rm(root, { recursive: true, force: true })
  }
})
