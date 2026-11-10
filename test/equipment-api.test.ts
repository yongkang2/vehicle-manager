import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createApp } from '../server/app.js'
import { Business, checksum } from '../server/business.js'
import { EquipmentRecords } from '../server/equipment.js'
import { LocalStore } from '../server/store.js'
import { entryFields, equipmentTypes } from '../shared/business.js'
import type { Actor, BusinessRecord, Fields } from '../shared/business.js'

const pdf = Buffer.from('%PDF-1.4\n% Fictional equipment documentation\n%%EOF')
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==', 'base64')
const jpeg = Buffer.from([255, 216, 255, 224, 0, 16, 74, 70, 73, 70, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0, 255, 217])
const limit = 10 * 1024 * 1024

function upload(bytes: Buffer, name: string, reason = 'Retain fictional equipment evidence') {
  const body = new FormData()
  body.append('file', new Blob([new Uint8Array(bytes)]), name)
  body.append('reason', reason)
  return body
}

async function fixture() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'vehicle-equipment-api-'))
  const client = createApp({ dataDir: path.join(directory, 'local') }), server = client.app.listen(0, '127.0.0.1')
  if (!server.listening) await once(server, 'listening')
  const sessions = new Map<string, { cookie: string; token: string }>()
  async function request(route: string, { method = 'GET', body, session = 'owner', token, settle = true }: { method?: string; body?: unknown; session?: string; token?: string; settle?: boolean } = {}) {
    const credentials = sessions.get(session) || { cookie: '', token: '' }, form = body instanceof FormData
    const response = await fetch(`http://127.0.0.1:${(server.address() as { port: number }).port}/api${route}`, { method, headers: { Cookie: credentials.cookie, 'X-App-Request': 'vehicle-manager', 'X-Workspace-Token': token ?? credentials.token, ...(body !== undefined && !form ? { 'Content-Type': 'application/json' } : {}) }, body: body === undefined ? undefined : form ? body as FormData : JSON.stringify(body) })
    const cookie = response.headers.get('set-cookie'); if (cookie) credentials.cookie = cookie.split(';')[0]
    if (response.ok) credentials.token = response.headers.get('x-workspace-token') || credentials.token
    sessions.set(session, credentials)
    const data = response.headers.get('content-type')?.includes('json') ? await response.json() : Buffer.from(await response.arrayBuffer())
    if (settle) await client.synchronization.settle()
    return { status: response.status, data, headers: response.headers }
  }
  async function close() {
    await new Promise<void>(resolve => server.close(() => resolve()))
    await client.close()
    assert.equal(path.dirname(directory), path.resolve(os.tmpdir()))
    await fs.rm(directory, { recursive: true, force: true })
  }
  try {
    for (const session of ['owner', 'member', 'pending']) assert.equal((await request('/register', { method: 'POST', session, body: { username: `equipment-${session}`, displayName: `Fictional ${session}`, password: 'fictional-equipment-password' } })).status, 201)
    const shared = path.join(directory, 'shared'); await fs.mkdir(shared)
    const configured = await request('/setup/configure', { method: 'POST', body: { path: shared, mode: 'create', teamName: 'Fictional equipment', confirmed: true } })
    assert.equal(configured.status, 200, JSON.stringify(configured.data))
    for (const session of ['member', 'pending']) assert.equal((await request('/setup/configure', { method: 'POST', session, body: { path: shared, mode: 'join', teamId: configured.data.teamId } })).status, 200)
    const pending = (await request('/team')).data.requests.find((entry: { status: string; identity: { displayName: string } }) => entry.status === 'pending' && entry.identity.displayName === 'Fictional member')
    assert(pending)
    assert.equal((await request(`/team/requests/${pending.id}/approve`, { method: 'POST', body: { role: 'member', memberId: null, reason: 'Approve fictional equipment tester' } })).status, 200)
    const member = (await request('/status', { session: 'member' })).data.member
    const workspace = client.workspaces.get(configured.data.teamId)
    const actor: Actor = { id: member.id, name: member.name, deviceId: workspace.store.deviceId, role: 'member' }
    const accountId = String(client.store.db.prepare('SELECT id FROM accounts WHERE username=?').get('equipment-member')!.id)
    client.store.db.exec('UPDATE sessions SET sync_enabled=0'); await client.synchronization.settle()
    const created = await request('/business/records', { method: 'POST', body: { kind: 'vehicle', data: { vin: 'TEST0000000000001', status: 'available', complianceLevel: 'Eu7' }, reason: 'Create fictional equipment vehicle' } })
    assert.equal(created.status, 201, JSON.stringify(created.data))
    const car = created.data as BusinessRecord
    const create = (data: Fields = { name: 'Fictional logger' }, requestId: unknown = randomUUID(), session = 'member') => request('/business/records', { method: 'POST', session, body: { kind: 'equipment', vehicleId: car.id, data: { equipmentType: 'ETAS tools', ...data }, reason: 'Install fictional equipment', requestId } })
    const initial = await create()
    assert.equal(initial.status, 201, JSON.stringify(initial.data))
    const equipment = initial.data as BusinessRecord
    const counts = () => [workspace.business.list().length, workspace.business.history().length, workspace.store.db.prepare('SELECT COUNT(*) AS n FROM outbox').get()!.n]
    return { directory, client, workspace, shared, car, equipment, actor, accountId, sessions, request, create, counts, close, route: `/business/equipment/${equipment.id}/attachments` }
  } catch (error) { await close(); throw error }
}

