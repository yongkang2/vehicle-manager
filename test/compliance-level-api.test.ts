import { test } from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import ExcelJS from 'exceljs'
import { createApp } from '../server/app.js'
import { normalizeFields } from '../server/business.js'
import { complianceLevels } from '../shared/business.js'
import type { Actor, BusinessRecord, Fields } from '../shared/business.js'

const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==', 'base64')
async function fixture() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'vehicle-compliance-api-')), client = createApp({ dataDir: path.join(directory, 'local') }), server = client.app.listen(0, '127.0.0.1')
  if (!server.listening) await once(server, 'listening')
  let cookie = '', token = ''
  async function close() { await new Promise<void>(resolve => server.close(() => resolve())); await client.close(); await fs.rm(directory, { recursive: true, force: true }) }
  async function request(route: string, method = 'GET', body?: unknown, scope = token) {
    const form = body instanceof FormData, response = await fetch(`http://127.0.0.1:${(server.address() as { port: number }).port}/api${route}`, { method, headers: { Cookie: cookie, 'X-App-Request': 'vehicle-manager', 'X-Workspace-Token': scope, ...(body === undefined || form ? {} : { 'Content-Type': 'application/json' }) }, body: body === undefined ? undefined : form ? body : JSON.stringify(body) })
    const saved = response.headers.get('set-cookie'); if (saved) cookie = saved.split(';')[0]
    if (response.ok) token = response.headers.get('x-workspace-token') || token
    const data = response.headers.get('content-type')?.includes('json') ? await response.json() : Buffer.from(await response.arrayBuffer())
    await client.synchronization.settle(); return { status: response.status, data }
  }
  try {
    assert.equal((await request('/register', 'POST', { username: 'compliance-tester', displayName: 'Compliance tester', password: 'compliance-test-password' })).status, 201)
    const shared = path.join(directory, 'shared'); await fs.mkdir(shared)
    const configured = await request('/setup/configure', 'POST', { path: shared, mode: 'create', teamName: 'Compliance team', confirmed: true, retainPending: true })
    assert.equal(configured.status, 200)
    const workspace = client.workspaces.get(configured.data.teamId), member = (await request('/status')).data.member
    const actor: Actor = { id: member.id, name: member.name, role: 'admin', deviceId: workspace.store.deviceId }
    client.store.db.exec('UPDATE sessions SET sync_enabled=0')
    const counts = () => [workspace.business.list().length, workspace.business.history().length, workspace.store.db.prepare('SELECT COUNT(*) AS n FROM outbox').get()!.n]
    const create = (data: Fields) => request('/business/records', 'POST', { kind: 'vehicle', data, reason: 'Register synthetic compliance vehicle' })
    const update = (record: BusinessRecord, data: Fields, extra: Fields = {}) => request(`/business/records/${record.id}`, 'PUT', { data, version: record.version, reason: 'Update synthetic compliance vehicle', ...extra })
    const legacy = (vin = 'TEST0000000000009') => { const data = normalizeFields('vehicle', { vin, status: 'available' }); delete data.complianceLevel; return workspace.business.write({ kind: 'vehicle', data, actor, reason: 'Load synthetic legacy vehicle', internal: true }) }
    return { request, create, update, legacy, counts, workspace, close }
  } catch (error) { await close(); throw error }
}

