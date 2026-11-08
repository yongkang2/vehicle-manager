import { test } from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { createApp } from '../server/app.js'
import type { ModificationView } from '../shared/modifications.js'

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'modification-http-')), client = createApp({ dataDir: path.join(root, 'local') })
  const server = client.app.listen(0, '127.0.0.1'); if (!server.listening) await once(server, 'listening')
  const sessions = new Map<string, { cookie: string; token: string }>()
  const request = async (route: string, method = 'GET', body?: unknown, session = 'owner') => {
    const credentials = sessions.get(session) || { cookie: '', token: '' }, form = body instanceof FormData
    const response = await fetch(`http://127.0.0.1:${(server.address() as { port: number }).port}/api${route}`, { method, headers: { Cookie: credentials.cookie, 'X-App-Request': 'vehicle-manager', 'X-Workspace-Token': credentials.token, ...(body === undefined || form ? {} : { 'Content-Type': 'application/json' }) }, body: body === undefined ? undefined : form ? body as FormData : JSON.stringify(body) })
    const cookie = response.headers.get('set-cookie'); if (cookie) credentials.cookie = cookie.split(';')[0]
    if (response.ok) credentials.token = response.headers.get('x-workspace-token') || credentials.token
    sessions.set(session, credentials)
    const data = response.headers.get('content-type')?.includes('json') ? await response.json() : Buffer.from(await response.arrayBuffer())
    await client.synchronization.settle()
    return { status: response.status, data, headers: response.headers }
  }
  const close = async () => { await new Promise<void>(resolve => server.close(() => resolve())); await client.close(); await fs.rm(root, { recursive: true, force: true }) }
  try {
    for (const session of ['owner', 'member']) assert.equal((await request('/register', 'POST', { username: `mod-${session}`, displayName: `Fictional ${session}`, password: 'fictional-modification-password' }, session)).status, 201)
    const shared = path.join(root, 'share'); await fs.mkdir(shared)
    const configured = await request('/setup/configure', 'POST', { path: shared, mode: 'create', teamName: 'Fictional modification team', confirmed: true })
    assert.equal(configured.status, 200)
    await request('/setup/configure', 'POST', { path: shared, mode: 'join', teamId: configured.data.teamId }, 'member')
    const pending = (await request('/team')).data.requests.find((entry: { status: string }) => entry.status === 'pending')
    assert.equal((await request(`/team/requests/${pending.id}/approve`, 'POST', { role: 'member', memberId: null, reason: 'Approve fictional engineer' })).status, 200)
    const cars = []
    for (const number of [1, 2, 3, 4]) {
      const created = await request('/business/records', 'POST', { kind: 'vehicle', data: { name: `Fictional ${number}`, vin: `TEST000000000000${number}`, status: 'available', complianceLevel: 'Eu7' }, reason: 'Register fictional target' })
      assert.equal(created.status, 201); cars.push(created.data)
    }
    const created = await request('/business/records', 'POST', { kind: 'modification', vehicleId: cars[0].id, data: { name: 'Fictional retrofit', description: 'Review only', requestor: '  External requestor  ', lead: '  Test lead  ', installedAt: '2026-11-01', removedAt: '', notes: 'Fictional component' }, reason: 'Record fictional modification' })
    assert.equal(created.status, 201)
    const endpoint = (id = created.data.id) => `/business/modifications/${id}`
    const detail = async (id = created.data.id, session = 'owner'): Promise<ModificationView> => { const result = await request(endpoint(id), 'GET', undefined, session); assert.equal(result.status, 200, JSON.stringify(result.data)); return result.data }
    const enable = async () => { const result = await request('/business/modifications/enable', 'POST', { requestId: randomUUID(), reason: 'All fictional clients support protocol five' }); assert.equal(result.status, 200, JSON.stringify(result.data)) }
    return { root, client, sessions, request, close, shared, cars, endpoint, detail, enable, modification: created.data, workspace: client.workspaces.get(configured.data.teamId) }
  } catch (error) { await close(); throw error }
}
const mutation = (view: ModificationView) => ({ requestId: randomUUID(), reason: 'Reviewed fictional change', version: view.record.version, groupVersion: view.groupVersion })
const form = (view: ModificationView, name: string, bytes = Buffer.from('Fictional request\r\n改装')) => {
  const fields = new FormData(); fields.append('file', new Blob([new Uint8Array(bytes)]), name)
  for (const [key, value] of Object.entries(mutation(view))) if (value !== null) fields.append(key, String(value))
  return fields
}

