import { test } from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createApp } from '../server/app.js'
import { Business } from '../server/business.js'
import { defaultVehicleTablePreferences } from '../shared/vehicle-table.js'
import type { BusinessRecord } from '../shared/business.js'

const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==', 'base64')
const password = 'customization-test-password'
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done }); return { promise, resolve } }
function photo(version: number, bytes = image, name = 'fictional.png', reason = 'Update fictional cover') {
  const body = new FormData()
  body.append('file', new Blob([new Uint8Array(bytes)]), name); body.append('version', String(version)); body.append('reason', reason)
  return body
}
async function fixture() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'vehicle-customization-api-'))
  let client = createApp({ dataDir: path.join(directory, 'local') }), server = client.app.listen(0, '127.0.0.1')
  if (!server.listening) await once(server, 'listening')
  const sessions = new Map<string, { cookie: string; token: string }>()
  async function request(route: string, { method = 'GET', body, session = 'owner', token, settle = true, signal }: { method?: string; body?: unknown; session?: string; token?: string; settle?: boolean; signal?: AbortSignal } = {}) {
    const credentials = sessions.get(session) || { cookie: '', token: '' }, form = body instanceof FormData
    const response = await fetch(`http://127.0.0.1:${(server.address() as { port: number }).port}/api${route}`, { method, signal, headers: { Cookie: credentials.cookie, 'X-App-Request': 'vehicle-manager', 'X-Workspace-Token': token ?? credentials.token, ...(body !== undefined && !form ? { 'Content-Type': 'application/json' } : {}) }, body: body === undefined ? undefined : form ? body as FormData : JSON.stringify(body) })
    const cookie = response.headers.get('set-cookie'); if (cookie) credentials.cookie = cookie.split(';')[0]
    if (response.ok) credentials.token = response.headers.get('x-workspace-token') || credentials.token
    sessions.set(session, credentials)
    const data = response.headers.get('content-type')?.includes('json') ? await response.json() : Buffer.from(await response.arrayBuffer())
    if (settle) await client.synchronization.settle()
    return { status: response.status, data, headers: response.headers }
  }
  async function register(session = 'owner') {
    const result = await request('/register', { method: 'POST', session, body: { username: `custom-${session}`, displayName: session, password } })
    assert.equal(result.status, 201, JSON.stringify(result.data)); return result.data as { id: string }
  }
  async function team(name = 'Team A', session = 'owner') {
    const shared = path.join(directory, name); await fs.mkdir(shared)
    const result = await request('/setup/configure', { method: 'POST', session, body: { path: shared, mode: 'create', teamName: name, confirmed: true, retainPending: true } })
    assert.equal(result.status, 200, JSON.stringify(result.data)); return { id: result.data.teamId as string, shared }
  }
  async function member(team: { id: string; shared: string }, session = 'member') {
    const account = await register(session)
    assert.equal((await request('/setup/configure', { method: 'POST', session, body: { path: team.shared, teamId: team.id, mode: 'join' } })).status, 200)
    const roster = (await request('/team')).data
    const pending = roster.requests.find((entry: { status: string }) => entry.status === 'pending')
    assert(pending)
    assert.equal((await request(`/team/requests/${pending.id}/approve`, { method: 'POST', body: { role: 'member', memberId: null, reason: 'Approve fictional member' } })).status, 200)
    assert.equal((await request('/status', { session })).data.member.role, 'member')
    return account
  }
  async function vehicle(session = 'owner', vin = 'TEST0000000000001') {
    const result = await request('/business/records', { method: 'POST', session, body: { kind: 'vehicle', data: { vin, status: 'available', complianceLevel: 'Eu7' }, reason: 'Register fictional vehicle' } })
    assert.equal(result.status, 201, JSON.stringify(result.data)); return result.data as BusinessRecord
  }
  async function reopen() {
    await new Promise<void>(resolve => server.close(() => resolve())); await client.close()
    client = createApp({ dataDir: path.join(directory, 'local') }); server = client.app.listen(0, '127.0.0.1')
    if (!server.listening) await once(server, 'listening')
  }
  async function close() { await new Promise<void>(resolve => server.close(() => resolve())); await client.close(); await fs.rm(directory, { recursive: true, force: true }) }
  return { get client() { return client }, get server() { return server }, directory, sessions, request, register, team, member, vehicle, reopen, close }
}

