import { test, mock } from 'node:test'
import { PublicClientApplication } from '@azure/msal-node'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { generateKeyPair, SignJWT } from 'jose'
import { LocalStore } from '../server/store.js'
import { resolveMicrosoftAccount, verifyMicrosoftIdentity } from '../server/microsoft-auth.js'
import { createApp } from '../server/app.js'

const tenant = '11111111-1111-1111-1111-111111111111', objectId = '22222222-2222-2222-2222-222222222222'
test('Microsoft tokens require a trusted signature, tenant, audience, nonce and lifetime', async () => {
  const { privateKey, publicKey } = await generateKeyPair('RS256')
  const key = async () => publicKey
  const sign = (claims = {}, audience = 'app', expiration = '5m') => new SignJWT({ tid: tenant, oid: objectId, nonce: 'nonce', ...claims }).setProtectedHeader({ alg: 'RS256' }).setIssuer(`https://login.microsoftonline.com/${tenant}/v2.0`).setAudience(audience).setSubject('subject').setIssuedAt().setExpirationTime(expiration).sign(privateKey)
  const token = await sign()
  assert.equal((await verifyMicrosoftIdentity(token, 'app', 'nonce', tenant, key)).objectId, objectId)
  await assert.rejects(verifyMicrosoftIdentity(token, 'other', 'nonce', tenant, key))
  await assert.rejects(verifyMicrosoftIdentity(token, 'app', 'wrong', tenant, key))
  await assert.rejects(verifyMicrosoftIdentity(token, 'app', 'nonce', objectId, key))
  await assert.rejects(verifyMicrosoftIdentity(await sign({}, 'app', '-1s'), 'app', 'nonce', tenant, key))
  await assert.rejects(verifyMicrosoftIdentity(await sign({ oid: 'invalid' }), 'app', 'nonce', tenant, key))
  const other = await generateKeyPair('RS256')
  await assert.rejects(verifyMicrosoftIdentity(token, 'app', 'nonce', tenant, async () => other.publicKey))
  await assert.rejects(verifyMicrosoftIdentity(await sign({ tid: '9188040d-6c67-4c5b-b112-36a304b66dad' }), 'app', 'nonce', undefined, key))
})

test('binding preserves local identity, rejects duplicates and requires an active originating session', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'microsoft-auth-')), store = new LocalStore(root)
  try {
    for (const id of ['one', 'two']) store.db.prepare('INSERT INTO accounts VALUES(?,?,?,?,?,?)').run(id, id, id, 'salt', 'hash', new Date().toISOString())
    store.db.prepare('INSERT INTO sessions(token,user_id,expires) VALUES(?,?,?)').run('session', 'one', Date.now() + 60_000)
    const identity = { tenantId: tenant, objectId, label: 'Person', verifiedAt: new Date().toISOString() }
    assert.throws(() => resolveMicrosoftAccount(store, identity), { code: 'MICROSOFT_NOT_BOUND' })
    assert.throws(() => resolveMicrosoftAccount(store, identity, { userId: 'two', sessionToken: 'session' }))
    assert.equal(resolveMicrosoftAccount(store, identity, { userId: 'one', sessionToken: 'session' }).id, 'one')
    assert.equal(resolveMicrosoftAccount(store, { ...identity, label: 'Renamed' }).id, 'one')
    assert.throws(() => resolveMicrosoftAccount(store, identity, { userId: 'one', sessionToken: 'session' }))
    const another = { ...identity, objectId: tenant }
    assert.throws(() => resolveMicrosoftAccount(store, another, { userId: 'one', sessionToken: 'session' }))
    assert.throws(() => resolveMicrosoftAccount(store, another, { userId: 'two', sessionToken: 'expired' }))
    assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM accounts').get()!.n, 2)
  } finally { store.db.close(); await rm(root, { recursive: true, force: true }) }
})