test('modification HTTP fields, activation, Unicode filenames and ordinary-form metadata protection', async () => {
  const f = await fixture()
  try {
    let view = await f.detail()
    assert.equal(view.record.data.requestor, 'External requestor'); assert.equal(view.record.data.lead, 'Test lead')
    const equipment = await f.request('/business/records', 'POST', { kind: 'equipment', vehicleId: f.cars[0].id, data: { name: 'Equipment', requestor: 'Do not add this field' }, reason: 'Equipment stays unchanged' })
    assert.equal(equipment.status, 201); assert.equal(equipment.data.data.requestor, undefined)
    assert.equal((await f.request(`${f.endpoint()}/files`, 'POST', form(view, 'request.txt'))).data.error, 'MODIFICATION_NOT_ENABLED')
    assert.equal((await f.request('/business/modifications/enable', 'POST', { requestId: randomUUID(), reason: 'Denied member activation' }, 'member')).status, 403)
    await f.enable()
    assert.equal((await f.request('/business/working-view')).data.modificationEnabled, true)
    assert.equal((await f.request('/business/working-view')).data.catalog.enabled, false, 'File activation must not activate configuration revisions')
    const bytes = Buffer.from('Fictional request\r\n申请人：甲'), name = '改装申请.TXT'
    const uploaded = await f.request(`${f.endpoint()}/files`, 'POST', form(view, name, bytes))
    assert.equal(uploaded.status, 201, JSON.stringify(uploaded.data)); view = uploaded.data.modification
    assert.equal(view.files[0].name, name)
    const downloaded = await f.request(`${f.endpoint()}/files/${view.files[0].id}`)
    assert.equal(downloaded.status, 200); assert.deepEqual(downloaded.data, bytes)
    assert.match(downloaded.headers.get('content-disposition')!, /filename\*/)
    const ordinary = await f.request(`/business/records/${view.record.id}`, 'PUT', { version: view.record.version, reason: 'Ordinary form preserves managed files', data: { ...view.record.data, name: 'Edited text', attachments: [], groupId: randomUUID() } })
    assert.equal(ordinary.status, 200, JSON.stringify(ordinary.data)); view = await f.detail()
    assert.equal(view.files.length, 1); assert.equal(view.groupId, null)
    assert.equal((await f.request(`${f.endpoint()}/files`, 'POST', form(view, 'renamed.doc', Buffer.from('Not a Word file')))).status, 422)
    assert.equal((await f.request(`${f.endpoint()}/files/${view.files[0].id}/archive`, 'POST', { ...mutation(view), archived: true }, 'member')).status, 403)
    const deniedGeneral = new FormData(); deniedGeneral.append('file', new Blob([bytes]), 'notes.txt')
    assert.equal((await f.request(`/business/vehicles/${f.cars[0].id}/attachments`, 'POST', deniedGeneral)).status, 422)
    assert.equal((await f.request(f.endpoint(f.cars[0].id))).status, 404)
  } finally { await f.close() }
})

