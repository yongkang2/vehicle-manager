import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createApp } from '../server/app.js'
import type { Actor, BusinessRecord, Fields, ReportData, VehicleDeletion } from '../shared/business.js'

async function fixture() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'vehicle-report-comments-api-'))
  const client = createApp({ dataDir: path.join(directory, 'local') }), server = client.app.listen(0, '127.0.0.1')
  if (!server.listening) await once(server, 'listening')
  const sessions = new Map<string, { cookie: string; token: string }>()
  async function request(route: string, method = 'GET', body?: unknown, session = 'owner', token?: string) {
    const credentials = sessions.get(session) || { cookie: '', token: '' }
    const response = await fetch(`http://127.0.0.1:${(server.address() as { port: number }).port}/api${route}`, { method, headers: { Cookie: credentials.cookie, 'X-App-Request': 'vehicle-manager', 'X-Workspace-Token': token ?? credentials.token, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body) })
    const cookie = response.headers.get('set-cookie'); if (cookie) credentials.cookie = cookie.split(';')[0]
    if (response.ok) credentials.token = response.headers.get('x-workspace-token') || credentials.token
    sessions.set(session, credentials)
    const data = response.headers.get('content-type')?.includes('json') ? await response.json() : Buffer.from(await response.arrayBuffer())
    await client.synchronization.settle()
    return { status: response.status, data }
  }
  async function close() {
    await new Promise<void>(resolve => server.close(() => resolve()))
    await client.close()
    assert.equal(path.dirname(directory), path.resolve(os.tmpdir()))
    await fs.rm(directory, { recursive: true, force: true })
  }
  try {
    for (const session of ['owner', 'member', 'pending']) assert.equal((await request('/register', 'POST', { username: `report-${session}`, displayName: session, password: 'fictional-report-comments-password' }, session)).status, 201)
    const shared = path.join(directory, 'shared'); await fs.mkdir(shared)
    const configured = await request('/setup/configure', 'POST', { path: shared, mode: 'create', teamName: 'Fictional report team', confirmed: true, retainPending: true })
    assert.equal(configured.status, 200)
    for (const session of ['member', 'pending']) assert.equal((await request('/setup/configure', 'POST', { path: shared, teamId: configured.data.teamId, mode: 'join' }, session)).status, 200)
    const roster = (await request('/team')).data, pending = roster.requests.find((entry: { identity: { displayName: string }; status: string }) => entry.identity.displayName === 'member' && entry.status === 'pending')
    assert(pending)
    assert.equal((await request(`/team/requests/${pending.id}/approve`, 'POST', { role: 'member', memberId: null, reason: 'Approve fictional report reviewer' })).status, 200)
    const workspace = client.workspaces.get(configured.data.teamId), approved = (await request('/status', 'GET', undefined, 'member')).data.member, owner = (await request('/status')).data.member
    const actor: Actor = { id: approved.id, name: approved.name, role: 'member', deviceId: workspace.store.deviceId }
    const ownerActor: Actor = { id: owner.id, name: owner.name, role: 'admin', deviceId: workspace.store.deviceId }
    client.store.db.exec('UPDATE sessions SET sync_enabled=0')
    const carResult = await request('/business/records', 'POST', { kind: 'vehicle', data: { vin: 'TEST0000000000001', status: 'available', complianceLevel: 'Eu7', name: 'Fictional comment vehicle' }, reason: 'Register fictional report vehicle' })
    assert.equal(carResult.status, 201)
    const car = carResult.data as BusinessRecord, bytes = Buffer.from('Fictional retained DOVE workbook bytes'), key = await workspace.business.blob(bytes), savedAt = '2026-11-14T00:00:00.000Z'
    const data: ReportData = { name: 'fictional-report.xlsx', checksum: key, size: bytes.length, recordedAt: '2026-11-14', savedAt, parserVersion: 'fictional-parser', vehicleSnapshot: car.data, parsed: { vin: '', rawVin: '', vehicleId: car.id, recordedAt: '2026-11-14', software: 'Fictional DOVE', mileage: 0, soc: 0, vehicleMode: 'Demo', controllers: [], faults: [], warnings: [], sheets: [] }, association: { method: 'manual', vehicleId: car.id, vin: String(car.data.vin), actor, assignedAt: savedAt } }
    const report = workspace.business.write({ id: `report-${car.id}-${key}`, kind: 'report', vehicleId: car.id, data: { ...data, futureMetadata: { preserved: true } }, actor, reason: 'Retain fictional report source', internal: true })
    const route = `/business/reports/${report.id}/comment`
    const counts = () => ({ records: workspace.business.list().length, history: workspace.business.history().length, outbox: workspace.store.db.prepare('SELECT COUNT(*) AS n FROM outbox').get()!.n })
    const save = (current: BusinessRecord, comment: unknown, extras: Fields = {}, session = 'member') => request(route, 'PUT', { comment, version: current.version, reason: 'Review fictional report', ...extras }, session)
    return { directory, client, workspace, actor, ownerActor, car, report, bytes, route, request, save, counts, close }
  } catch (error) { await close(); throw error }
}

