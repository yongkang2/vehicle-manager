import { test } from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import ExcelJS from 'exceljs'
import { createApp } from '../server/app.js'
import { Business } from '../server/business.js'
import type { BusinessRecord, DovePreview } from '../shared/business.js'

const vinA = 'TEST0000000000001', vinB = 'TEST0000000000002', password = 'manual-api-test-password'
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done }); return { promise, resolve } }
async function workbook(vin: string | null = null, software = '2.0') {
  const book = new ExcelJS.Workbook(), summary = book.addWorksheet('DOVE')
  summary.addRows([...(vin === null ? [] : [['Vin :', vin]]), ['Date of record', '2026-10-25'], ['Vehicle milage', '1234 km']])
  book.addWorksheet('Identification').addRows([['ECU', 'Description', 'Network', 'Supplier'], ['EVCU', 'Fictional VCU', 'CAN UDS', 'Fictional supplier', 'FN', 'PN', software, '', 'CAL', '2', '', '', '', '000123']])
  book.addWorksheet('Defauts').addRow(['EVCU', '', 'CAN UDS', 'P123456 (2Fh - Permanent) Fictional fault'])
  return Buffer.from(await book.xlsx.writeBuffer())
}
function upload(files: { bytes: Buffer; name: string }[], field = 'file') {
  const body = new FormData()
  for (const file of files) body.append(field, new Blob([new Uint8Array(file.bytes)]), file.name)
  return body
}
const confirmation = (preview: DovePreview, extra = {}) => ({ confirmed: true, bindingToken: preview.manualBinding!.token, manualVehicleConfirmed: true, ...extra })

async function fixture() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'vehicle-dove-manual-api-'))
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
    const result = await request('/register', { method: 'POST', session, body: { username: `manual-${session}`, displayName: session, password } })
    assert.equal(result.status, 201, JSON.stringify(result.data)); return result.data as { id: string }
  }
  async function team(name = 'Team A', session = 'owner') {
    const shared = path.join(directory, name); await fs.mkdir(shared)
    const result = await request('/setup/configure', { method: 'POST', session, body: { path: shared, mode: 'create', teamName: name, confirmed: true, retainPending: true } })
    assert.equal(result.status, 200, JSON.stringify(result.data)); return { id: result.data.teamId as string, shared }
  }
  async function member(team: { id: string; shared: string }, session = 'member') {
    await register(session)
    assert.equal((await request('/setup/configure', { method: 'POST', session, body: { path: team.shared, teamId: team.id, mode: 'join' } })).status, 200)
    const roster = (await request('/team')).data, pending = roster.requests.find((entry: { status: string }) => entry.status === 'pending')
    assert(pending)
    assert.equal((await request(`/team/requests/${pending.id}/approve`, { method: 'POST', body: { role: 'member', memberId: null, reason: 'Approve fictional manual importer' } })).status, 200)
    const status = (await request('/status', { session })).data; assert.equal(status.member.role, 'member'); return status.member as { id: string; name: string }
  }
  async function vehicle(vin = vinA) {
    const result = await request('/business/records', { method: 'POST', body: { kind: 'vehicle', data: { vin, status: 'available', complianceLevel: 'Eu7', name: 'Fictional manual vehicle' }, reason: 'Register fictional manual vehicle' } })
    assert.equal(result.status, 201, JSON.stringify(result.data)); return result.data as BusinessRecord
  }
  async function part(vehicleId: string) {
    const result = await request('/business/records', { method: 'POST', body: { kind: 'part', vehicleId, data: { name: 'VCU', category: 'controller', controllerType: 'Open ECU', software: '1.0' }, reason: 'Install fictional controller' } })
    assert.equal(result.status, 201, JSON.stringify(result.data)); return result.data as BusinessRecord
  }
  async function preview(bytes: Buffer, session = 'owner', name = 'missing-vin.xlsx') {
    const result = await request('/business/dove/preview', { method: 'POST', session, body: upload([{ bytes, name }]) })
    assert.equal(result.status, 200, JSON.stringify(result.data)); return result.data as DovePreview
  }
  async function bind(draft: DovePreview, car: BusinessRecord, session = 'owner', settle = true) {
    const result = await request(`/business/dove/${draft.id}/vehicle`, { method: 'POST', session, settle, body: { vehicleId: car.id, expectedVin: car.data.vin } })
    assert.equal(result.status, 200, JSON.stringify(result.data)); return result.data as DovePreview
  }
  async function save(draft: DovePreview, extra = {}, session = 'owner', settle = true) {
    return request('/business/dove/save', { method: 'POST', session, settle, body: { draftId: draft.id, confirmation: confirmation(draft, extra) } })
  }
  async function reopen() {
    await new Promise<void>(resolve => server.close(() => resolve())); await client.close()
    client = createApp({ dataDir: path.join(directory, 'local') }); server = client.app.listen(0, '127.0.0.1'); if (!server.listening) await once(server, 'listening')
  }
  async function close() { await new Promise<void>(resolve => server.close(() => resolve())); await client.close(); assert(path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep)); await fs.rm(directory, { recursive: true, force: true }) }
  return { get client() { return client }, get server() { return server }, directory, sessions, request, register, team, member, vehicle, part, preview, bind, save, reopen, close }
}