test('equipment Type requires an explicit valid selection on manual saves, with a genuine legacy removal exception', async () => {
  const f = await fixture()
  try {
    for (const equipmentType of equipmentTypes) {
      const created = await f.create({ name: 'Every equipment Type', equipmentType })
      assert.equal(created.status, 201, JSON.stringify(created.data)); assert.equal(created.data.data.equipmentType, equipmentType)
      const updated = await f.request(`/business/records/${created.data.id}`, { method: 'PUT', session: 'member', body: { data: { ...created.data.data, equipmentType: 'Others' }, version: created.data.version, reason: 'Edit explicit equipment Type', requestId: randomUUID() } })
      assert.equal(updated.status, 200); assert.equal(updated.data.data.equipmentType, 'Others')
    }
    const before = f.counts()
    for (const equipmentType of [undefined, '', '  ', 'ETAS', 'other', 1, {}]) {
      const created = await f.request('/business/records', { method: 'POST', session: 'member', body: { kind: 'equipment', vehicleId: f.car.id, data: { name: 'Reject missing or invalid Type', equipmentType }, reason: 'Invalid equipment Type', requestId: randomUUID() } })
      assert.equal(created.data.error, equipmentType === undefined || typeof equipmentType === 'string' && !equipmentType.trim() ? 'EQUIPMENT_TYPE_REQUIRED' : 'INVALID_INPUT')
    }
    assert.deepEqual(f.counts(), before)
    const legacy = f.workspace.business.write({ kind: 'equipment', vehicleId: f.car.id, data: { name: 'Legacy unclassified logger' }, actor: f.actor, reason: 'Restore older equipment' })
    const update = (data: Fields) => f.request(`/business/records/${legacy.id}`, { method: 'PUT', session: 'member', body: { data, version: legacy.version, reason: 'Legacy edit or removal', requestId: randomUUID() } })
    assert.equal((await update({ ...legacy.data, description: 'A manual edit needs Type' })).data.error, 'EQUIPMENT_TYPE_REQUIRED')
    assert.equal((await update({ ...legacy.data, removedAt: '2026-11-10', description: 'Do not bypass with a removal' })).data.error, 'EQUIPMENT_TYPE_REQUIRED')
    const removed = await update({ ...legacy.data, removedAt: '2026-11-10' })
    assert.equal(removed.status, 200); assert.equal(removed.data.data.equipmentType, ''); assert.equal(removed.data.data.removedAt, '2026-11-10')
    const archived = await f.request(`/business/records/${legacy.id}/archive`, { method: 'POST', body: { archived: true, version: removed.data.version, reason: 'Archive legacy equipment' } })
    assert.equal(archived.status, 200); assert.equal(archived.data.data.equipmentType, '')
  } finally { await f.close() }
})

