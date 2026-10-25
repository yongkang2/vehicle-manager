import { test } from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import ExcelJS from 'exceljs'
import { createApp } from '../server/app.js'
import { DoveService } from '../server/dove.js'
import { batteryLifeStatuses, controllerTypes } from '../shared/business.js'
import type { Actor, BusinessRecord, Fields } from '../shared/business.js'

async function fixture() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'vehicle-part-metadata-api-')), client = createApp({ dataDir: path.join(directory, 'local') }), server = client.app.listen(0, '127.0.0.1')
  if (!server.listening) await once(server, 'listening')
  const sessions = new Map<string, { cookie: string; token: string }>()
  async function close() { await new Promise<void>(resolve => server.close(() => resolve())); await client.close(); await fs.rm(directory, { recursive: true, force: true }) }
  async function request(route: string, method = 'GET', body?: unknown, session = 'owner', token?: string) {
    const credentials = sessions.get(session) || { cookie: '', token: '' }
    const response = await fetch(`http://127.0.0.1:${(server.address() as { port: number }).port}/api${route}`, { method, headers: { Cookie: credentials.cookie, 'X-App-Request': 'vehicle-manager', 'X-Workspace-Token': token ?? credentials.token, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body) })
    const cookie = response.headers.get('set-cookie'); if (cookie) credentials.cookie = cookie.split(';')[0]
    if (response.ok) credentials.token = response.headers.get('x-workspace-token') || credentials.token
    sessions.set(session, credentials)
    const data = await response.json(); await client.synchronization.settle(); return { status: response.status, data }
  }
  try {
  for (const session of ['owner', 'member', 'pending']) assert.equal((await request('/register', 'POST', { username: `metadata-${session}`, displayName: session, password: 'metadata-test-password' }, session)).status, 201)
  const shared = path.join(directory, 'shared'); await fs.mkdir(shared)
  const configured = await request('/setup/configure', 'POST', { path: shared, mode: 'create', teamName: 'Metadata team', confirmed: true, retainPending: true })
  assert.equal(configured.status, 200)
  for (const session of ['member', 'pending']) assert.equal((await request('/setup/configure', 'POST', { path: shared, teamId: configured.data.teamId, mode: 'join' }, session)).status, 200)
  const roster = (await request('/team')).data, pending = roster.requests.find((entry: { identity: { displayName: string }; status: string }) => entry.identity.displayName === 'member' && entry.status === 'pending')
  assert(pending)
  assert.equal((await request(`/team/requests/${pending.id}/approve`, 'POST', { role: 'member', memberId: null, reason: 'Approve synthetic metadata tester' })).status, 200)
  const approved = (await request('/status', 'GET', undefined, 'member')).data.member, workspace = client.workspaces.get(configured.data.teamId)
  const actor: Actor = { id: approved.id, name: approved.name, role: 'member', deviceId: workspace.store.deviceId }
  client.store.db.exec('UPDATE sessions SET sync_enabled=0')
  const carResult = await request('/business/records', 'POST', { kind: 'vehicle', data: { vin: 'TEST0000000000001', status: 'available' }, reason: 'Register synthetic vehicle' })
  assert.equal(carResult.status, 201)
  const car = carResult.data as BusinessRecord
  const counts = () => [workspace.business.list().length, workspace.business.history().length, workspace.store.db.prepare('SELECT COUNT(*) AS n FROM outbox').get()!.n]
  const create = (data: Fields, session = 'member') => request('/business/records', 'POST', { kind: 'part', vehicleId: car.id, data, reason: 'Create synthetic part' }, session)
  const update = (current: BusinessRecord, data: Fields, extras: Fields = {}, session = 'member') => request(`/business/records/${current.id}`, 'PUT', { data, version: current.version, reason: 'Update synthetic part', ...extras }, session)
  const legacy = (data: Fields) => workspace.business.write({ kind: 'part', vehicleId: car.id, data, actor, reason: 'Load synthetic legacy row', internal: true })
  return { client, workspace, actor, car, request, create, update, legacy, counts, close }
  } catch (error) { await close(); throw error }
}