test('mixed DOVE batch keeps missing VINs blank and makes private binding/cancellation side-effect free', async () => {
  const f = await fixture()
  try {
    await f.register(); const a = await f.team(), first = await f.vehicle(), selected = await f.vehicle(vinB); await f.member(a)
    const workspace = f.client.workspaces.get(a.id), missingBytes = await workbook(), normalBytes = await workbook(vinA)
    const preview = await f.request('/business/dove/preview-batch', { method: 'POST', session: 'member', body: upload([{ bytes: normalBytes, name: 'normal.xlsx' }, { bytes: missingBytes, name: 'missing.xlsx' }, { bytes: await workbook('NOT-A-VALID-VIN'), name: 'invalid-vin.xlsx' }, { bytes: Buffer.from('not a workbook'), name: 'broken.xlsx' }], 'files') })
    assert.equal(preview.status, 200)
    const rows = preview.data as { preview?: DovePreview; error?: string }[]
    assert.equal(rows[0].preview!.match, 'matched'); assert.equal(rows[1].preview!.match, 'manual-required')
    assert.equal(rows[1].preview!.parsed.vin, ''); assert.equal(rows[1].preview!.parsed.rawVin, '')
    assert.equal(rows[2].error, 'INVALID_VIN'); assert.equal(rows[3].error, 'DOVE_PARSE_FAILED')
    const draft = rows[1].preview!
    assert.equal((await f.request('/business/dove/save', { method: 'POST', session: 'member', body: { draftId: draft.id, confirmation: { confirmed: true } } })).data.error, 'MANUAL_VEHICLE_REQUIRED')
    const current = workspace.business.get(first.id)
    workspace.business.write({ id: first.id, kind: 'vehicle', data: { ...current.data, notes: 'Unpublished local change' }, version: current.version, actor: { id: 'fixture', name: 'Fixture', role: 'member', deviceId: workspace.store.deviceId }, reason: 'Test private draft binding' })
    const beforeRecords = workspace.business.list(), beforeHistory = workspace.business.history(), pending = workspace.synchronization.status().pending, head = await fs.readFile(path.join(a.shared, 'business', 'HEAD.json'))
    const bound = await f.bind(draft, selected, 'member')
    assert.equal(bound.match, 'matched'); assert.equal(bound.manualBinding!.vehicleId, selected.id); assert.equal(bound.manualBinding!.vin, vinB)
    assert.equal(bound.parsed.vin, ''); assert.equal(bound.parsed.rawVin, '')
    assert.deepEqual(workspace.business.list(), beforeRecords); assert.deepEqual(workspace.business.history(), beforeHistory)
    assert.equal(workspace.synchronization.status().pending, pending); assert.deepEqual(await fs.readFile(path.join(a.shared, 'business', 'HEAD.json')), head)
    const results = await f.request('/business/dove/save-batch', { method: 'POST', session: 'member', body: { draftIds: [rows[0].preview!.id, bound.id], confirmations: { [rows[0].preview!.id]: { confirmed: true }, [bound.id]: confirmation(bound) } } })
    assert.equal(results.status, 201); assert(results.data.every((item: { record?: BusinessRecord }) => item.record?.kind === 'report'))
    const manual = results.data[1].record as BusinessRecord
    assert.equal(manual.vehicleId, selected.id); assert.deepEqual((await f.request(`/business/files/${manual.id}`, { session: 'member' })).data, missingBytes)
    assert.equal(workspace.business.list('part', selected.id).length, 0); assert.equal(workspace.business.list('part', first.id).length, 1)
  } finally { await f.close() }
})