test('personal column APIs persist across restart without publishing queues, and isolate local accounts/workspaces', async () => {
  const f = await fixture()
  try {
    await f.register(); const a = await f.team(), car = await f.vehicle(), second = await f.member(a)
    const workspace = f.client.workspaces.get(a.id), current = workspace.business.get(car.id)
    workspace.business.write({ id: car.id, kind: 'vehicle', data: { ...current.data, notes: 'Unpublished local edit' }, version: current.version, actor: { id: 'fixture', name: 'Fixture', deviceId: workspace.store.deviceId, role: 'member' }, reason: 'Leave a pending operation' })
    const before = workspace.synchronization.status().pending, headPath = path.join(a.shared, 'business', 'HEAD.json'), head = await fs.readFile(headPath)
    const selected = { version: 1, columns: ['vehicle', 'name', 'vin', 'plateExpiry', 'complianceLevel', 'coolingArchitecture', 'model', 'notes', 'actions'], widths: { model: 333, project: 444, name: 180, vin: 230, plateExpiry: 160, complianceLevel: 170, coolingArchitecture: 200 } }
    for (const paused of [0, 1]) {
      f.client.store.db.prepare('UPDATE sessions SET sync_enabled=? WHERE user_id<>?').run(paused, second.id)
      for (const route of ['/business/vehicle-table-preferences', '/business/VEHICLE-TABLE-PREFERENCES/']) {
        assert.equal((await f.request(route, { method: 'PUT', body: selected })).status, 200)
        assert.deepEqual((await f.request(route)).data, selected)
      }
      assert.equal(workspace.synchronization.status().pending, before)
      assert.deepEqual(await fs.readFile(headPath), head)
    }
    assert.deepEqual((await f.request('/business/vehicle-table-preferences', { session: 'member' })).data, defaultVehicleTablePreferences())
    assert.equal((await f.request('/business/vehicle-table-preferences', { method: 'PUT', session: 'member', body: { ...selected, widths: { model: 555 } } })).status, 200)
    assert.deepEqual((await f.request('/business/vehicle-table-preferences')).data, selected)
    const b = await f.team('Team B')
    assert.deepEqual((await f.request('/business/vehicle-table-preferences')).data, defaultVehicleTablePreferences())
    const stale = f.sessions.get('owner')!.token
    assert.equal((await f.request('/workspaces/select', { method: 'POST', body: { teamId: a.id, retainPending: true } })).status, 200)
    assert.equal((await f.request('/business/vehicle-table-preferences', { method: 'PUT', token: stale, body: defaultVehicleTablePreferences() })).data.error, 'WORKSPACE_CHANGED')
    assert.deepEqual((await f.request('/business/vehicle-table-preferences')).data, selected)
    await f.reopen()
    assert.deepEqual((await f.request('/business/vehicle-table-preferences')).data, selected)
    assert.notEqual(a.id, b.id)
  } finally { await f.close() }
})

test('column APIs reject invalid layouts and require approved access without exposing another account settings', async () => {
  const f = await fixture()
  try {
    assert.equal((await f.request('/business/vehicle-table-preferences')).status, 401)
    await f.register(); const a = await f.team()
    const defaults = defaultVehicleTablePreferences()
    for (const input of [null, [], {}, { ...defaults, version: 2 }, { ...defaults, columns: ['project', 'actions'] }, { ...defaults, columns: ['vehicle', 'project'] }, { ...defaults, columns: ['vehicle', 'vehicle', 'actions'] }, { ...defaults, columns: ['vehicle', 'unknown', 'actions'] }, { ...defaults, widths: { model: 79 } }, { ...defaults, widths: { model: 1001 } }, { ...defaults, widths: { model: 100.5 } }, { ...defaults, widths: { anything: 120 } }, { ...defaults, accountId: 'other' }]) {
      const result = await f.request('/business/vehicle-table-preferences', { method: 'PUT', body: input })
      assert.equal(result.status, 400, JSON.stringify(input)); assert.equal(result.data.error, 'INVALID_INPUT')
    }
    assert.deepEqual((await f.request('/business/vehicle-table-preferences')).data, defaults)
    await f.register('pending')
    await f.request('/setup/configure', { method: 'POST', session: 'pending', body: { path: a.shared, teamId: a.id, mode: 'join' } })
    assert.equal((await f.request('/business/vehicle-table-preferences', { session: 'pending' })).status, 403)
    assert.equal((await f.request('/business/vehicle-table-preferences', { method: 'PUT', session: 'pending', body: defaults })).status, 403)
  } finally { await f.close() }
})

