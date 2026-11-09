import { test } from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import express from 'express'
import { createApp } from '../server/app.js'
import { deflateSync } from 'node:zlib'

function png() {
  const chunk = (type: string, data: Buffer) => {
    const bytes = Buffer.concat([Buffer.from(type), data]), prefix = Buffer.alloc(4), suffix = Buffer.alloc(4)
    let crc = 0xffffffff
    for (const byte of bytes) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1 }
    prefix.writeUInt32BE(data.length); suffix.writeUInt32BE((crc ^ 0xffffffff) >>> 0)
    return Buffer.concat([prefix, bytes, suffix])
  }
  const header = Buffer.alloc(13); header.writeUInt32BE(1); header.writeUInt32BE(1, 4); header[8] = 8; header[9] = 6
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(Buffer.from([0, 255, 0, 0, 255]))), chunk('IEND', Buffer.alloc(0))])
}

test('intake requires workspace access, returns suggestions without writing and rejects stale workspace tokens', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'intake-api-'))
  const client = createApp({ dataDir: path.join(directory, 'local') }), server = client.app.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const gateway = express(); gateway.use(express.json()); gateway.post('/v1/recognitions', (_req, res) => res.json({ fields: { vin: 'TEST0000000000001' } }))
  const mock = gateway.listen(0, '127.0.0.1'); await once(mock, 'listening')
  const oldUrl = process.env.VEHICLE_AI_GATEWAY_URL, oldToken = process.env.VEHICLE_AI_DEVICE_TOKEN
  process.env.VEHICLE_AI_GATEWAY_URL = `http://127.0.0.1:${(mock.address() as { port: number }).port}`; process.env.VEHICLE_AI_DEVICE_TOKEN = 'fictional-device-token-'.repeat(2)
  let cookie = '', token = ''
  const request = async (route: string, body?: unknown, suppliedToken = token) => {
    const response = await fetch(`http://127.0.0.1:${(server.address() as { port: number }).port}/api${route}`, { method: body === undefined ? 'GET' : 'POST', headers: { Cookie: cookie, 'X-App-Request': 'vehicle-manager', 'X-Workspace-Token': suppliedToken, ...(body instanceof FormData ? {} : { 'Content-Type': 'application/json' }) }, body: body === undefined ? undefined : body instanceof FormData ? body : JSON.stringify(body) })
    cookie = response.headers.get('set-cookie')?.split(';')[0] || cookie; token = response.headers.get('x-workspace-token') || token
    return { status: response.status, data: await response.json() }
  }
  const upload = () => { const form = new FormData(); form.append('file', new Blob([png()]), 'label.png'); return form }
  try {
    assert.equal((await request('/business/intake/recognize', upload())).status, 401)
    assert.equal((await request('/register', { username: 'intake', displayName: 'Intake tester', password: 'fictional-password' })).status, 201)
    const shared = path.join(directory, 'shared'); await fs.mkdir(shared)
    assert.equal((await request('/setup/configure', { path: shared, mode: 'create', teamName: 'Test', confirmed: true, retainPending: true })).status, 200)
    const before = await request('/business/records')
    const result = await request('/business/intake/recognize', upload())
    assert.equal(result.status, 200, JSON.stringify(result.data))
    assert.deepEqual(result.data, { fields: { vin: 'TEST0000000000001' }, matches: [] })
    assert.deepEqual((await request('/business/records')).data, before.data)
    assert.equal((await request('/business/intake/recognize', upload(), 'stale')).status, 409)
    process.env.VEHICLE_AI_GATEWAY_URL = ''; process.env.VEHICLE_AI_DEVICE_TOKEN = ''
    assert.equal((await request('/business/intake/recognize', upload())).status, 503)
  } finally {
    if (oldUrl === undefined) delete process.env.VEHICLE_AI_GATEWAY_URL; else process.env.VEHICLE_AI_GATEWAY_URL = oldUrl
    if (oldToken === undefined) delete process.env.VEHICLE_AI_DEVICE_TOKEN; else process.env.VEHICLE_AI_DEVICE_TOKEN = oldToken
    await new Promise<void>(resolve => server.close(() => resolve())); await new Promise<void>(resolve => mock.close(() => resolve())); await client.close(); await fs.rm(directory, { recursive: true, force: true })
  }
})