test('legacy committed save receipts recover missing Type before new manual validation without duplicate writes', async () => {
  const f = await fixture()
  try {
    const requestId = randomUUID(), data = { name: 'Previously committed logger', description: 'Original legacy details' }, reason = 'Legacy committed equipment save'
    const saved = f.workspace.business.write({ kind: 'equipment', vehicleId: f.car.id, data, actor: f.actor, reason })
    const legacyData = Object.fromEntries(entryFields.map(field => [field, String(data[field as keyof typeof data] || '').trim()]))
    f.workspace.store.set(`equipmentRequest:${requestId}`, { actorKey: JSON.stringify([f.accountId, f.actor.id, f.actor.deviceId]), digest: checksum(JSON.stringify({ id: null, vehicleId: f.car.id, version: null, data: legacyData, reason })), recordId: saved.id, vehicleId: f.car.id })
    const retry = (changes: Fields = {}, session = 'member') => f.request('/business/records', { method: 'POST', session, body: { kind: 'equipment', vehicleId: f.car.id, data: { ...data, ...changes }, reason, requestId } })
    const before = f.counts()
    for (const changes of [{}, { equipmentType: '' }]) { const result = await retry(changes); assert.equal(result.status, 201, JSON.stringify(result.data)); assert.equal(result.data.id, saved.id) }
    assert.deepEqual(f.counts(), before)
    for (const changes of [{ equipmentType: 'Others' }, { name: 'Changed legacy payload' }]) assert.equal((await retry(changes)).data.error, 'EQUIPMENT_REQUEST_MISMATCH')
    assert.equal((await retry({}, 'owner')).data.error, 'EQUIPMENT_REQUEST_MISMATCH')
    const updated = await f.request(`/business/records/${saved.id}`, { method: 'PUT', session: 'member', body: { data: { ...saved.data, equipmentType: 'ETAS tools', description: 'Later classified edit' }, reason: 'Classify existing equipment', version: saved.version, requestId: randomUUID() } })
    assert.equal(updated.status, 200)
    const after = f.counts(), recovered = await retry()
    assert.equal(recovered.data.id, saved.id); assert.equal(recovered.data.data.equipmentType, 'ETAS tools'); assert.equal(recovered.data.data.description, 'Later classified edit'); assert.deepEqual(f.counts(), after)
    const neverCommitted = await f.request('/business/records', { method: 'POST', session: 'member', body: { kind: 'equipment', vehicleId: f.car.id, data, reason, requestId: randomUUID() } })
    assert.equal(neverCommitted.data.error, 'EQUIPMENT_TYPE_REQUIRED'); assert.deepEqual(f.counts(), after)
  } finally { await f.close() }
})

test('equipment dates are independently optional on create/edit and still validate supplied values', async () => {
  const f = await fixture()
  try {
    for (const dates of [{}, { installedAt: '', removedAt: '' }, { installedAt: '2026-11-01' }, { removedAt: '2026-11-09' }, { installedAt: '2026-11-01', removedAt: '2026-11-09' }]) {
      const created = await f.create({ name: 'Fictional date choice', ...dates })
      assert.equal(created.status, 201, JSON.stringify(created.data))
      assert.equal(created.data.data.installedAt, dates.installedAt || '')
      assert.equal(created.data.data.removedAt, dates.removedAt || '')
      const cleared = await f.request(`/business/records/${created.data.id}`, { method: 'PUT', session: 'member', body: { data: { ...created.data.data, installedAt: '', removedAt: '' }, version: created.data.version, reason: 'Clear optional equipment dates', requestId: randomUUID() } })
      assert.equal(cleared.status, 200); assert.equal(cleared.data.data.installedAt, ''); assert.equal(cleared.data.data.removedAt, '')
    }
    const before = f.counts()
    for (const dates of [{ installedAt: '2026-02-30' }, { removedAt: '2026-11-09-invalid' }, { installedAt: '2026-11-09', removedAt: '2026-11-01' }]) assert.equal((await f.create({ name: 'Invalid equipment date', ...dates })).data.error, 'INVALID_DATE')
    assert.equal((await f.create({ name: ' ' })).data.error, 'INVALID_INPUT')
    assert.deepEqual(f.counts(), before)
    const blankReason = await f.request('/business/records', { method: 'POST', body: { kind: 'equipment', vehicleId: f.car.id, data: { name: 'Required reason' }, reason: '' } })
    assert.equal(blankReason.data.error, 'REASON_REQUIRED')
  } finally { await f.close() }
})