test('member manual retention requires fresh binding and acknowledgement, defaults to report only, and supports explicit controller updates', async () => {
  const f = await fixture()
  try {
    await f.register(); const a = await f.team(), car = await f.vehicle(), other = await f.vehicle(vinB), part = await f.part(car.id), member = await f.member(a), workspace = f.client.workspaces.get(a.id)
    const draft = await f.preview(await workbook(), 'member')
    assert.equal((await f.request(`/business/dove/${draft.id}/vehicle`, { method: 'POST', session: 'member', body: { vehicleId: car.id, expectedVin: vinB } })).data.error, 'VEHICLE_SELECTION_CHANGED')
    const first = await f.bind(draft, other, 'member'), bound = await f.bind(draft, car, 'member')
    assert.notEqual(first.manualBinding!.token, bound.manualBinding!.token)
    assert.equal((await f.save(first, {}, 'member')).data.error, 'MANUAL_BINDING_CHANGED')
    assert.equal((await f.request('/business/dove/save', { method: 'POST', session: 'member', body: { draftId: bound.id, confirmation: { confirmed: true, bindingToken: bound.manualBinding!.token } } })).data.error, 'MANUAL_VEHICLE_CONFIRMATION_REQUIRED')
    assert.equal(workspace.business.list('report').length, 0)
    const retained = await f.save(bound, {}, 'member'); assert.equal(retained.status, 201, JSON.stringify(retained.data))
    const report = retained.data as BusinessRecord, association = report.data.association as { method: string; vehicleId: string; vin: string; actor: { id: string; role: string }; assignedAt: string }
    assert.equal((report.data.parsed as { vin: string; rawVin: string }).vin, ''); assert.equal((report.data.parsed as { rawVin: string }).rawVin, '')
    assert.equal(association.method, 'manual'); assert.equal(association.vehicleId, car.id); assert.equal(association.vin, vinA); assert.equal(association.actor.id, member.id); assert.equal(association.actor.role, 'member'); assert(Number.isFinite(Date.parse(association.assignedAt)))
    assert.equal(workspace.business.get(part.id).data.software, '1.0')
    const configured = await f.request(`/business/reports/${report.id}/configuration`, { method: 'POST', session: 'member', body: { reportVersion: report.version, selections: [{ controllerIndex: 0, partId: part.id, version: part.version, fields: ['software'] }], reason: 'Explicitly apply manually associated controller observation' } })
    assert.equal(configured.status, 200, JSON.stringify(configured.data)); assert.equal(workspace.business.get(part.id).data.software, '2.0')
    const optIn = await f.bind(await f.preview(await workbook(null, '3.0'), 'member'), workspace.business.get(car.id), 'member')
    const denied = await f.save(optIn, { reportOnly: false }, 'member'); assert.equal(denied.data.error, 'VERSION_CONFLICT'); assert.equal(workspace.business.list('report', car.id).length, 1)
    const updated = await f.save(optIn, { reportOnly: false, versions: { VCU: workspace.business.get(part.id).version } }, 'member')
    assert.equal(updated.status, 201, JSON.stringify(updated.data)); assert.equal(workspace.business.get(part.id).data.software, '3.0')
    const normal = await f.preview(await workbook(vinA, '4.0'), 'member', 'normal.xlsx')
    assert.equal((await f.request(`/business/dove/${normal.id}/vehicle`, { method: 'POST', session: 'member', body: { vehicleId: car.id, expectedVin: vinA } })).data.error, 'INVALID_INPUT')
  } finally { await f.close() }
})