test('manual APIs require each category classification and reject invalid enums without records, history or queue changes', async () => {
  const f = await fixture()
  try {
    for (const [field, category, required] of [['controllerType', 'controller', 'CONTROLLER_TYPE_REQUIRED'], ['lifeStatus', 'battery', 'BATTERY_LIFE_STATUS_REQUIRED']] as const) {
      for (const value of [undefined, null, '', '   ', 123, false, [], {}, 'invalid']) {
        const before = f.counts(), result = await f.create({ name: category === 'controller' ? 'VCU' : 'HV Battery', category, [field]: value })
        assert.equal(result.status, 400, JSON.stringify(result.data))
        assert.equal(result.data.error, value === undefined || value === null || typeof value === 'string' && !value.trim() ? required : 'INVALID_INPUT')
        assert.deepEqual(f.counts(), before)
      }
    }
    for (const [index, value] of controllerTypes.entries()) {
      const result = await f.create({ name: index ? 'MCU' : 'VCU', category: 'controller', controllerType: ` ${value} `, type: 'ETK' })
      assert.equal(result.status, 201, JSON.stringify(result.data)); assert.equal(result.data.data.controllerType, value); assert.equal(result.data.data.type, 'ETK')
    }
    for (const value of batteryLifeStatuses) {
      const result = await f.create({ name: 'HV Battery', category: 'battery', lifeStatus: ` ${value} `, batteryStatus: 'healthy' })
      assert.equal(result.status, 201, JSON.stringify(result.data)); assert.equal(result.data.data.lifeStatus, value); assert.equal(result.data.data.batteryStatus, 'healthy')
    }
    assert.equal((await f.create({ name: 'Motor', category: 'motor' })).status, 201)
  } finally { await f.close() }
})

test('legacy manual edits require classification while genuine battery removal alone remains usable', async () => {
  const f = await fixture()
  try {
    const controller = f.legacy({ name: 'VCU', category: 'controller', type: 'Production', software: '1.0' })
    let before = f.counts()
    assert.equal((await f.update(controller, { ...controller.data, software: '1.1' })).data.error, 'CONTROLLER_TYPE_REQUIRED')
    assert.deepEqual(f.counts(), before)
    const classified = await f.update(controller, { ...controller.data, controllerType: 'Close ECU' })
    assert.equal(classified.status, 200); assert.equal(classified.data.data.type, 'Production')
    before = f.counts()
    assert.equal((await f.update(classified.data, { ...classified.data.data, controllerType: '' })).data.error, 'CONTROLLER_TYPE_REQUIRED')
    assert.deepEqual(f.counts(), before)
    const battery = f.legacy({ name: 'HV Battery', category: 'battery', serial: '000123', maturity: 'B1', batteryStatus: 'healthy' })
    for (const data of [{ ...battery.data }, { ...battery.data, maturity: 'B2' }, { ...battery.data, removedAt: '2026-10-26', maturity: 'B2' }]) {
      before = f.counts()
      assert.equal((await f.update(battery, data)).data.error, 'BATTERY_LIFE_STATUS_REQUIRED')
      assert.deepEqual(f.counts(), before)
    }
    assert.equal((await f.update(battery, { ...battery.data, removedAt: '2026-02-30' })).data.error, 'INVALID_DATE')
    assert.equal((await f.update(battery, { ...battery.data, removedAt: '2026-10-26' }, { reason: ' ' })).data.error, 'REASON_REQUIRED')
    assert.equal((await f.update(battery, { ...battery.data, removedAt: '2026-10-26' }, { version: 0 })).data.error, 'VERSION_CONFLICT')
    const removed = await f.update(battery, { ...battery.data, serial: ' 000123 ', controllerType: '', lifeStatus: '', removedAt: '2026-10-26' })
    assert.equal(removed.status, 200, JSON.stringify(removed.data)); assert.equal(removed.data.data.lifeStatus, ''); assert.equal(removed.data.data.batteryStatus, 'healthy')
    assert.equal((await f.update(removed.data, removed.data.data)).data.error, 'BATTERY_LIFE_STATUS_REQUIRED')
    assert.equal((await f.update(removed.data, { ...removed.data.data, removedAt: '2026-10-27' })).data.error, 'BATTERY_LIFE_STATUS_REQUIRED')
    assert.equal((await f.update(removed.data, { ...removed.data.data, removedAt: '' })).data.error, 'BATTERY_LIFE_STATUS_REQUIRED')
    const current = (await f.create({ name: 'HV Battery', category: 'battery', lifeStatus: 'BOL' })).data as BusinessRecord
    assert.equal((await f.update(current, { ...current.data, lifeStatus: '', removedAt: '2026-10-26' })).data.error, 'BATTERY_LIFE_STATUS_REQUIRED')
  } finally { await f.close() }
})

