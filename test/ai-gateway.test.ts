import { test } from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createAiGateway } from '../server/ai-gateway.js'
import { deflateSync } from 'node:zlib'

function image() {
  function chunk(type: string, data: Buffer) {
    const bytes = Buffer.concat([Buffer.from(type), data]), header = Buffer.alloc(4), tail = Buffer.alloc(4)
    let crc = 0xffffffff
    for (const byte of bytes) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1 }
    header.writeUInt32BE(data.length); tail.writeUInt32BE((crc ^ 0xffffffff) >>> 0)
    return Buffer.concat([header, bytes, tail])
  }
  const header = Buffer.alloc(13); header.writeUInt32BE(1); header.writeUInt32BE(1, 4); header[8] = 8; header[9] = 6
  return 'data:image/png;base64,' + Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(Buffer.from([0, 255, 0, 0, 255]))), chunk('IEND', Buffer.alloc(0))]).toString('base64')
}

test('status identifies invalid provider credentials without leaking secrets', async () => {
  const token = 'z'.repeat(40), secret = 'private-provider-secret'
  let calls = 0
  const app = createAiGateway({ apiKey: secret, deviceTokens: [token], fetcher: async (url) => {
    assert.equal(url, 'https://api.deepseek.com/models'); calls++
    return new Response(JSON.stringify({ error: { message: secret } }), { status: 401 })
  } })
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening')
  try {
    const response = await fetch('http://127.0.0.1:' + (server.address() as { port: number }).port + '/v1/status', { headers: { Authorization: 'Bearer ' + token } })
    assert.equal(response.status, 503)
    assert.deepEqual(await response.json(), { error: 'AI_PROVIDER_AUTH' })
    assert.equal(calls, 1)
  } finally { await new Promise<void>(resolve => server.close(() => resolve())) }
})

test('gateway authenticates devices, rejects nonimages and isolates provider failures', async () => {
  let calls = 0
  const token = 'x'.repeat(40)
  const app = createAiGateway({ apiKey: 'server-only-secret', deviceTokens: [token], dailyLimit: 1, fetcher: async (_url, options) => {
    calls++
    assert.equal(new Headers(options?.headers).get('Authorization'), 'Bearer server-only-secret')
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ serial: '00123', lifeStatus: 'BOL' }) } }] }))
  } })
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening')
  const address = server.address() as { port: number }
  const send = (body: unknown, auth = token) => fetch(`http://127.0.0.1:${address.port}/v1/recognitions`, { method: 'POST', headers: { Authorization: `Bearer ${auth}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  try {
    assert.equal((await send({}, 'wrong')).status, 401)
    assert.equal((await send({ image: 'https://internal.test/secret' })).status, 400)
    assert.equal((await send({ image: 'data:image/png;base64,ZmFrZQ==' })).status, 400)
    assert.equal(calls, 0)
    const png = image()
    const result = await send({ image: png })
    assert.equal(result.status, 200)
    assert.deepEqual(await result.json(), { fields: { serial: '00123' } })
    assert.equal(calls, 1)
    assert.equal((await send({ image: png })).status, 429)
    const rawTokenResponse = await fetch(`http://127.0.0.1:${address.port}/v1/recognitions`, { method: 'POST', headers: { Authorization: token, 'Content-Type': 'application/json' }, body: JSON.stringify({ image: png }) })
    assert.equal(rawTokenResponse.status, 401)
  } finally { await new Promise<void>(resolve => server.close(() => resolve())) }
})