test('members and administrators edit one report comment while retaining original data, bytes and truthful history', async () => {
  const f = await fixture()
  try {
    const before = f.counts(), blank = await f.save(f.report, ' \n ')
    assert.equal(blank.status, 200); assert.deepEqual(blank.data, f.report); assert.deepEqual(f.counts(), before)
    const comment = '检查结果：需要复核\n<b>Plain text, not markup</b>'
    const edited = await f.save(f.report, `  ${comment}\n `)
    assert.equal(edited.status, 200, JSON.stringify(edited.data))
    assert.equal(edited.data.data.comment, comment); assert.equal(edited.data.version, f.report.version + 1)
    assert.deepEqual(edited.data.data, { ...f.report.data, comment })
    assert.deepEqual(f.workspace.business.get(f.car.id), f.car)
    assert.deepEqual(await f.workspace.business.readBlob(String(f.report.data.checksum)), f.bytes)
    const downloaded = await f.request(`/business/files/${f.report.id}`)
    assert.equal(downloaded.status, 200); assert.deepEqual(downloaded.data, f.bytes)
    const change = f.workspace.business.history().find(row => row.recordId === f.report.id && row.action === 'updated')!
    assert.deepEqual(change.actor, f.actor); assert.equal(change.reason, 'Review fictional report')
    assert.deepEqual(change.before, f.report.data); assert.deepEqual(change.after, edited.data.data)
    assert.deepEqual(f.counts(), { records: before.records, history: before.history + 1, outbox: Number(before.outbox) + 1 })
    const savedCounts = f.counts(), repeated = await f.save(edited.data, ` ${comment} `)
    assert.equal(repeated.status, 200); assert.deepEqual(repeated.data, edited.data); assert.deepEqual(f.counts(), savedCounts)
    const replaced = await f.save(edited.data, '复核完成', {}, 'owner')
    assert.equal(replaced.status, 200); assert.equal(replaced.data.data.comment, '复核完成')
    const cleared = await f.save(replaced.data, ' \n\t', {}, 'owner')
    assert.equal(cleared.status, 200); assert.equal(cleared.data.data.comment, '')
    const lastChange = f.workspace.business.history().find(row => row.recordId === f.report.id)!
    assert.deepEqual(lastChange.actor, f.ownerActor); assert.equal(lastChange.after.comment, '')
    assert.deepEqual(cleared.data.data, { ...f.report.data, comment: '' })
  } finally { await f.close() }
})

test('comment validation and stale versions cannot mutate report source, history or the upload queue', async () => {
  const f = await fixture()
  try {
    const before = f.counts()
    for (const comment of [undefined, null, 12, false, [], {}, 'x'.repeat(4001)]) {
      const result = await f.save(f.report, comment)
      assert.equal(result.status, 400, JSON.stringify(result.data)); assert.equal(result.data.error, 'INVALID_INPUT')
    }
    for (const version of [undefined, null, '1', 0, -1, 1.5]) assert.equal((await f.save(f.report, '', { version })).data.error, 'INVALID_INPUT')
    for (const reason of [undefined, null, '', '  ', 'x'.repeat(501)]) assert.equal((await f.save(f.report, '', { reason })).data.error, 'REASON_REQUIRED')
    for (const extras of [{ data: { parsed: {} } }, { parsed: {} }, { checksum: 'f'.repeat(64) }, { vehicleId: randomUUID() }, { name: 'replacement.xlsx' }, { actor: f.ownerActor }]) {
      assert.equal((await f.save(f.report, 'Do not admit unrelated fields', extras)).data.error, 'INVALID_INPUT')
    }
    const ordinaryEdit = await f.request(`/business/records/${f.report.id}`, 'PUT', { version: f.report.version, data: { ...f.report.data, comment: 'Generic report editing remains blocked' }, reason: 'Try ordinary record editing' }, 'member')
    assert.equal(ordinaryEdit.status, 409); assert.equal(ordinaryEdit.data.error, 'IMMUTABLE_REPORT')
    assert.equal((await f.request(`/business/reports/${f.car.id}/comment`, 'PUT', { comment: '', version: f.car.version, reason: 'Wrong record kind' }, 'member')).data.error, 'INVALID_INPUT')
    assert.equal((await f.request(`/business/reports/${randomUUID()}/comment`, 'PUT', { comment: '', version: 1, reason: 'Missing report' }, 'member')).status, 404)
    assert.deepEqual(f.counts(), before); assert.deepEqual(f.workspace.business.get(f.report.id), f.report)
    const accepted = await f.save(f.report, '文'.repeat(4000))
    assert.equal(accepted.status, 200); assert.equal(accepted.data.data.comment.length, 4000)
    const after = f.counts(), stale = await f.save(f.report, accepted.data.data.comment)
    assert.equal(stale.status, 409); assert.equal(stale.data.error, 'VERSION_CONFLICT')
    assert.deepEqual(f.counts(), after); assert.deepEqual(f.workspace.business.get(f.report.id), accepted.data)
  } finally { await f.close() }
})

