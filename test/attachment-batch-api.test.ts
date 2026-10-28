import { test } from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createApp } from '../server/app.js'
import type { BusinessRecord } from '../shared/business.js'

const jpeg = Buffer.from('/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAACAAIDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD5/JJOSck9TRRRWlX+JL1Etj//2Q==', 'base64')
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==', 'base64')
const pdf = Buffer.from('%PDF-1.4\n% Fictional attachment\n%%EOF')
const limit = 10 * 1024 * 1024

function upload(bytes: Buffer, name: string) {
  const form = new FormData()
  form.append('file', new Blob([new Uint8Array(bytes)]), name)
  return form
}

async function fixture() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'attachment-batch-api-'))
  const client = createApp({ dataDir: path.join(directory, 'local') }), server = client.app.listen(0, '127.0.0.1')
  if (!server.listening) await once(server, 'listening')
  const sessions = new Map<string, { cookie: string; token: string }>()
  async function request(route: string, { method = 'GET', body, session = 'owner', token }: { method?: string; body?: unknown; session?: string; token?: string } = {}) {
    const credentials = sessions.get(session) || { cookie: '', token: '' }, form = body instanceof FormData
    const response = await fetch(`http://127.0.0.1:${(server.address() as { port: number }).port}/api${route}`, { method, headers: { Cookie: credentials.cookie, 'X-App-Request': 'vehicle-manager', 'X-Workspace-Token': token ?? credentials.token, ...(body !== undefined && !form ? { 'Content-Type': 'application/json' } : {}) }, body: body === undefined ? undefined : form ? body as FormData : JSON.stringify(body) })
    const cookie = response.headers.get('set-cookie'); if (cookie) credentials.cookie = cookie.split(';')[0]
    if (response.ok) credentials.token = response.headers.get('x-workspace-token') || credentials.token
    sessions.set(session, credentials)
    const data = response.headers.get('content-type')?.includes('json') ? await response.json() : Buffer.from(await response.arrayBuffer())
    await client.synchronization.settle()
    return { status: response.status, data, headers: response.headers }
  }
  async function close() { await new Promise<void>(resolve => server.close(() => resolve())); await client.close(); await fs.rm(directory, { recursive: true, force: true }) }
  try {
    for (const session of ['owner', 'member']) assert.equal((await request('/register', { method: 'POST', session, body: { username: `attachment-${session}`, displayName: `Fictional ${session}`, password: 'attachment-fixture-password' } })).status, 201)
    const shared = path.join(directory, 'shared'); await fs.mkdir(shared)
    const configured = await request('/setup/configure', { method: 'POST', body: { path: shared, mode: 'create', teamName: 'Fictional attachments', confirmed: true } })
    assert.equal(configured.status, 200, JSON.stringify(configured.data))
    assert.equal((await request('/setup/configure', { method: 'POST', session: 'member', body: { path: shared, mode: 'join', teamId: configured.data.teamId } })).status, 200)
    assert.equal((await request('/business/records', { session: 'member' })).status, 403)
    const pending = (await request('/team')).data.requests.find((entry: { status: string }) => entry.status === 'pending')
    assert(pending)
    assert.equal((await request(`/team/requests/${pending.id}/approve`, { method: 'POST', body: { role: 'member', memberId: null, reason: 'Approve fictional upload tester' } })).status, 200)
    const created = await request('/business/records', { method: 'POST', body: { kind: 'vehicle', data: { vin: 'TEST0000000000001', status: 'available', complianceLevel: 'Eu7' }, reason: 'Register fictional attachment target' } })
    assert.equal(created.status, 201, JSON.stringify(created.data))
    const car = created.data as BusinessRecord, workspace = client.workspaces.get(configured.data.teamId)
    return { client, request, close, shared, car, workspace, route: `/business/vehicles/${car.id}/attachments` }
  } catch (error) { await close(); throw error }
}

test('sequential mixed attachments retain independent successes and exact original filenames and bytes', async () => {
  const f = await fixture()
  try {
    assert.equal(jpeg.subarray(6, 11).toString(), 'JFIF\0')
    const uploads = [
      { name: '虚构照片.JFIF', bytes: jpeg, status: 201 },
      { name: 'wrong-content.jfif', bytes: png, status: 422 },
      { name: 'fictional-notes.pdf', bytes: pdf, status: 201 },
      { name: 'fictional-image.png', bytes: png, status: 201 },
      { name: 'fictional-image.jpg', bytes: jpeg, status: 201 },
      { name: 'fictional-image.jpeg', bytes: jpeg, status: 201 },
    ]
    const saved: BusinessRecord[] = []
    for (const item of uploads) {
      const result = await f.request(f.route, { method: 'POST', body: upload(item.bytes, item.name), session: 'member' })
      assert.equal(result.status, item.status, JSON.stringify(result.data))
      if (item.status === 422) { assert.equal(result.data.error, 'FILE_TYPE_NOT_ALLOWED'); continue }
      const record = result.data as BusinessRecord; saved.push(record)
      assert.equal(record.vehicleId, f.car.id); assert.equal(record.data.name, item.name); assert.equal(record.data.size, item.bytes.length)
      const downloaded = await f.request(`/business/files/${record.id}`, { session: 'member' })
      assert.equal(downloaded.status, 200); assert.deepEqual(downloaded.data, item.bytes)
      assert.match(downloaded.headers.get('content-disposition')!, /attachment/)
    }
    const attachments = (await f.request('/business/records', { session: 'member' })).data.filter((record: BusinessRecord) => record.kind === 'attachment') as BusinessRecord[]
    assert.equal(attachments.length, 5)
    assert.deepEqual(new Set(attachments.map(record => record.id)), new Set(saved.map(record => record.id)))
    assert.equal(f.workspace.business.history(f.car.id).filter(change => change.kind === 'attachment').length, 5)
  } finally { await f.close() }
})