test('member photo APIs render authenticated inline bytes, preserve attachments, and protect reasons and versions', async () => {
  const f = await fixture()
  try {
    await f.register(); const a = await f.team(), car = await f.vehicle(); await f.member(a)
    const workspace = f.client.workspaces.get(a.id)
    assert.equal((await f.request(`/business/vehicles/${car.id}/photo`, { session: 'member' })).data.error, 'PHOTO_NOT_FOUND')
    for (const [body, error] of [[photo(car.version, image, 'fictional.png', ' '), 'REASON_REQUIRED'], [photo(car.version, Buffer.from('not an image')), 'FILE_TYPE_NOT_ALLOWED']] as const) {
      assert.equal((await f.request(`/business/vehicles/${car.id}/photo`, { method: 'POST', session: 'member', body })).data.error, error)
    }
    assert.equal(workspace.business.list('attachment', car.id).length, 0)
    const uploaded = await f.request(`/business/vehicles/${car.id}/photo`, { method: 'POST', session: 'member', body: photo(workspace.business.get(car.id).version) })
    assert.equal(uploaded.status, 201, JSON.stringify(uploaded.data))
    assert.equal(uploaded.data.vehicle.data.photoAttachmentId, uploaded.data.attachment.id)
    const read = await f.request(`/business/vehicles/${car.id}/photo`, { session: 'member' })
    assert.equal(read.status, 200); assert.deepEqual(read.data, image)
    assert.match(read.headers.get('content-type')!, /image\/png/); assert.match(read.headers.get('content-disposition')!, /^inline/)
    assert.match(read.headers.get('content-security-policy')!, /img-src[^;]*blob:/); assert.equal(read.headers.get('cache-control'), 'no-store')
    const current = workspace.business.get(car.id)
    assert.equal((await f.request(`/business/vehicles/${car.id}/photo`, { method: 'POST', session: 'member', body: photo(car.version) })).data.error, 'VERSION_CONFLICT')
    assert.equal(workspace.business.list('attachment', car.id).length, 1)
    const edited = await f.request(`/business/records/${car.id}`, { method: 'PUT', session: 'member', body: { data: { ...current.data, notes: 'Ordinary edit', photoAttachmentId: 'untrusted-id' }, version: current.version, reason: 'Edit other vehicle details' } })
    assert.equal(edited.status, 200); assert.equal(edited.data.data.photoAttachmentId, uploaded.data.attachment.id)
    const replaced = await f.request(`/business/vehicles/${car.id}/photo`, { method: 'POST', session: 'member', body: photo(workspace.business.get(car.id).version, image, 'replacement.png') })
    assert.equal(replaced.status, 201); assert.notEqual(replaced.data.attachment.id, uploaded.data.attachment.id)
    const removed = await f.request(`/business/vehicles/${car.id}/photo`, { method: 'DELETE', session: 'member', body: { version: workspace.business.get(car.id).version, reason: 'Clear cover only' } })
    assert.equal(removed.status, 200); assert.equal(removed.data.data.photoAttachmentId, '')
    assert.equal((await f.request(`/business/vehicles/${car.id}/photo`, { session: 'member' })).data.error, 'PHOTO_NOT_FOUND')
    assert.equal(workspace.business.list('attachment', car.id).length, 2)
    assert.deepEqual((await f.request(`/business/files/${uploaded.data.attachment.id}`, { session: 'member' })).data, image)
    assert(workspace.business.history(car.id).some(change => change.reason === 'Clear cover only'))
  } finally { await f.close() }
})

