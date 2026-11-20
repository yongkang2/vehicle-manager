import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createApp } from '../server/app.js'

test('local password change validates, rolls back atomically, revokes own sessions only and preserves data', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'account-password-'))
  const client = createApp({ dataDir: root }), server = client.app.listen(0, '127.0.0.1')
  if (!server.listening) await new Promise(resolve => server.once('listening', resolve))
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  const request = (url: string, body?: unknown, cookie = '') => fetch(origin + '/api' + url, { method: body ? 'POST' : 'GET', headers: { Cookie: cookie, 'X-App-Request': 'vehicle-manager', 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined })
  const account = { username: 'employee', displayName: 'Employee', password: 'old-password-long' }
  try {
    const first = (await request('/register', account)).headers.get('set-cookie')!.split(';')[0]
    const second = (await request('/login', account)).headers.get('set-cookie')!.split(';')[0]
    const other = (await request('/register', { ...account, username: 'other' })).headers.get('set-cookie')!.split(';')[0]
    const body = { currentPassword: account.password, newPassword: ' new-password-long ' }
    const before = client.store.db.prepare('SELECT * FROM accounts WHERE username=?').get(account.username)!
    client.store.set('retained-test-data', { pending: ['keep'], conflict: 'keep' })
    assert.equal((await request('/account/password', body)).status, 401)
    assert.equal((await request('/account/password', { ...body, currentPassword: 'wrong' }, first)).status, 401)
    assert.equal((await request('/account/password', { ...body, newPassword: account.password }, first)).status, 400)
    client.store.db.exec("CREATE TRIGGER reject_password_audit BEFORE INSERT ON local_events WHEN NEW.action='account.password.changed' BEGIN SELECT RAISE(ABORT,'test rollback'); END")
    assert.equal((await request('/account/password', body, first)).status, 500)
    assert.deepEqual(client.store.db.prepare('SELECT * FROM accounts WHERE username=?').get(account.username), before)
    assert.equal((await request('/status', undefined, second)).status, 200)
    client.store.db.exec('DROP TRIGGER reject_password_audit')
    assert.equal((await request('/account/password', body, first)).status, 200)
    assert.equal((await request('/status', undefined, first)).status, 401)
    assert.equal((await request('/status', undefined, second)).status, 401)
    assert.equal((await request('/status', undefined, other)).status, 200)
    assert.equal((await request('/login', account)).status, 401)
    assert.equal((await request('/login', { ...account, password: body.newPassword })).status, 200)
    const after = client.store.db.prepare('SELECT * FROM accounts WHERE username=?').get(account.username)!
    assert.equal(after.id, before.id); assert.notEqual(after.salt, before.salt); assert.notEqual(after.hash, before.hash)
    assert.deepEqual(client.store.get('retained-test-data'), { pending: ['keep'], conflict: 'keep' })
    const audit = client.store.db.prepare("SELECT detail FROM local_events WHERE action='account.password.changed'").get()!
    assert.ok(!String(audit.detail).includes(body.newPassword)); assert.ok(!String(audit.detail).includes(String(after.hash)))
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); await client.close(); await rm(root, { recursive: true, force: true }) }
})