test('manual draft ownership, expiry, workspace scope and stale-page tokens stay isolated', async context => {
  const f = await fixture()
  try {
    await f.register(); const a = await f.team(), car = await f.vehicle(); await f.member(a)
    const draft = await f.preview(await workbook()), body = { vehicleId: car.id, expectedVin: vinA }, route = `/business/dove/${draft.id}/vehicle`
    assert.equal((await f.request(route, { method: 'POST', session: 'unknown', body })).data.error, 'LOGIN_REQUIRED')
    assert.equal((await f.request(route, { method: 'POST', session: 'member', body })).data.error, 'DRAFT_EXPIRED')
    assert.equal((await f.request(route, { method: 'POST', token: 'stale-token', body })).data.error, 'WORKSPACE_CHANGED')
    for (const invalid of [{ vehicleId: car.id }, { vehicleId: 4, expectedVin: vinA }, { ...body, extra: true }]) assert.equal((await f.request(route, { method: 'POST', body: invalid })).data.error, 'INVALID_INPUT')
    const b = await f.team('Team B')
    assert.equal((await f.request(route, { method: 'POST', body })).data.error, 'DRAFT_EXPIRED')
    assert.equal((await f.request('/workspaces/select', { method: 'POST', body: { teamId: a.id, retainPending: true } })).status, 200)
    const bound = await f.bind(draft, car); assert.equal(bound.manualBinding!.vehicleId, car.id)
    const now = Date.now(); const clock = context.mock.method(Date, 'now', () => now + 31 * 60 * 1000)
    try { assert.equal((await f.request(route, { method: 'POST', body })).data.error, 'DRAFT_EXPIRED') } finally { clock.mock.restore() }
    assert.equal(f.client.workspaces.get(a.id).business.list('report').length, 0); assert.equal(f.client.workspaces.get(b.id).business.list('report').length, 0)
  } finally { await f.close() }
})

test('approved members can bind and retain missing-VIN reports offline with synchronization paused', async () => {
  const f = await fixture(); let offline = false
  try {
    await f.register(); const a = await f.team(), car = await f.vehicle(); await f.member(a)
    f.client.store.db.prepare("UPDATE sessions SET sync_enabled=0 WHERE user_id=(SELECT id FROM accounts WHERE username='manual-member')").run()
    const head = await fs.readFile(path.join(a.shared, 'business', 'HEAD.json'))
    await fs.rename(a.shared, a.shared + '-offline'); offline = true
    const bytes = await workbook(), bound = await f.bind(await f.preview(bytes, 'member'), car, 'member'), result = await f.save(bound, {}, 'member')
    assert.equal(result.status, 201, JSON.stringify(result.data)); assert.equal(result.data.vehicleId, car.id)
    assert.deepEqual((await f.request(`/business/files/${result.data.id}`, { session: 'member' })).data, bytes)
    assert(f.client.workspaces.get(a.id).synchronization.status().pending > 0)
    await fs.rename(a.shared + '-offline', a.shared); offline = false; assert.deepEqual(await fs.readFile(path.join(a.shared, 'business', 'HEAD.json')), head)
  } finally { if (offline) await fs.rename(path.join(f.directory, 'Team A-offline'), path.join(f.directory, 'Team A')); await f.close() }
})