test('equipment request IDs recover create and edit responses without duplicating records, history or queued writes', async () => {
  const f = await fixture()
  try {
    const requestId = randomUUID(), data = { name: 'Retry-safe equipment', installedAt: '' }
    const saved = await f.create(data, requestId), before = f.counts()
    for (let index = 0; index < 3; index++) {
      const retry = await f.create(data, requestId)
      assert.equal(retry.status, 201); assert.equal(retry.data.id, saved.data.id); assert.equal(retry.data.version, 1)
      assert.deepEqual(f.counts(), before)
    }
    assert.equal((await f.create({ ...data, name: 'Different payload' }, requestId)).data.error, 'EQUIPMENT_REQUEST_MISMATCH')
    assert.equal((await f.create(data, requestId, 'owner')).data.error, 'EQUIPMENT_REQUEST_MISMATCH')
    assert.equal((await f.create(data, 'not-a-request-id')).data.error, 'INVALID_INPUT')
    const command = { data: { ...saved.data.data, description: 'Updated once' }, reason: 'Update retry-safe equipment', version: saved.data.version, requestId: randomUUID() }
    const updated = await f.request(`/business/records/${saved.data.id}`, { method: 'PUT', session: 'member', body: command })
    assert.equal(updated.status, 200); assert.equal(updated.data.version, 2)
    const afterEdit = f.counts(), retry = await f.request(`/business/records/${saved.data.id}`, { method: 'PUT', session: 'member', body: command })
    assert.equal(retry.status, 200); assert.equal(retry.data.version, 2); assert.deepEqual(f.counts(), afterEdit)
    assert.equal((await f.request(`/business/records/${saved.data.id}`, { method: 'PUT', session: 'member', body: { ...command, requestId: randomUUID() } })).data.error, 'VERSION_CONFLICT')
    assert.equal((await f.request('/business/records', { method: 'POST', session: 'member', body: { kind: 'equipment', vehicleId: f.car.id, data: { name: 'Request without receipt', equipmentType: 'Others' }, reason: 'Equipment save without request ID' } })).status, 201)
  } finally { await f.close() }
})

test('equipment receipt commits atomically and survives reopening while later edits are never overwritten', async () => {
  const f = await fixture()
  try {
    const service = new EquipmentRecords(f.workspace.business), requestId = randomUUID(), command = { vehicleId: f.car.id, data: { name: 'Durable equipment', equipmentType: 'Basic Equipment' }, reason: 'Store durable equipment', requestId }
    const originalSet = f.workspace.store.set, before = f.counts()
    f.workspace.store.set = function (key, value) { if (key.startsWith('equipmentRequest:')) throw new Error('Injected receipt failure'); return originalSet.call(this, key, value) }
    try { assert.throws(() => service.save(command, f.actor, f.accountId), /Injected receipt failure/) }
    finally { f.workspace.store.set = originalSet }
    assert.deepEqual(f.counts(), before)
    const saved = service.save(command, f.actor, f.accountId)
    const changed = f.workspace.business.write({ id: saved.id, kind: 'equipment', vehicleId: f.car.id, data: { ...saved.data, name: 'Later equipment name' }, version: saved.version, actor: f.actor, reason: 'Later independent edit' })
    assert.equal(service.save(command, f.actor, f.accountId).data.name, changed.data.name)
    const workspaceDirectory = f.workspace.store.directory
    await f.client.close()
    const reopened = new LocalStore(workspaceDirectory)
    try {
      const business = new Business(reopened), current = new EquipmentRecords(business).save(command, f.actor, f.accountId)
      assert.equal(current.id, saved.id); assert.equal(current.version, changed.version)
      assert.equal(business.list('equipment', f.car.id).filter(row => row.id === saved.id).length, 1)
    } finally { reopened.db.close() }
  } finally { await f.close() }
})