test('HTTP one-time and shared population preserve identity, dates, files, stale guards and archived retry receipts', async () => {
  const f = await fixture()
  try {
    await f.enable()
    let source = await f.detail()
    assert.equal((await f.request(`${f.endpoint()}/files`, 'POST', form(source, 'request.txt'))).status, 201)
    source = await f.detail()
    const targets = [f.cars[1]].map(car => ({ vehicleId: car.id, expectedVin: car.data.vin }))
    const copyRequest = { ...mutation(source), mode: 'oneTime', targets }
    const copied = await f.request(`${f.endpoint()}/populate`, 'POST', copyRequest)
    assert.equal(copied.status, 201, JSON.stringify(copied.data))
    assert.deepEqual((await f.request(`${f.endpoint()}/populate`, 'POST', copyRequest)).data.recordIds, copied.data.recordIds)
    const independent = await f.detail(copied.data.recordIds[0])
    assert.equal(independent.record.data.installedAt, '2026-11-01'); assert.notEqual(independent.files[0].id, source.files[0].id)
    const badTargets = await f.request(`${f.endpoint()}/populate`, 'POST', { ...mutation(source), mode: 'linked', targets: [{ vehicleId: f.cars[2].id, expectedVin: f.cars[3].data.vin }] })
    assert.equal(badTargets.status, 409)
    const linked = await f.request(`${f.endpoint()}/populate`, 'POST', { ...mutation(source), mode: 'linked', targets })
    assert.equal(linked.status, 201, JSON.stringify(linked.data))
    const targetId = linked.data.recordIds[0], reviewed = await f.detail(targetId, 'member')
    const saved = await f.request(f.endpoint(targetId), 'PUT', { ...mutation(reviewed), data: { name: 'Shared edit', description: '', requestor: 'New requestor', lead: 'New lead', installedAt: '2026-11-03', removedAt: '', notes: '' } }, 'member')
    assert.equal(saved.status, 200, JSON.stringify(saved.data))
    assert.equal((await f.detail()).record.data.name, 'Shared edit'); assert.equal((await f.detail()).record.data.installedAt, '2026-11-03')
    assert.equal((await f.detail(independent.record.id)).record.data.name, 'Fictional retrofit')
    assert.equal((await f.request(f.endpoint(targetId), 'PUT', { ...mutation(reviewed), data: { name: 'Stale overwrite' } }, 'member')).status, 409)
    const current = await f.detail(), parent = f.workspace.business.get(f.cars[0].id)
    const archiveRequest = { requestId: randomUUID(), version: parent.version, reason: 'Freeze only the original fictional vehicle', archived: true, groupVersions: { [current.groupId!]: current.groupVersion! } }
    const archive = await f.request(`/business/records/${parent.id}/archive`, 'POST', archiveRequest)
    assert.equal(archive.status, 200, JSON.stringify(archive.data))
    assert.equal((await f.detail()).mode, 'independent'); assert.equal((await f.detail()).record.archived, true)
    const head = await fs.readFile(path.join(f.shared, 'business', 'HEAD.json'), 'utf8')
    const retry = await f.request(`/business/records/${parent.id}/archive`, 'POST', archiveRequest)
    assert.equal(retry.status, 200, JSON.stringify(retry.data)); assert.equal(await fs.readFile(path.join(f.shared, 'business', 'HEAD.json'), 'utf8'), head)
    assert.equal((await f.detail(targetId)).mode, 'linked')
  } finally { await f.close() }
})

test('HTTP pause/offline and session guards retain independent work without publishing shared changes', async () => {
  const f = await fixture()
  try {
    await f.enable()
    const initial = await f.detail(), link = await f.request(`${f.endpoint()}/populate`, 'POST', { ...mutation(initial), mode: 'linked', targets: [{ vehicleId: f.cars[1].id, expectedVin: f.cars[1].data.vin }] })
    assert.equal(link.status, 201)
    const view = await f.detail(), head = await fs.readFile(path.join(f.shared, 'business', 'HEAD.json'), 'utf8')
    f.client.store.db.prepare('UPDATE sessions SET sync_enabled=0').run()
    assert.equal((await f.request(f.endpoint(), 'PUT', { ...mutation(view), data: { name: 'Paused shared edit' } })).data.error, 'CONFIRM_RESUME')
    assert.equal((await f.request(`${f.endpoint()}/unlink`, 'POST', mutation(view))).data.error, 'CONFIRM_RESUME')
    const independent = await f.request('/business/records', 'POST', { kind: 'modification', vehicleId: f.cars[2].id, data: { name: 'Paused independent', requestor: 'Outside team', lead: '' }, reason: 'Retain local-only working data' })
    assert.equal(independent.status, 201); assert.equal(await fs.readFile(path.join(f.shared, 'business', 'HEAD.json'), 'utf8'), head)
    assert(f.workspace.synchronization.status().pending > 0)
    const original = f.workspace.store.get('configuration')
    f.workspace.store.set('configuration', { ...(original as object), sharedPath: path.join(f.root, 'unavailable') })
    try {
      const offline = await f.detail(independent.data.id)
      assert.equal((await f.request(f.endpoint(offline.record.id), 'PUT', { ...mutation(offline), data: { name: 'Offline independent', requestor: '', lead: 'Local lead' } })).status, 200)
      assert.equal((await f.request(f.endpoint(), 'PUT', { ...mutation(view), data: { name: 'Offline shared edit' } })).data.error, 'CONFIRM_RESUME')
      assert.equal(await fs.readFile(path.join(f.shared, 'business', 'HEAD.json'), 'utf8'), head)
    } finally { await f.client.synchronization.settle(); f.workspace.store.set('configuration', original) }
    await f.request('/logout', 'POST', {})
    assert.equal((await f.request(f.endpoint())).status, 401)
  } finally { await f.close() }
})