test('photo writes work offline and paused, while archived vehicles remain read-only', async () => {
  const f = await fixture()
  let hidden = false
  try {
    await f.register(); const a = await f.team(), car = await f.vehicle(); await f.member(a)
    const workspace = f.client.workspaces.get(a.id)
    f.client.store.db.prepare("UPDATE sessions SET sync_enabled=0 WHERE user_id=(SELECT id FROM accounts WHERE username='custom-member')").run()
    const head = await fs.readFile(path.join(a.shared, 'business', 'HEAD.json'))
    await fs.rename(a.shared, a.shared + '-offline'); hidden = true
    const uploaded = await f.request(`/business/vehicles/${car.id}/photo`, { method: 'POST', session: 'member', body: photo(workspace.business.get(car.id).version) })
    assert.equal(uploaded.status, 201, JSON.stringify(uploaded.data)); assert(workspace.synchronization.status().pending >= 2)
    assert.deepEqual((await f.request(`/business/vehicles/${car.id}/photo`, { session: 'member' })).data, image)
    await fs.rename(a.shared + '-offline', a.shared); hidden = false
    assert.deepEqual(await fs.readFile(path.join(a.shared, 'business', 'HEAD.json')), head)
    const archived = await f.request(`/business/records/${car.id}/archive`, { method: 'POST', body: { archived: true, version: workspace.business.get(car.id).version, reason: 'Archive test vehicle' } })
    assert.equal(archived.status, 200)
    assert.equal((await f.request(`/business/vehicles/${car.id}/photo`, { method: 'POST', session: 'member', body: photo(workspace.business.get(car.id).version) })).data.error, 'PARENT_ARCHIVED')
    assert.equal((await f.request(`/business/vehicles/${car.id}/photo`, { method: 'DELETE', session: 'member', body: { version: workspace.business.get(car.id).version, reason: 'Invalid archived edit' } })).data.error, 'PARENT_ARCHIVED')
    assert.equal((await f.request(`/business/vehicles/${car.id}/photo`, { session: 'member' })).status, 200)
  } finally {
    if (hidden) { const old = path.join(f.directory, 'Team A-offline'); await fs.rename(old, path.join(f.directory, 'Team A')) }
    await f.close()
  }
})

for (const outcome of ['logout', 'revoked', 'version'] as const) {
  test(`photo upload rechecks ${outcome} after blob I/O and never partially creates attachment rows`, async () => {
    const f = await fixture(), entered = deferred(), release = deferred(), originalBlob = Business.prototype.blob
    let pending: Promise<unknown> | null = null
    try {
      await f.register(); const a = await f.team(), car = await f.vehicle(); await f.member(a)
      const workspace = f.client.workspaces.get(a.id), beforeCount = workspace.business.list('attachment', car.id).length
      Business.prototype.blob = async function (bytes) { const key = await originalBlob.call(this, bytes); entered.resolve(); await release.promise; return key }
      pending = f.request(`/business/vehicles/${car.id}/photo`, { method: 'POST', session: 'member', body: photo(workspace.business.get(car.id).version), settle: false })
      await entered.promise
      if (outcome === 'logout') await f.request('/logout', { method: 'POST', session: 'member', body: {}, settle: false })
      else if (outcome === 'revoked') {
        const roster = (await f.request('/team', { settle: false })).data, member = roster.members.find((value: { role: string }) => value.role === 'member')
        assert.equal((await f.request(`/team/members/${member.id}`, { method: 'POST', body: { enabled: false, role: 'member', reason: 'Revoke during isolated upload' }, settle: false })).status, 200)
      } else {
        const current = workspace.business.get(car.id)
        workspace.business.write({ id: car.id, kind: 'vehicle', data: { ...current.data, notes: 'Concurrent edit' }, version: current.version, actor: { id: 'fixture', name: 'Fixture', role: 'admin', deviceId: workspace.store.deviceId }, reason: 'Concurrent isolated edit' })
      }
      release.resolve()
      const result = await pending as { status: number; data: { error: string } }
      assert.equal(result.data.error, outcome === 'logout' ? 'LOGIN_REQUIRED' : outcome === 'revoked' ? 'ACCESS_DISABLED' : 'VERSION_CONFLICT')
      assert.equal(workspace.business.list('attachment', car.id).length, beforeCount)
      assert.equal(workspace.business.get(car.id).data.photoAttachmentId, undefined)
    } finally { release.resolve(); if (pending) await pending.catch(() => {}); Business.prototype.blob = originalBlob; await f.close() }
  })
}