test('equipment files preserve all seven formats, exact filenames/bytes and record association independently of rename', async () => {
  const f = await fixture()
  try {
    const items = [
      { name: '虚构设备照片.JFIF', bytes: jpeg }, { name: 'manual.PDF', bytes: pdf }, { name: 'image.PNG', bytes: png },
      { name: 'image.JPG', bytes: jpeg }, { name: 'image.JPEG', bytes: jpeg },
      { name: 'data.XLS', bytes: Buffer.from([208, 207, 17, 224, 161, 177, 26, 225]) }, { name: 'data.XLSX', bytes: Buffer.from([80, 75, 3, 4]) },
    ]
    for (const file of items) {
      const uploaded = await f.request(f.route, { method: 'POST', session: 'member', body: upload(file.bytes, file.name) })
      assert.equal(uploaded.status, 201, JSON.stringify(uploaded.data)); assert.equal(uploaded.data.kind, 'attachment')
      assert.equal(uploaded.data.vehicleId, f.car.id); assert.equal(uploaded.data.data.equipmentId, f.equipment.id)
      assert.equal(uploaded.data.data.name, file.name)
      const downloaded = await f.request(`/business/files/${uploaded.data.id}`, { session: 'member' })
      assert.equal(downloaded.status, 200); assert.deepEqual(downloaded.data, file.bytes)
    }
    const renamed = await f.request(`/business/records/${f.equipment.id}`, { method: 'PUT', session: 'member', body: { data: { ...f.equipment.data, name: 'Renamed fictional logger' }, version: f.equipment.version, reason: 'Rename logger', requestId: randomUUID() } })
    assert.equal(renamed.status, 200)
    const attachments = (await f.request('/business/records', { session: 'member' })).data.filter((row: BusinessRecord) => row.kind === 'attachment') as BusinessRecord[]
    assert.equal(attachments.length, items.length); assert(attachments.every(row => row.data.equipmentId === f.equipment.id))
    assert(f.workspace.business.history(f.car.id).filter(change => change.kind === 'attachment').every(change => change.after.equipmentId === f.equipment.id && change.reason === 'Retain fictional equipment evidence'))
    const general = await f.request(`/business/vehicles/${f.car.id}/attachments`, { method: 'POST', session: 'member', body: upload(pdf, 'vehicle-only.pdf') })
    assert.equal(general.status, 201); assert.equal(general.data.data.equipmentId, undefined)
  } finally { await f.close() }
})

test('equipment file rejections retain equipment and earlier uploads, including 10 MiB boundary', async () => {
  const f = await fixture()
  try {
    const exact = Buffer.alloc(limit); jpeg.copy(exact)
    assert.equal((await f.request(f.route, { method: 'POST', session: 'member', body: upload(exact, 'boundary.jfif') })).status, 201)
    for (const file of [{ bytes: Buffer.alloc(limit + 1), name: 'too-big.pdf', code: 'FILE_TOO_LARGE' }, { bytes: png, name: 'not-jpeg.jfif', code: 'FILE_TYPE_NOT_ALLOWED' }, { bytes: pdf, name: 'unsupported.txt', code: 'FILE_TYPE_NOT_ALLOWED' }]) {
      assert.equal((await f.request(f.route, { method: 'POST', session: 'member', body: upload(file.bytes, file.name) })).data.error, file.code)
    }
    assert.equal((await f.request(f.route, { method: 'POST', session: 'member', body: upload(pdf, 'without-reason.pdf', ' ') })).data.error, 'REASON_REQUIRED')
    assert.equal((await f.request(f.route, { method: 'POST', session: 'member', body: upload(pdf, 'x'.repeat(240) + '.pdf') })).data.error, 'INVALID_INPUT')
    const injected = upload(pdf, 'injected.pdf'); injected.append('equipmentId', randomUUID())
    assert.equal((await f.request(f.route, { method: 'POST', session: 'member', body: injected })).data.error, 'INVALID_INPUT')
    assert.equal((await f.request(f.route, { method: 'POST', session: 'member', body: new FormData() })).data.error, 'FILE_REQUIRED')
    const last = await f.request(f.route, { method: 'POST', session: 'member', body: upload(pdf, 'after-errors.pdf') })
    assert.equal(last.status, 201); assert.equal(f.workspace.business.get(f.equipment.id).id, f.equipment.id)
    assert.equal(f.workspace.business.list('attachment', f.car.id).length, 2)
  } finally { await f.close() }
})

