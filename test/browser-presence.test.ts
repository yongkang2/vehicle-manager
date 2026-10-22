import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter, once } from 'node:events'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fork } from 'node:child_process'
import { WebSocket } from 'ws'
import { BrowserPresence, installBrowserPresence } from '../server/browser-presence.js'
import { createApp } from '../server/app.js'

class PageSocket extends EventEmitter {
  readyState: number = WebSocket.OPEN
  pings = 0
  terminated = 0
  ping(callback?: (error?: Error) => void): void { this.pings++; callback?.() }
  terminate(): void { this.terminated++; this.close() }
  close(): void { this.readyState = WebSocket.CLOSED; this.emit('close') }
  asSocket(): WebSocket { return this as unknown as WebSocket }
}

test('presence checks every five minutes and stops an unopened service only once', context => {
  context.mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'], now: 0 })
  let stopped = 0
  const monitor = new BrowserPresence({ onEmpty: () => { stopped++ } })
  monitor.start(); monitor.start()
  context.mock.timers.tick(299999)
  assert.equal(stopped, 0)
  context.mock.timers.tick(1)
  assert.equal(stopped, 1)
  context.mock.timers.tick(600000); monitor.check(); monitor.start()
  assert.equal(stopped, 1)
  const latePage = new PageSocket()
  monitor.attach(latePage.asSocket())
  assert.equal(monitor.count, 0)
  assert.equal(latePage.terminated, 1)
})

test('multiple pages and protocol pong keep the service alive without page activity', context => {
  context.mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'], now: 0 })
  let stopped = 0
  const monitor = new BrowserPresence({ onEmpty: () => { stopped++ } })
  const first = new PageSocket(), second = new PageSocket()
  monitor.attach(first.asSocket()); monitor.attach(first.asSocket()); monitor.attach(second.asSocket()); monitor.start()
  assert.equal(monitor.count, 2)
  context.mock.timers.tick(300000)
  assert.equal(first.pings, 1); assert.equal(second.pings, 1)
  first.emit('pong'); second.emit('pong')
  first.close()
  assert.equal(monitor.count, 1)
  context.mock.timers.tick(300000)
  assert.equal(second.pings, 2)
  second.emit('pong')
  assert.equal(stopped, 0)
  second.close()
  context.mock.timers.tick(300000)
  assert.equal(stopped, 1)
})

test('a page refresh at a check boundary gets a five-second reconnect grace', context => {
  context.mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'], now: 0 })
  let stopped = 0
  const monitor = new BrowserPresence({ onEmpty: () => { stopped++ }, now: () => Date.now() })
  const original = new PageSocket(), refreshed = new PageSocket()
  monitor.attach(original.asSocket()); monitor.start()
  context.mock.timers.tick(299998); original.close(); context.mock.timers.tick(2)
  assert.equal(stopped, 0)
  context.mock.timers.tick(4997)
  monitor.attach(refreshed.asSocket())
  context.mock.timers.tick(1)
  assert.equal(stopped, 0)
  assert.equal(monitor.count, 1)
  refreshed.close(); monitor.check()
  context.mock.timers.tick(4999)
  assert.equal(stopped, 0)
  context.mock.timers.tick(1)
  assert.equal(stopped, 1)
})

test('a missed protocol pong confirms a dead page without waiting for another check', context => {
  context.mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'], now: 0 })
  let stopped = 0
  const monitor = new BrowserPresence({ onEmpty: () => { stopped++ } })
  const page = new PageSocket()
  monitor.attach(page.asSocket()); monitor.start()
  context.mock.timers.tick(300000)
  page.emit('pong')
  context.mock.timers.tick(10000)
  assert.equal(monitor.count, 1)
  context.mock.timers.tick(290000)
  assert.equal(page.pings, 2)
  context.mock.timers.tick(10000)
  assert.equal(page.terminated, 1)
  assert.equal(monitor.count, 0)
  context.mock.timers.tick(4999)
  assert.equal(stopped, 0)
  context.mock.timers.tick(1)
  assert.equal(stopped, 1)
})

test('a heartbeat deadline delayed by system sleep retries before declaring the page closed', context => {
  context.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] })
  let now = 0, stopped = 0
  const monitor = new BrowserPresence({ onEmpty: () => { stopped++ }, now: () => now })
  const page = new PageSocket()
  monitor.attach(page.asSocket()); monitor.check()
  assert.equal(page.pings, 1)
  // The wall clock advances during sleep before the old timeout can run.
  now = 300000
  context.mock.timers.tick(10000)
  assert.equal(page.pings, 2)
  assert.equal(page.terminated, 0)
  assert.equal(monitor.count, 1)
  page.emit('pong')
  now += 20000
  context.mock.timers.tick(20000)
  assert.equal(monitor.count, 1)
  assert.equal(stopped, 0)
  monitor.stop()
})

