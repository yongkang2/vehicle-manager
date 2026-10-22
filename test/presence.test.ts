import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { WebSocket } from 'ws'
import { createPresence } from '../server/presence.js'
import { createApp } from '../server/app.js'
import { promises as fs } from 'node:fs'
import path from 'node:path'

test('presence supports multiple tabs, reconnect grace, sleep recovery and final shutdown', async () => {
  const server = createServer()
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  let time = 0, stopped = 0
  const presence = createPresence(server, () => { stopped++ }, { now: () => time, intervalMs: 100, graceMs: 200, startupMs: 500 })
  const port = (server.address() as { port: number }).port
  const clients: WebSocket[] = []
  async function connect() {
    const client = new WebSocket(`ws://127.0.0.1:${port}/api/local/presence`, ['vehicle-manager', presence.token], { origin: `http://127.0.0.1:${port}` })
    clients.push(client); await once(client, 'open'); return client
  }
  async function close(client: WebSocket) {
    const remaining = presence.connections - 1
    client.close(); await once(client, 'close')
    for (let attempt = 0; attempt < 100 && presence.connections !== remaining; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 5))
    }
    assert.equal(presence.connections, remaining)
  }
  try {
    time = 100; presence.check(); assert.equal(stopped, 0)
    const first = await connect(), second = await connect()
    await close(first)
    time = 200; presence.check()
    await once(second, 'ping')
    await new Promise(resolve => setImmediate(resolve))
    await close(second)
    time = 300; presence.check(); assert.equal(stopped, 0)
    const refreshed = await connect()
    time = 400; presence.check(); await once(refreshed, 'ping')
    time = 10000; presence.check(); assert.equal(stopped, 0)
    await close(refreshed)
    time = 10100; presence.check(); assert.equal(stopped, 0)
    time = 10200; presence.check(); assert.equal(stopped, 1)
  } finally {
    presence.stop(); for (const client of clients) client.terminate()
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
})

test('presence rejects invalid tokens and foreign origins', async () => {
  const server = createServer()
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const presence = createPresence(server, () => {})
  const port = (server.address() as { port: number }).port
  try {
    for (const [token, origin] of [[presence.token, 'http://evil.example'], ['0'.repeat(64), `http://127.0.0.1:${port}`]]) {
      const client = new WebSocket(`ws://127.0.0.1:${port}/api/local/presence`, ['vehicle-manager', token], { origin })
      const [error] = await once(client, 'error')
      assert.match(error.message, /403/)
    }
  } finally {
    presence.stop(); await new Promise<void>(resolve => server.close(() => resolve()))
  }
})

test('startup allowance and late timer recovery protect a newly resumed service', () => {
  const server = createServer()
  let time = 0, stopped = 0
  const presence = createPresence(server, () => { stopped++ }, { now: () => time, intervalMs: 100, graceMs: 200, startupMs: 500 })
  try {
    for (time = 100; time <= 400; time += 100) presence.check()
    assert.equal(stopped, 0)
    time = 10000; presence.check(); assert.equal(stopped, 0)
    time = 10100; presence.check(); assert.equal(stopped, 0)
    time = 10200; presence.check(); assert.equal(stopped, 1)
    presence.check(); assert.equal(stopped, 1)
  } finally { presence.stop() }
})

test('missing pong gets a fresh chance after sleep before termination', async () => {
  const server = createServer()
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  let time = 0, stopped = 0
  const presence = createPresence(server, () => { stopped++ }, { now: () => time, intervalMs: 100, graceMs: 200 })
  const port = (server.address() as { port: number }).port
  const client = new WebSocket(`ws://127.0.0.1:${port}/api/local/presence`, ['vehicle-manager', presence.token], { origin: `http://127.0.0.1:${port}`, autoPong: false })
  try {
    await once(client, 'open')
    time = 100; presence.check(); await once(client, 'ping')
    time = 10000; presence.check(); await once(client, 'ping')
    assert.equal(presence.connections, 1); assert.equal(stopped, 0)
    const closed = once(client, 'close')
    time = 10100; presence.check(); await closed
    for (let attempt = 0; attempt < 100 && presence.connections; attempt++) await new Promise(resolve => setTimeout(resolve, 5))
    time = 10200; presence.check(); assert.equal(stopped, 0)
    time = 10300; presence.check(); assert.equal(stopped, 1)
  } finally {
    client.terminate(); presence.stop(); await new Promise<void>(resolve => server.close(() => resolve()))
  }
})

test('token requires app header and same origin, including before login', async () => {
  const directory = await fs.mkdtemp(path.join(import.meta.dirname, 'test-data-presence-'))
  const { app, store } = createApp({ dataDir: directory, presenceToken: () => 'test-token' })
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening')
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  try {
    for (const headers of [{ Origin: origin }, { Origin: 'http://evil.example', 'X-App-Request': 'vehicle-manager' }]) {
      const response = await fetch(`${origin}/api/local/presence-token`, { method: 'POST', headers })
      assert.equal(response.status, 403)
    }
    const response = await fetch(`${origin}/api/local/presence-token`, { method: 'POST', headers: { Origin: origin, 'X-App-Request': 'vehicle-manager' } })
    assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store')
    assert.deepEqual(await response.json(), { token: 'test-token' })
    assert.equal((await fetch(`${origin}/api/status`)).status, 401)
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve())); store.db.close()
    await fs.rm(directory, { recursive: true, force: true })
  }
})