test('access, workspace, archived and deleted guards apply before comment no-op detection', async () => {
  const f = await fixture()
  try {
    const body = { comment: '', version: f.report.version, reason: 'Validate no-op safeguards' }, before = f.counts()
    assert.equal((await f.request(f.route, 'PUT', body, 'guest')).status, 401)
    assert.equal((await f.request(f.route, 'PUT', body, 'pending')).status, 403)
    assert.equal((await f.request(f.route, 'PUT', body, 'member', 'stale-workspace-token')).data.error, 'WORKSPACE_CHANGED')
    assert.deepEqual(f.counts(), before)
    const archived = f.workspace.business.write({ id: f.report.id, kind: 'report', vehicleId: f.car.id, data: f.report.data, version: f.report.version, archived: true, actor: f.ownerActor, reason: 'Archive fictional report', internal: true })
    let unchanged = f.counts()
    assert.equal((await f.save(archived, '')).data.error, 'RECORD_ARCHIVED'); assert.deepEqual(f.counts(), unchanged)
    const restored = f.workspace.business.write({ id: f.report.id, kind: 'report', vehicleId: f.car.id, data: archived.data, version: archived.version, archived: false, actor: f.ownerActor, reason: 'Restore fictional report', internal: true })
    f.workspace.business.write({ id: f.car.id, kind: 'vehicle', data: f.car.data, version: f.car.version, archived: true, actor: f.ownerActor, reason: 'Archive fictional parent vehicle' })
    unchanged = f.counts()
    assert.equal((await f.save(restored, '')).data.error, 'PARENT_ARCHIVED'); assert.deepEqual(f.counts(), unchanged)
    const marker: VehicleDeletion = { id: randomUUID(), requestId: randomUUID(), vehicleId: f.car.id, vin: String(f.car.data.vin), recordIds: [f.car.id, f.report.id], fileKeys: [String(f.report.data.checksum)], actor: f.ownerActor, reason: 'Simulate canonical deletion discovered on another client', deletedAt: new Date().toISOString(), revision: randomUUID(), sequence: 1 }
    f.workspace.store.rememberDeletions([marker])
    const deletedCounts = f.counts()
    assert.equal((await f.save(restored, '')).data.error, 'VEHICLE_DELETED'); assert.deepEqual(f.counts(), deletedCounts)
  } finally { await f.close() }
})

test('authorized offline comments stay local while revoked members cannot perform even no-op saves', async () => {
  const f = await fixture()
  try {
    const configuration = f.workspace.store.get<{ sharedPath: string; teamId: string }>('configuration')!
    f.workspace.store.set('configuration', { ...configuration, sharedPath: path.join(f.directory, 'unavailable-share') })
    const before = f.counts(), saved = await f.save(f.report, 'Offline review retained for later synchronization')
    assert.equal(saved.status, 200, JSON.stringify(saved.data)); assert.equal(saved.data.data.comment, 'Offline review retained for later synchronization')
    assert.equal(Number(f.counts().outbox), Number(before.outbox) + 1)
    assert.ok(f.client.store.db.prepare('SELECT sync_enabled FROM sessions').all().every(row => row.sync_enabled === 0))
    f.workspace.store.set('configuration', configuration)
    const disabled = await f.request(`/team/members/${f.actor.id}`, 'POST', { enabled: false, role: 'member', reason: 'Revoke fictional report reviewer' })
    assert.equal(disabled.status, 200, JSON.stringify(disabled.data))
    const unchanged = f.counts(), rejected = await f.save(saved.data, saved.data.data.comment)
    assert.equal(rejected.status, 403); assert.equal(rejected.data.error, 'ACCESS_DISABLED'); assert.deepEqual(f.counts(), unchanged)
  } finally { await f.close() }
})