test('stop clears check, heartbeat and reconnect timers and closes every page', context => {
  context.mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'], now: 0 })
  let stopped = 0
  const monitor = new BrowserPresence({ onEmpty: () => { stopped++ } })
  const first = new PageSocket(), second = new PageSocket()
  monitor.attach(first.asSocket()); monitor.attach(second.asSocket()); monitor.start(); monitor.check(); monitor.stop(); monitor.stop()
  assert.equal(monitor.count, 0)
  assert.equal(first.terminated, 1); assert.equal(second.terminated, 1)
  context.mock.timers.tick(1000000)
  assert.equal(stopped, 0)
  const graceMonitor = new BrowserPresence({ onEmpty: () => { stopped++ } })
  const page = new PageSocket()
  graceMonitor.attach(page.asSocket()); page.close(); graceMonitor.check(); graceMonitor.stop()
  context.mock.timers.tick(1000000)
  assert.equal(stopped, 0)
})

test('checks discard already closed sockets even if their close event was lost', context => {
  context.mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'], now: 0 })
  let stopped = 0
  const monitor = new BrowserPresence({ onEmpty: () => { stopped++ } })
  const page = new PageSocket()
  monitor.attach(page.asSocket()); page.readyState = WebSocket.CLOSED; monitor.check()
  assert.equal(monitor.count, 0)
  context.mock.timers.tick(5000)
  assert.equal(stopped, 1)
})

async function until(predicate: () => boolean): Promise<void> {
  for (let attempts = 0; attempts < 100 && !predicate(); attempts++) await new Promise(resolve => setTimeout(resolve, 10))
  assert.ok(predicate(), 'Expected connection lifecycle change')
}

test('presence token works before login, requires the app header, and upgrades only its own origin', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vehicle-presence-api-'))
  const token = 'a'.repeat(64), monitor = new BrowserPresence({ onEmpty: () => {} })
  const { app, store } = createApp({ dataDir: root, browserPresence: monitor, presenceToken: token })
  const server = app.listen(0, '127.0.0.1')
  const dispose = installBrowserPresence(server, monitor, { token })
  const clients: WebSocket[] = []
  if (!server.listening) await once(server, 'listening')
  const port = (server.address() as { port: number }).port
  const origin = `http://127.0.0.1:${port}`, endpoint = '/api/local/browser-presence-token'
  async function rejected(query: string, suppliedOrigin?: string, pathname = '/api/local/browser-presence') {
    const socket = new WebSocket(`ws://127.0.0.1:${port}${pathname}?token=${query}`, suppliedOrigin ? { origin: suppliedOrigin } : {})
    clients.push(socket)
    const response = await new Promise<number>((resolve, reject) => {
      socket.once('unexpected-response', (_request, response) => { response.resume(); resolve(response.statusCode || 0); socket.terminate() })
      socket.once('open', () => reject(new Error('Unsafe presence connection accepted')))
      socket.on('error', () => {})
    })
    assert.equal(response, 403)
  }
  try {
    assert.equal((await fetch(`${origin}/api/status`)).status, 401)
    assert.equal((await fetch(`${origin}${endpoint}`, { method: 'POST' })).status, 403)
    assert.equal((await fetch(`${origin}${endpoint}`, { method: 'POST', headers: { 'X-App-Request': 'wrong' } })).status, 403)
    const response = await fetch(`${origin}${endpoint}`, { method: 'POST', headers: { 'X-App-Request': 'vehicle-manager' } })
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), { token })
    await rejected('b'.repeat(64), origin)
    await rejected(token)
    await rejected(token, 'http://example.com')
    await rejected(token, 'null')
    await rejected(token, `http://localhost:${port}`)
    await rejected(token, origin, '/api/unknown')
    assert.equal(monitor.count, 0)
    const socket = new WebSocket(`ws://127.0.0.1:${port}/api/local/browser-presence?token=${token}`, { origin })
    clients.push(socket); await once(socket, 'open'); await until(() => monitor.count === 1)
    monitor.check()
    await once(socket, 'ping')
    assert.equal(monitor.count, 1)
    const closed = once(socket, 'close'); socket.close(); await closed
    await until(() => monitor.count === 0)
  } finally {
    monitor.stop(); dispose()
    for (const socket of clients) socket.terminate()
    await new Promise<void>(resolve => server.close(() => resolve()))
    store.db.close(); await fs.rm(root, { recursive: true, force: true })
  }
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
    const origin = `http://127.0.0.1:${ready.port}`, headers = { 'X-App-Request': 'vehicle-manager' }
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
  } finally {
    socket?.terminate()
    if (child.exitCode === null && child.signalCode === null) { child.kill(); await exited }
    await fs.rm(root, { recursive: true, force: true })
  }
})