test('required manual classifications do not bypass access, workspace, archive, reason or version checks', async () => {
  const f = await fixture()
  try {
    const data = { name: 'HV Battery', category: 'battery', lifeStatus: 'BOL' }
    assert.equal((await f.create(data, 'guest')).status, 401)
    assert.equal((await f.create(data, 'pending')).status, 403)
    const item = (await f.create(data)).data as BusinessRecord, before = f.counts()
    assert.equal((await f.update(item, { ...item.data, lifeStatus: 'EOL' }, { version: 0 })).data.error, 'VERSION_CONFLICT')
    assert.equal((await f.update(item, { ...item.data, lifeStatus: 'EOL' }, { reason: ' ' })).data.error, 'REASON_REQUIRED')
    assert.equal((await f.request(`/business/records/${item.id}`, 'PUT', { data: item.data, version: item.version, reason: 'Stale scope' }, 'member', 'stale-token')).data.error, 'WORKSPACE_CHANGED')
    assert.deepEqual(f.counts(), before)
    const legacy = f.legacy({ name: 'HV Battery', category: 'battery', batteryStatus: 'healthy' })
    assert.equal((await f.request(`/business/records/${legacy.id}/archive`, 'POST', { archived: true, version: legacy.version, reason: 'Unprivileged archive' }, 'member')).status, 403)
    const archived = await f.request(`/business/records/${legacy.id}/archive`, 'POST', { archived: true, version: legacy.version, reason: 'Archive unclassified legacy battery' })
    assert.equal(archived.status, 200); assert.equal(archived.data.data.lifeStatus, '')
    assert.equal((await f.update(archived.data, { ...archived.data.data, lifeStatus: 'EOL' })).data.error, 'RECORD_ARCHIVED')
    assert.equal((await f.request(`/business/records/${legacy.id}/archive`, 'POST', { archived: false, version: archived.data.version, reason: 'Restore unclassified legacy battery' })).status, 200)
  } finally { await f.close() }
})

test('retained report configuration accepts legacy blanks and preserves an existing manual controller type', async () => {
  const f = await fixture()
  try {
    const part = f.legacy({ name: 'VCU', category: 'controller', controllerType: 'Open ECU', type: 'ETK', software: '1.0' }), dove = new DoveService(f.workspace.business)
    const book = new ExcelJS.Workbook()
    book.addWorksheet('DOVE').addRows([['Vin :', f.car.data.vin], ['Date of record', '2026-10-26']])
    book.addWorksheet('Identification').addRows([['ECU', 'Description', 'Network', 'Supplier'], ['EVCU', 'Synthetic', 'CAN', 'Demo', 'FN', 'PN', '2.0'], ['MCU', 'Synthetic motor controller', 'CAN', 'Demo', 'FN', 'PN', '2.0']])
    book.addWorksheet('Defauts').addRow(['EVCU', '', 'CAN', 'P123456 (2Fh - Permanent) Synthetic'])
    const draft = await dove.preview(Buffer.from(await book.xlsx.writeBuffer()), 'synthetic.xlsx', f.actor.id), report = await dove.save(draft.id, f.actor.id, f.actor, { confirmed: true, reportOnly: true })
    const result = await f.request(`/business/reports/${report.id}/configuration`, 'POST', { reportVersion: report.version, reason: 'Apply retained software only', selections: [{ controllerIndex: 0, partId: part.id, version: part.version, fields: ['software'] }] }, 'member')
    assert.equal(result.status, 200, JSON.stringify(result.data)); assert.equal(result.data[0].data.controllerType, 'Open ECU'); assert.equal(result.data[0].data.type, 'ETK')
    const legacy = f.legacy({ name: 'MCU', category: 'controller', software: '1.0' })
    const blank = await f.request(`/business/reports/${report.id}/configuration`, 'POST', { reportVersion: report.version, reason: 'Apply legacy controller software', selections: [{ controllerIndex: 1, partId: legacy.id, version: legacy.version, fields: ['software'] }] }, 'member')
    assert.equal(blank.status, 200, JSON.stringify(blank.data)); assert.equal(blank.data[0].data.controllerType, '')
  } finally { await f.close() }
})