test('equipment uploads preserve pending-member, authentication, stale-token and archived-parent protections', async () => {
  const f = await fixture()
  try {
    assert.equal((await f.request(f.route, { method: 'POST', session: 'anonymous', body: upload(pdf, 'anonymous.pdf') })).status, 401)
    assert.equal((await f.request(f.route, { method: 'POST', session: 'pending', body: upload(pdf, 'pending.pdf') })).status, 403)
    assert.equal((await f.request(f.route, { method: 'POST', session: 'member', token: 'stale-workspace-token', body: upload(pdf, 'stale.pdf') })).data.error, 'WORKSPACE_CHANGED')
    assert.equal((await f.request(`/business/equipment/${f.car.id}/attachments`, { method: 'POST', session: 'member', body: upload(pdf, 'wrong-record.pdf') })).data.error, 'INVALID_INPUT')
    const retained = await f.request(f.route, { method: 'POST', session: 'member', body: upload(pdf, 'retained-after-archive.pdf') })
    assert.equal(retained.status, 201)
    assert.equal((await f.request(`/business/records/${f.equipment.id}/archive`, { method: 'POST', body: { archived: true, version: f.equipment.version, reason: 'Archive fictional logger' } })).status, 200)
    assert.equal((await f.request(f.route, { method: 'POST', session: 'member', body: upload(pdf, 'archived-equipment.pdf') })).data.error, 'RECORD_ARCHIVED')
    assert.deepEqual((await f.request(`/business/files/${retained.data.id}`, { session: 'member' })).data, pdf)
    const active = await f.create({ name: 'Logger under archived vehicle' })
    assert.equal((await f.request(`/business/records/${f.car.id}/archive`, { method: 'POST', body: { archived: true, version: f.car.version, reason: 'Archive fictional vehicle' } })).status, 200)
    assert.equal((await f.request(`/business/equipment/${active.data.id}/attachments`, { method: 'POST', session: 'member', body: upload(pdf, 'archived-vehicle.pdf') })).data.error, 'PARENT_ARCHIVED')
    assert.equal(f.workspace.business.list('attachment', f.car.id).length, 1)
  } finally { await f.close() }
})

test('equipment and linked files remain local while synchronization is paused or the configured share is unavailable', async () => {
  const f = await fixture()
  try {
    f.client.store.db.exec('UPDATE sessions SET sync_enabled=1')
    assert.equal((await f.request('/business/sync', { method: 'POST', body: {} })).status, 200)
    f.client.store.db.exec('UPDATE sessions SET sync_enabled=0')
    await f.client.synchronization.settle()
    const head = path.join(f.shared, 'business', 'HEAD.json'), previous = await fs.readFile(head)
    assert.equal((await f.request(f.route, { method: 'POST', session: 'member', body: upload(pdf, 'paused.pdf') })).status, 201)
    assert.equal((await f.request('/status', { session: 'member' })).data.syncPaused, true)
    assert.deepEqual(await fs.readFile(head), previous)
    const configuration = f.workspace.store.get<{ sharedPath: string; teamId: string }>('configuration')!
    await f.client.synchronization.settle()
    f.workspace.store.set('configuration', { ...configuration, sharedPath: path.join(f.shared, 'unavailable-subdirectory') })
    f.client.store.db.exec('UPDATE sessions SET sync_enabled=1')
    try {
      const created = await f.create({ name: 'Offline equipment' })
      assert.equal(created.status, 201, JSON.stringify(created.data))
      const uploaded = await f.request(`/business/equipment/${created.data.id}/attachments`, { method: 'POST', session: 'member', body: upload(pdf, 'offline.pdf') })
      assert.equal(uploaded.status, 201, JSON.stringify(uploaded.data))
      assert.deepEqual((await f.request(`/business/files/${uploaded.data.id}`, { session: 'member' })).data, pdf)
      assert.deepEqual(await fs.readFile(head), previous)
    } finally { f.client.store.db.exec('UPDATE sessions SET sync_enabled=0'); await f.client.synchronization.settle(); f.workspace.store.set('configuration', configuration) }
  } finally { await f.close() }
})