test('manual bindings reject archived, changed-VIN and deleted UUIDs even if a new vehicle reuses the VIN', async () => {
  const f = await fixture()
  try {
    await f.register(); const a = await f.team(), car = await f.vehicle(), workspace = f.client.workspaces.get(a.id), bytes = await workbook()
    const bound = await f.bind(await f.preview(bytes), car)
    assert.equal((await f.request(`/business/records/${car.id}/archive`, { method: 'POST', body: { archived: true, version: workspace.business.get(car.id).version, reason: 'Archive while draft open' } })).status, 200)
    assert.equal((await f.save(bound)).data.error, 'VEHICLE_SELECTION_CHANGED')
    assert.equal((await f.request(`/business/records/${car.id}/archive`, { method: 'POST', body: { archived: false, version: workspace.business.get(car.id).version, reason: 'Reopen fixture' } })).status, 200)
    const changing = await f.bind(await f.preview(bytes), workspace.business.get(car.id)), current = workspace.business.get(car.id)
    assert.equal((await f.request(`/business/records/${car.id}`, { method: 'PUT', body: { data: { ...current.data, vin: vinB }, version: current.version, reason: 'Correct fixture VIN' } })).status, 200)
    assert.equal((await f.save(changing)).data.error, 'VEHICLE_SELECTION_CHANGED')
    const deleted = await f.bind(await f.preview(bytes), workspace.business.get(car.id))
    assert.equal((await f.request(`/business/records/${car.id}/archive`, { method: 'POST', body: { archived: true, version: workspace.business.get(car.id).version, reason: 'Archive before canonical deletion' } })).status, 200)
    const preview = (await f.request(`/business/vehicles/${car.id}/delete-preview`)).data
    const removal = await f.request(`/business/vehicles/${car.id}`, { method: 'DELETE', body: { previewToken: preview.token, version: preview.version, vin: preview.vin, confirmation: 'DELETE', reason: 'Delete isolated UUID', requestId: randomUUID() } })
    assert.equal(removal.status, 200, JSON.stringify(removal.data)); const replacement = await f.vehicle(vinB); assert.notEqual(replacement.id, car.id)
    assert.equal((await f.save(deleted)).data.error, 'VEHICLE_DELETED'); assert.equal(workspace.business.list('report', replacement.id).length, 0)
  } finally { await f.close() }
})

for (const outcome of ['logout', 'revoked', 'rebind', 'vehicle-vin', 'controller-version'] as const) {
  test(`manual retention rechecks ${outcome} after blob persistence without partially retaining reports or controller updates`, { timeout: 20000 }, async () => {
    const f = await fixture(), entered = deferred(), release = deferred(), originalBlob = Business.prototype.blob
    let pending: ReturnType<typeof f.save> | null = null
    try {
      await f.register(); const a = await f.team(), car = await f.vehicle(), part = await f.part(car.id); await f.member(a)
      const workspace = f.client.workspaces.get(a.id), bound = await f.bind(await f.preview(await workbook(), 'member'), car, 'member')
      Business.prototype.blob = async function (bytes) { const key = await originalBlob.call(this, bytes); entered.resolve(); await release.promise; return key }
      pending = f.save(bound, { reportOnly: false, versions: { VCU: part.version } }, 'member', false)
      await Promise.race([entered.promise, pending.then(result => { throw new Error(`Retention finished before blob gate: ${JSON.stringify(result.data)}`) })])
      if (outcome === 'logout') await f.request('/logout', { method: 'POST', session: 'member', body: {}, settle: false })
      else if (outcome === 'revoked') {
        const roster = (await f.request('/team', { settle: false })).data, member = roster.members.find((entry: { role: string }) => entry.role === 'member')
        assert.equal((await f.request(`/team/members/${member.id}`, { method: 'POST', body: { enabled: false, role: 'member', reason: 'Revoke during fictional retention' }, settle: false })).status, 200)
      } else if (outcome === 'rebind') await f.bind(bound, workspace.business.get(car.id), 'member', false)
      else {
        const current = workspace.business.get(outcome === 'vehicle-vin' ? car.id : part.id)
        workspace.business.write({ id: current.id, kind: current.kind, vehicleId: current.vehicleId, data: { ...current.data, ...(outcome === 'vehicle-vin' ? { vin: vinB } : { notes: 'Concurrent controller edit' }) }, version: current.version, actor: { id: 'fixture', name: 'Fixture', role: 'admin', deviceId: workspace.store.deviceId }, reason: 'Concurrent isolated change' })
      }
      release.resolve(); const result = await pending
      const expected = { logout: 'LOGIN_REQUIRED', revoked: 'ACCESS_DISABLED', rebind: 'MANUAL_BINDING_CHANGED', 'vehicle-vin': 'VEHICLE_SELECTION_CHANGED', 'controller-version': 'VERSION_CONFLICT' }[outcome]
      assert.equal(result.data.error, expected); assert.equal(workspace.business.list('report').length, 0); assert.equal(workspace.business.get(part.id).data.software, '1.0')
    } finally { release.resolve(); if (pending) await pending.catch(() => {}); Business.prototype.blob = originalBlob; await f.close() }
  })
}