test('each attachment keeps the 10 MiB boundary without blocking a later valid file after a size rejection', async () => {
  const f = await fixture()
  try {
    const exact = Buffer.alloc(limit); jpeg.copy(exact)
    const saved = await f.request(f.route, { method: 'POST', body: upload(exact, 'boundary.jfif'), session: 'member' })
    assert.equal(saved.status, 201, JSON.stringify(saved.data)); assert.equal(saved.data.data.size, limit)
    assert.deepEqual((await f.request(`/business/files/${saved.data.id}`, { session: 'member' })).data, exact)
    const tooLarge = Buffer.alloc(limit + 1); jpeg.copy(tooLarge)
    const rejected = await f.request(f.route, { method: 'POST', body: upload(tooLarge, 'too-large.jfif'), session: 'member' })
    assert.equal(rejected.status, 413); assert.equal(rejected.data.error, 'FILE_TOO_LARGE')
    const next = await f.request(f.route, { method: 'POST', body: upload(pdf, 'after-rejection.pdf'), session: 'member' })
    assert.equal(next.status, 201, JSON.stringify(next.data))
    assert.equal(f.workspace.business.list('attachment', f.car.id).length, 2)
  } finally { await f.close() }
})

test('approved members upload while paused or offline without implicitly resuming synchronization', async () => {
  const f = await fixture()
  try {
    f.client.store.db.exec('UPDATE sessions SET sync_enabled=0')
    await f.client.synchronization.settle()
    const head = path.join(f.shared, 'business', 'HEAD.json'), before = await fs.readFile(head)
    for (const name of ['paused-one.jfif', 'paused-two.JFIF']) assert.equal((await f.request(f.route, { method: 'POST', body: upload(jpeg, name), session: 'member' })).status, 201)
    assert.equal((await f.request('/status', { session: 'member' })).data.syncPaused, true)
    assert.equal(f.workspace.synchronization.status().pending, 2)
    assert.deepEqual(await fs.readFile(head), before)
    const configuration = f.workspace.store.get<{ sharedPath: string; teamId: string }>('configuration')
    assert(configuration)
    await f.client.synchronization.settle()
    f.workspace.store.set('configuration', { ...configuration, sharedPath: path.join(f.shared, 'unavailable-share') })
    try {
      f.client.store.db.exec('UPDATE sessions SET sync_enabled=1')
      const saved = await f.request(f.route, { method: 'POST', body: upload(pdf, 'offline.pdf'), session: 'member' })
      assert.equal(saved.status, 201, JSON.stringify(saved.data))
      const status = (await f.request('/status', { session: 'member' })).data
      assert.equal(status.online, false); assert.equal(status.syncPaused, false)
      assert.equal(f.workspace.synchronization.status().pending, 3)
      assert.deepEqual((await f.request(`/business/files/${saved.data.id}`, { session: 'member' })).data, pdf)
      assert.deepEqual(await fs.readFile(head), before)
    } finally {
      f.client.store.db.exec('UPDATE sessions SET sync_enabled=0')
      await f.client.synchronization.settle()
      f.workspace.store.set('configuration', configuration)
    }
  } finally { await f.close() }
})

test('attachment sequences preserve authentication, workspace-token and archived-vehicle protections', async () => {
  const f = await fixture()
  try {
    assert.equal((await f.request(f.route, { method: 'POST', body: upload(jpeg, 'anonymous.jfif'), session: 'anonymous' })).status, 401)
    const stale = await f.request(f.route, { method: 'POST', body: upload(jpeg, 'stale.jfif'), session: 'member', token: 'stale-workspace' })
    assert.equal(stale.status, 409); assert.equal(stale.data.error, 'WORKSPACE_CHANGED')
    const car = f.workspace.business.get(f.car.id)
    assert.equal((await f.request(`/business/records/${car.id}/archive`, { method: 'POST', body: { archived: true, version: car.version, reason: 'Archive fictional upload target' } })).status, 200)
    const archived = await f.request(f.route, { method: 'POST', body: upload(jpeg, 'archived.jfif'), session: 'member' })
    assert.equal(archived.status, 409); assert.equal(archived.data.error, 'PARENT_ARCHIVED')
    assert.equal(f.workspace.business.list('attachment', f.car.id).length, 0)
  } finally { await f.close() }
})