test('unconfigured installations preserve local login and reject unsolicited callbacks', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'microsoft-http-'))
  const client = createApp({ dataDir: root }), server = client.app.listen(0, '127.0.0.1')
  if (!server.listening) await new Promise(resolve => server.once('listening', resolve))
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  try {
    assert.deepEqual(await (await fetch(`${origin}/api/microsoft/status`)).json(), { configured: false, identity: null })
    const start = await fetch(`${origin}/api/microsoft/start`, { method: 'POST', headers: { 'X-App-Request': 'vehicle-manager', Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ mode: 'login' }) })
    assert.equal(start.status, 503)
    const callback = await fetch(`${origin}/api/microsoft/callback?state=forged&code=forged`, { redirect: 'manual' })
    assert.equal(callback.headers.get('location'), '/?microsoft=failed')
    assert.equal(callback.headers.get('set-cookie'), null)
    const registration = await fetch(`${origin}/api/register`, { method: 'POST', headers: { 'X-App-Request': 'vehicle-manager', 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'local-user', displayName: 'Local user', password: 'test-password-long' }) })
    assert.equal(registration.status, 201)
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); await client.close(); await rm(root, { recursive: true, force: true }) }
})

test('configured start pins origin, sets PKCE and consumes cancelled browser-bound flows once', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'microsoft-flow-'))
  const previous = process.env.VEHICLE_MANAGER_MICROSOFT_CLIENT_ID
  process.env.VEHICLE_MANAGER_MICROSOFT_CLIENT_ID = tenant
  const client = createApp({ dataDir: root })
  if (previous === undefined) delete process.env.VEHICLE_MANAGER_MICROSOFT_CLIENT_ID
  else process.env.VEHICLE_MANAGER_MICROSOFT_CLIENT_ID = previous
  let parameters: Record<string, unknown> = {}
  const authMock = mock.method(PublicClientApplication.prototype, 'getAuthCodeUrl', async (request: Record<string, unknown>) => { parameters = request; return 'https://login.microsoftonline.com/organizations/oauth2/v2.0/authorize' })
  const server = client.app.listen(0, '127.0.0.1')
  if (!server.listening) await new Promise(resolve => server.once('listening', resolve))
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  const start = (source: string, mode = 'login') => fetch(`${origin}/api/microsoft/start`, { method: 'POST', headers: { Origin: source, 'X-App-Request': 'vehicle-manager', 'Content-Type': 'application/json' }, body: JSON.stringify({ mode }) })
  try {
    assert.equal((await start('https://attacker.invalid')).status, 403)
    assert.equal((await start(origin, 'bind')).status, 401)
    const response = await start(origin)
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), { url: 'https://login.microsoftonline.com/organizations/oauth2/v2.0/authorize' })
    assert.equal(parameters.codeChallengeMethod, 'S256')
    assert.equal(parameters.redirectUri, `${origin}/api/microsoft/callback`)
    assert.deepEqual(parameters.scopes, ['openid', 'profile'])
    const cookie = response.headers.get('set-cookie')!.split(';')[0]
    assert.match(response.headers.get('set-cookie')!, /HttpOnly/)
    const callback = `${origin}/api/microsoft/callback?state=${parameters.state}&error=access_denied`
    const foreign = await fetch(callback, { redirect: 'manual' })
    assert.equal(foreign.headers.get('location'), '/?microsoft=failed')
    const cancelled = await fetch(callback, { headers: { Cookie: cookie }, redirect: 'manual' })
    assert.match(cancelled.headers.get('set-cookie')!, /Expires=/)
    const replay = await fetch(callback, { headers: { Cookie: cookie }, redirect: 'manual' })
    assert.equal(replay.headers.get('set-cookie'), null)
    assert.equal(client.store.get('microsoftBindings'), null)
  } finally { authMock.mock.restore(); await new Promise<void>(resolve => server.close(() => resolve())); await client.close(); await rm(root, { recursive: true, force: true }) }
})