test('photo reads recheck the selected cover after I/O and block maintenance only for the scoped workflow', async () => {
  const f = await fixture(), entered = deferred(), release = deferred(), originalRead = Business.prototype.readBlob
  let pending: Promise<unknown> | null = null
  try {
    await f.register(); const a = await f.team(), car = await f.vehicle(), workspace = f.client.workspaces.get(a.id)
    assert.equal((await f.request(`/business/vehicles/${car.id}/photo`, { method: 'POST', body: photo(car.version) })).status, 201)
    Business.prototype.readBlob = async function (key) { const bytes = await originalRead.call(this, key); entered.resolve(); await release.promise; return bytes }
    pending = f.request(`/business/vehicles/${car.id}/photo`, { settle: false })
    await entered.promise
    let maintained = false
    const maintenance = workspace.store.withMaintenance(() => { maintained = true })
    await new Promise(resolve => setTimeout(resolve, 20)); assert.equal(maintained, false)
    release.resolve()
    assert.equal((await pending as { status: number }).status, 200)
    await maintenance; assert.equal(maintained, true)
    assert.equal((await f.request('/business/vehicle-table-preferences', { token: 'stale-token' })).data.error, 'WORKSPACE_CHANGED')
  } finally { release.resolve(); if (pending) await pending.catch(() => {}); Business.prototype.readBlob = originalRead; await f.close() }
})

test('an aborted photo upload still drains before switching workspaces and cannot write into the next team', { timeout: 20000 }, async () => {
  const f = await fixture(), entered = deferred(), release = deferred(), responseClosed = deferred(), originalBlob = Business.prototype.blob
  let uploadRequest: Promise<unknown> | null = null, switching: Promise<unknown> | null = null
  try {
    await f.register(); const a = await f.team(), car = await f.vehicle(), b = await f.team('Team B')
    assert.equal((await f.request('/workspaces/select', { method: 'POST', body: { teamId: a.id, retainPending: true } })).status, 200)
    const workspace = f.client.workspaces.get(a.id)
    f.server.on('request', (incoming, response) => { if (incoming.url?.endsWith('/photo')) response.once('close', responseClosed.resolve) })
    Business.prototype.blob = async function (bytes) { const key = await originalBlob.call(this, bytes); entered.resolve(); await release.promise; return key }
    const controller = new AbortController()
    uploadRequest = f.request(`/business/vehicles/${car.id}/photo`, { method: 'POST', body: photo(workspace.business.get(car.id).version), signal: controller.signal, settle: false }).then(() => 'completed', () => 'aborted')
    await entered.promise; controller.abort(); assert.equal(await uploadRequest, 'aborted'); await responseClosed.promise
    let selected = false
    switching = f.request('/workspaces/select', { method: 'POST', body: { teamId: b.id, retainPending: true }, settle: false }).then(result => { selected = true; return result })
    await new Promise(resolve => setTimeout(resolve, 25)); assert.equal(selected, false)
    release.resolve()
    assert.equal((await switching as { status: number }).status, 200)
    assert.equal((await f.request('/status')).data.teamId, b.id)
    assert.equal(workspace.business.list('attachment', car.id).length, 0)
    assert.equal(workspace.business.get(car.id).data.photoAttachmentId, undefined)
    assert.equal(f.client.workspaces.get(b.id).business.list('attachment').length, 0)
  } finally { release.resolve(); if (uploadRequest) await uploadRequest.catch(() => {}); if (switching) await switching.catch(() => {}); Business.prototype.blob = originalBlob; await f.close() }
})

test('graceful shutdown waits for the complete photo upload before closing workspace and account databases', { timeout: 20000 }, async () => {
  const f = await fixture(), entered = deferred(), release = deferred(), originalBlob = Business.prototype.blob
  let uploadRequest: Promise<unknown> | null = null, closing: Promise<void> | null = null
  try {
    await f.register(); await f.team(); const car = await f.vehicle()
    Business.prototype.blob = async function (bytes) { const key = await originalBlob.call(this, bytes); entered.resolve(); await release.promise; return key }
    uploadRequest = f.request(`/business/vehicles/${car.id}/photo`, { method: 'POST', body: photo(car.version), settle: false })
    await entered.promise
    let closed = false
    closing = f.client.close().then(() => { closed = true })
    await new Promise(resolve => setTimeout(resolve, 25)); assert.equal(closed, false)
    release.resolve()
    const result = await uploadRequest as { status: number; data: { vehicle: BusinessRecord; attachment: BusinessRecord } }
    assert.equal(result.status, 201)
    assert.equal(result.data.vehicle.data.photoAttachmentId, result.data.attachment.id)
    await closing; assert.equal(closed, true)
    await f.reopen()
    const photoRead = await f.request(`/business/vehicles/${car.id}/photo`)
    assert.equal(photoRead.status, 200); assert.deepEqual(photoRead.data, image)
  } finally { release.resolve(); if (uploadRequest) await uploadRequest.catch(() => {}); if (closing) await closing.catch(() => {}); Business.prototype.blob = originalBlob; await f.close() }
})