test('aborted manual retention drains before switching workspaces and cannot write into either team', { timeout: 20000 }, async () => {
  const f = await fixture(), entered = deferred(), release = deferred(), responseClosed = deferred(), originalBlob = Business.prototype.blob
  let pending: Promise<unknown> | null = null, switching: ReturnType<typeof f.request> | null = null
  try {
    await f.register(); const a = await f.team(), car = await f.vehicle(), b = await f.team('Team B')
    assert.equal((await f.request('/workspaces/select', { method: 'POST', body: { teamId: a.id, retainPending: true } })).status, 200)
    const workspace = f.client.workspaces.get(a.id), bound = await f.bind(await f.preview(await workbook()), car)
    f.server.on('request', (incoming, response) => { if (incoming.url === '/api/business/dove/save') response.once('close', responseClosed.resolve) })
    Business.prototype.blob = async function (bytes) { const key = await originalBlob.call(this, bytes); entered.resolve(); await release.promise; return key }
    const controller = new AbortController()
    pending = f.request('/business/dove/save', { method: 'POST', body: { draftId: bound.id, confirmation: confirmation(bound) }, signal: controller.signal, settle: false }).then(() => 'completed', () => 'aborted')
    await Promise.race([entered.promise, pending.then(result => { throw new Error(`Request finished before blob gate: ${String(result)}`) })]); controller.abort(); assert.equal(await pending, 'aborted'); await responseClosed.promise
    let selected = false; switching = f.request('/workspaces/select', { method: 'POST', body: { teamId: b.id, retainPending: true }, settle: false }).then(result => { selected = true; return result })
    await new Promise(resolve => setTimeout(resolve, 25)); assert.equal(selected, false); release.resolve()
    assert.equal((await switching).status, 200); assert.equal((await f.request('/status')).data.teamId, b.id)
    assert.equal(workspace.business.list('report').length, 0); assert.equal(f.client.workspaces.get(b.id).business.list('report').length, 0)
  } finally { release.resolve(); if (pending) await pending.catch(() => {}); if (switching) await switching.catch(() => {}); Business.prototype.blob = originalBlob; await f.close() }
})

test('graceful shutdown waits for manual report retention before closing databases and persisted association survives restart', { timeout: 20000 }, async () => {
  const f = await fixture(), entered = deferred(), release = deferred(), originalBlob = Business.prototype.blob
  let pending: ReturnType<typeof f.save> | null = null, closing: Promise<void> | null = null
  try {
    await f.register(); await f.team(); const car = await f.vehicle(), bytes = await workbook(), bound = await f.bind(await f.preview(bytes), car)
    Business.prototype.blob = async function (data) { const key = await originalBlob.call(this, data); entered.resolve(); await release.promise; return key }
    pending = f.save(bound, {}, 'owner', false)
    await Promise.race([entered.promise, pending.then(result => { throw new Error(`Retention finished before blob gate: ${JSON.stringify(result.data)}`) })])
    let closed = false; closing = f.client.close().then(() => { closed = true }); await new Promise(resolve => setTimeout(resolve, 25)); assert.equal(closed, false)
    release.resolve(); const result = await pending; assert.equal(result.status, 201, JSON.stringify(result.data)); await closing; assert.equal(closed, true)
    await f.reopen(); const retained = (await f.request('/business/records')).data.find((row: BusinessRecord) => row.id === result.data.id)
    assert.equal(retained.data.association.vehicleId, car.id); assert.equal(retained.data.association.vin, vinA); assert.equal(retained.data.parsed.vin, '')
    assert.deepEqual((await f.request(`/business/files/${retained.id}`)).data, bytes)
  } finally { release.resolve(); if (pending) await pending.catch(() => {}); if (closing) await closing.catch(() => {}); Business.prototype.blob = originalBlob; await f.close() }
})