test('manual vehicle create/edit requires compliance and rejects invalid values without history or queue changes', async () => {
  const f = await fixture()
  try {
    for (const value of [undefined, null, '', '   ', 123, false, [], {}, 'EU7', 'Euro 7', 'CN7']) {
      const before = f.counts(), result = await f.create({ vin: 'TEST0000000000001', status: 'available', complianceLevel: value })
      assert.equal(result.status, 400, JSON.stringify(result.data))
      assert.equal(result.data.error, value === undefined || value === null || typeof value === 'string' && !value.trim() ? 'COMPLIANCE_LEVEL_REQUIRED' : 'INVALID_INPUT')
      assert.deepEqual(f.counts(), before)
    }
    for (const [index, value] of complianceLevels.entries()) {
      const result = await f.create({ vin: `TEST000000000000${index + 1}`, status: 'available', complianceLevel: ` ${value} ` })
      assert.equal(result.status, 201, JSON.stringify(result.data)); assert.equal(result.data.data.complianceLevel, value)
    }
    const legacy = f.legacy(), listed = await f.request('/business/records')
    assert.equal(Object.hasOwn(listed.data.find((record: BusinessRecord) => record.id === legacy.id).data, 'complianceLevel'), false)
    const before = f.counts()
    for (const value of [undefined, null, '', ' ']) assert.equal((await f.update(legacy, { ...legacy.data, owner: 'Manual owner edit', complianceLevel: value })).data.error, 'COMPLIANCE_LEVEL_REQUIRED')
    assert.deepEqual(f.counts(), before)
    const classified = await f.update(legacy, { ...legacy.data, complianceLevel: 'CN6' })
    assert.equal(classified.status, 200); assert.equal(classified.data.data.complianceLevel, 'CN6')
    assert.equal((await f.update(classified.data, { ...classified.data.data, complianceLevel: '' })).data.error, 'COMPLIANCE_LEVEL_REQUIRED')
    assert.equal((await f.update(classified.data, { ...classified.data.data, complianceLevel: 'PL8' }, { version: 0 })).data.error, 'VERSION_CONFLICT')
    assert.equal((await f.update(classified.data, { ...classified.data.data, complianceLevel: 'PL8' }, { reason: ' ' })).data.error, 'REASON_REQUIRED')
    assert.equal((await f.request(`/business/records/${legacy.id}`, 'PUT', { data: classified.data.data, version: classified.data.version, reason: 'Stale scope' }, 'stale-token')).data.error, 'WORKSPACE_CHANGED')
  } finally { await f.close() }
})

test('legacy compliance blanks remain usable for DOVE, archive and photo workflows, and manual edits retain managed covers', async () => {
  const f = await fixture()
  try {
    const preferences = { version: 1, columns: ['vehicle', 'owner', 'actions'], widths: { owner: 321 } }
    assert.equal((await f.request('/business/vehicle-table-preferences', 'PUT', preferences)).status, 200)
    const car = f.legacy(), book = new ExcelJS.Workbook()
    book.addWorksheet('DOVE').addRows([['Vin :', car.data.vin], ['Date of record', '2026-10-26']])
    book.addWorksheet('Identification').addRows([['ECU', 'Description', 'Network', 'Supplier'], ['EVCU', 'Synthetic', 'CAN', 'Demo', 'FN', 'PN', '2.0']])
    book.addWorksheet('Defauts').addRow(['EVCU', '', 'CAN', 'P123456 (2Fh - Permanent) Synthetic'])
    const upload = new FormData(); upload.append('file', new Blob([new Uint8Array(await book.xlsx.writeBuffer())]), 'synthetic.xlsx')
    const preview = await f.request('/business/dove/preview', 'POST', upload)
    assert.equal(preview.status, 200, JSON.stringify(preview.data))
    const report = await f.request('/business/dove/save', 'POST', { draftId: preview.data.id, confirmation: { confirmed: true } })
    assert.equal(report.status, 201, JSON.stringify(report.data)); assert.equal(f.workspace.business.list('part', car.id)[0].data.controllerType, '')
    assert.equal(Object.hasOwn(f.workspace.business.get(car.id).data, 'complianceLevel'), false)
    const archived = await f.request(`/business/records/${car.id}/archive`, 'POST', { archived: true, version: car.version, reason: 'Archive legacy vehicle' })
    assert.equal(archived.status, 200); assert.equal(archived.data.data.complianceLevel, '')
    const restored = await f.request(`/business/records/${car.id}/archive`, 'POST', { archived: false, version: archived.data.version, reason: 'Restore legacy vehicle' })
    assert.equal(restored.status, 200)
    const photo = new FormData(); photo.append('file', new Blob([new Uint8Array(image)]), 'synthetic.png'); photo.append('version', String(restored.data.version)); photo.append('reason', 'Choose legacy cover')
    const selected = await f.request(`/business/vehicles/${car.id}/photo`, 'POST', photo)
    assert.equal(selected.status, 201, JSON.stringify(selected.data)); assert.equal(selected.data.vehicle.data.complianceLevel, '')
    const manual = await f.update(selected.data.vehicle, { ...selected.data.vehicle.data, complianceLevel: 'Eu6', owner: 'Updated owner', photoAttachmentId: '../untrusted-input' })
    assert.equal(manual.status, 200, JSON.stringify(manual.data)); assert.equal(manual.data.data.photoAttachmentId, selected.data.attachment.id)
    assert.equal(manual.data.data.complianceLevel, 'Eu6')
    assert.deepEqual((await f.request(`/business/vehicles/${car.id}/photo`)).data, image)
    assert.deepEqual((await f.request('/business/vehicle-table-preferences')).data, preferences)
  } finally { await f.close() }
})
