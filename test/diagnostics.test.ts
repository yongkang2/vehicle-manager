import { test } from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Diagnostics } from '../server/diagnostics.js'

test('diagnostics retain only safe fields and bounded error frames', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vm-diagnostics-'))
  try {
    const log = new Diagnostics(root)
    const error = Object.assign(new Error('password=secret private-path VIN'), { code: 'EACCES' })
    error.stack = 'Error: secret\n    at execute (C:\\private\\diagnostics.ts:12:3)'
    log.write('error', 'request.failed', { requestId: '123e4567-e89b-12d3-a456-426614174000', method: 'POST', route: '/api/login', status: 500, password: 'secret', token: 'secret', body: { secret: true } }, error)
    const raw = await fs.readFile(path.join(root, 'logs', 'diagnostics.jsonl'), 'utf8'), entry = JSON.parse(raw)
    assert.equal(entry.event, 'request.failed'); assert.equal(entry.error.code, 'EACCES')
    assert.equal(entry.error.frames[0], 'diagnostics.ts:12:3')
    assert.equal(entry.status, 500); assert(entry.time); assert(entry.version)
    for (const secret of ['secret', 'password', 'private', 'server', 'VIN', 'token', 'body']) assert(!raw.includes(secret), secret)
  } finally { await fs.rm(root, { recursive: true, force: true }) }
})

test('diagnostics rotate within their fixed disk budget and tolerate unavailable storage', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vm-diagnostics-'))
  try {
    const log = new Diagnostics(root)
    await fs.mkdir(path.join(root, 'logs'))
    for (let index = 0; index < 6; index++) {
      await fs.writeFile(path.join(root, 'logs', 'diagnostics.jsonl'), 'x'.repeat(2 * 1024 * 1024))
      log.write('warn', 'test.rotation', {})
    }
    const names = await fs.readdir(path.join(root, 'logs'))
    assert.equal(names.length, 4)
    for (const name of names) assert((await fs.stat(path.join(root, 'logs', name))).size <= 2 * 1024 * 1024)
    const blocked = path.join(root, 'blocked'); await fs.writeFile(blocked, 'file')
    assert.doesNotThrow(() => new Diagnostics(blocked).write('error', 'test.failure', {}, new Error('sensitive')))
    t.mock.method(console, 'error', () => { throw new Error('Output unavailable') })
    assert.doesNotThrow(() => new Diagnostics(blocked).write('error', 'test.failure', {}, new Error('sensitive')))
  } finally { await fs.rm(root, { recursive: true, force: true }) }
})


test('background synchronization records failure once without exposing share paths', async t => {
  const { LocalStore } = await import('../server/store.js')
  const { Business } = await import('../server/business.js')
  const { BusinessSync } = await import('../server/sync.js')
  const { TeamDirectory, AppError } = await import('../server/team.js')
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vm-diagnostics-sync-')), store = new LocalStore(root)
  try {
    const teams = new TeamDirectory(), sync = new BusinessSync(new Business(store), teams)
    t.mock.method(teams, 'withAccess', async () => { throw new AppError('SHARE_UNAVAILABLE', 409) })
    const identity = { deviceId: store.deviceId, deviceName: 'private-machine', localUserId: 'private-user', displayName: 'private-name' }
    for (let index = 0; index < 2; index++) assert.equal((await sync.synchronize('private-share', 'private-team', identity)).error, 'SHARE_UNAVAILABLE')
    const raw = await fs.readFile(path.join(root, 'logs', 'diagnostics.jsonl'), 'utf8'), rows = raw.trim().split('\n').map(line => JSON.parse(line))
    assert.equal(rows.filter(row => row.event === 'sync.failed').length, 1)
    assert.equal(rows[0].code, 'SHARE_UNAVAILABLE')
    assert(!raw.includes('private-'))
  } finally { store.db.close(); await fs.rm(root, { recursive: true, force: true }) }
})