for (const outcome of ['logout', 'revoked', 'workspace-epoch', 'equipment-archive', 'vehicle-archive', 'deleted'] as const) test(`equipment upload rechecks ${outcome} after asynchronous blob persistence`, async () => {
  const f = await fixture(), entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>(), originalBlob = Business.prototype.blob
  let pending: ReturnType<typeof f.request> | null = null
  try {
    const before = f.workspace.business.history(f.car.id).length
    Business.prototype.blob = async function (bytes) { const key = await originalBlob.call(this, bytes); entered.resolve(); await release.promise; return key }
    pending = f.request(f.route, { method: 'POST', session: 'member', body: upload(pdf, 'boundary.pdf'), settle: false })
    await entered.promise
    if (outcome === 'logout') assert.equal((await f.request('/logout', { method: 'POST', session: 'member', body: {}, settle: false })).status, 200)
    else if (outcome === 'workspace-epoch') f.client.store.db.exec('UPDATE sessions SET workspace_epoch=workspace_epoch+1')
    else if (outcome === 'revoked') {
      const member = (await f.request('/team', { settle: false })).data.members.find((row: { role: string }) => row.role === 'member')
      assert.equal((await f.request(`/team/members/${member.id}`, { method: 'POST', body: { enabled: false, role: 'member', reason: 'Revoke fictional upload tester' }, settle: false })).status, 200)
    } else if (outcome === 'deleted') {
      f.workspace.store.rememberDeletions([{ id: randomUUID(), requestId: randomUUID(), vehicleId: f.car.id, vin: String(f.car.data.vin), recordIds: [f.car.id, f.equipment.id], fileKeys: [], actor: { ...f.actor, role: 'admin' }, deletedAt: new Date().toISOString(), revision: randomUUID(), sequence: 1 }])
    } else {
      const current = outcome === 'equipment-archive' ? f.workspace.business.get(f.equipment.id) : f.workspace.business.get(f.car.id)
      f.workspace.business.write({ id: current.id, kind: current.kind, vehicleId: current.vehicleId, data: current.data, version: current.version, archived: true, actor: { ...f.actor, role: 'admin' }, reason: 'Archive during fictional upload' })
    }
    release.resolve()
    const result = await pending
    const expected = { logout: 'LOGIN_REQUIRED', revoked: 'ACCESS_DISABLED', 'workspace-epoch': 'WORKSPACE_CHANGED', 'equipment-archive': 'RECORD_ARCHIVED', 'vehicle-archive': 'PARENT_ARCHIVED', deleted: 'VEHICLE_DELETED' }[outcome]
    assert.equal(result.data.error, expected, JSON.stringify(result.data))
    assert.equal(f.workspace.business.list('attachment', f.car.id).length, 0)
    if (['logout', 'revoked', 'workspace-epoch'].includes(outcome)) assert.equal(f.workspace.business.history(f.car.id).length, before)
  } finally { release.resolve(); if (pending) await pending.catch(() => {}); Business.prototype.blob = originalBlob; await f.close() }
})

test('shutdown waits for an admitted equipment upload through its final attachment write', async () => {
  const f = await fixture(), entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>(), originalBlob = Business.prototype.blob
  let pending: ReturnType<typeof f.request> | null = null, closing: Promise<void> | null = null
  try {
    Business.prototype.blob = async function (bytes) { const key = await originalBlob.call(this, bytes); entered.resolve(); await release.promise; return key }
    pending = f.request(f.route, { method: 'POST', session: 'member', body: upload(pdf, 'shutdown.pdf'), settle: false })
    await entered.promise
    let finished = false
    closing = f.client.close().then(() => { finished = true })
    await new Promise(resolve => setTimeout(resolve, 20)); assert.equal(finished, false)
    release.resolve()
    const result = await pending
    assert.equal(result.status, 201, JSON.stringify(result.data)); assert.equal(result.data.data.equipmentId, f.equipment.id)
    await closing
  } finally { release.resolve(); if (pending) await pending.catch(() => {}); if (closing) await closing.catch(() => {}); Business.prototype.blob = originalBlob; await f.close() }
})
