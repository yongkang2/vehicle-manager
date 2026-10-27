import { test } from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createApp } from '../server/app.js'
import { Business } from '../server/business.js'
import { BusinessSync } from '../server/sync.js'
import { LocalStore } from '../server/store.js'
import { TeamDirectory } from '../server/team.js'
import type { Actor, BusinessRecord, VehicleDeletePreview, VehicleDeleteRequest } from '../shared/business.js'

test('HTTP deletion preserves archive behavior, enforces confirmations and permissions, removes the full graph, and protects backup restore', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vehicle-delete-api-')), shared = path.join(root, 'shared')
  await fs.mkdir(shared)
  const clients = ['admin', 'member'].map(name => {
    const services = createApp({ dataDir: path.join(root, name) })
    return { ...services, server: services.app.listen(0, '127.0.0.1'), cookie: '', workspaceToken: '' }
  })
  for (const client of clients) if (!client.server.listening) await once(client.server, 'listening')
  async function request(client: typeof clients[number], route: string, method = 'GET', body?: unknown) {
    const form = body instanceof FormData
    const response = await fetch('http://127.0.0.1:' + (client.server.address() as { port: number }).port + '/api' + route, {
      method, headers: { Cookie: client.cookie, 'X-Workspace-Token': client.workspaceToken, 'X-App-Request': 'vehicle-manager', ...(body && !form ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? form ? body : JSON.stringify(body) : undefined,
    })
    const cookie = response.headers.get('set-cookie'); if (cookie) client.cookie = cookie.split(';')[0]
    if (response.ok) client.workspaceToken = response.headers.get('x-workspace-token') || client.workspaceToken
    const data = response.headers.get('content-type')?.includes('json') ? await response.json() : Buffer.from(await response.arrayBuffer())
    await client.synchronization.settle()
    return { status: response.status, data }
  }
  const [admin, member] = clients
  try {
    for (const [index, client] of clients.entries()) assert.equal((await request(client, '/register', 'POST', { username: 'delete-user-' + index, displayName: 'Deletion tester ' + index, password: 'deletion-test-password' })).status, 201)
    assert.equal((await request(admin, '/setup/configure', 'POST', { path: shared, mode: 'create', teamName: 'Deletion API test', confirmed: true })).status, 200)
    const check = (await request(member, '/setup/check', 'POST', { path: shared })).data
    await request(member, '/setup/configure', 'POST', { path: shared, mode: 'join', teamId: check.teamId })
    const team = (await request(admin, '/team')).data
    assert.equal((await request(admin, '/team/requests/' + team.requests[0].id + '/approve', 'POST', { role: 'member', memberId: null, reason: 'Verified test identity' })).status, 200)

    const car = (await request(admin, '/business/records', 'POST', { kind: 'vehicle', data: { name: 'Delete target', vin: 'TEST0000000000001', status: 'available', complianceLevel: 'Eu7', physicalLocation: 'Workshop A' }, reason: 'Register vehicle' })).data as BusinessRecord
    assert.equal((await request(admin, '/business/vehicles/' + car.id + '/delete-preview')).data.error, 'VEHICLE_NOT_ARCHIVED')
    const children: BusinessRecord[] = []
    for (const kind of ['part', 'modification', 'equipment']) {
      const child = await request(admin, '/business/records', 'POST', { kind, vehicleId: car.id, data: { name: kind === 'part' ? 'VCU' : kind, ...(kind === 'part' ? { category: 'controller', controllerType: 'Open ECU' } : {}) }, reason: 'Add child' })
      assert.equal(child.status, 201); children.push(child.data)
    }
    const original = Buffer.from('Retained synthetic report bytes'), key = await admin.business.blob(original)
    const actor: Actor = { id: team.members[0].id, name: team.members[0].name, role: 'admin', deviceId: admin.store.deviceId }
    const report = admin.business.write({ kind: 'report', vehicleId: car.id, data: { name: 'synthetic.xlsx', checksum: key, size: original.length, parsed: { vin: car.data.vin, controllers: [], faults: [] } }, actor, reason: 'Retain synthetic report fixture', internal: true })
    const attachmentForm = new FormData()
    attachmentForm.append('file', new Blob(['%PDF-1.7\nSynthetic attachment']), 'synthetic.pdf')
    const attachment = await request(admin, '/business/vehicles/' + car.id + '/attachments', 'POST', attachmentForm)
    assert.equal(attachment.status, 201)
    const backup = await request(admin, '/business/backup'); assert.equal(backup.status, 200)

    const archived = await request(admin, '/business/records/' + car.id + '/archive', 'POST', { archived: true, version: car.version, reason: 'Archive before deletion' })
    assert.equal(archived.status, 200)
    assert.equal((await request(member, '/business/vehicles/' + car.id + '/delete-preview')).status, 403)
    const previewResponse = await request(admin, '/business/vehicles/' + car.id + '/delete-preview')
    assert.equal(previewResponse.status, 200)
    const oldPreview = previewResponse.data as VehicleDeletePreview
    assert.deepEqual(oldPreview.counts, { vehicle: 1, part: 1, modification: 1, equipment: 1, report: 1, attachment: 1 })
    assert.equal(oldPreview.protocolUpgrade, true)
    assert.ok(oldPreview.expires > Date.now())
    assert.equal((await request(admin, '/business/records')).data.length, 6, 'Preview/cancellation must not delete working records')

    const child = (await request(admin, '/business/records')).data.find((row: BusinessRecord) => row.id === children[0].id)
    const reopened = await request(admin, '/business/records/' + car.id + '/archive', 'POST', { archived: false, version: archived.data.version, reason: 'Reopen before changing a child' })
    assert.equal(reopened.status, 200)
    assert.equal((await request(admin, '/business/records/' + child.id, 'PUT', { data: { ...child.data, software: 'Changed after preview' }, version: child.version, reason: 'Change child after preview' })).status, 200)
    const latestCar = (await request(admin, '/business/records')).data.find((row: BusinessRecord) => row.id === car.id)
    assert.equal((await request(admin, '/business/records/' + car.id + '/archive', 'POST', { archived: true, version: latestCar.version, reason: 'Archive updated graph' })).status, 200)
    const oldRequest: VehicleDeleteRequest = { previewToken: oldPreview.token, version: oldPreview.version, vin: oldPreview.vin, confirmation: 'DELETE', reason: 'Delete test graph', requestId: randomUUID() }
    assert.equal((await request(admin, '/business/vehicles/' + car.id, 'DELETE', oldRequest)).data.error, 'DELETE_PREVIEW_CHANGED')
    const preview = (await request(admin, '/business/vehicles/' + car.id + '/delete-preview')).data as VehicleDeletePreview
    const deletion: VehicleDeleteRequest = { ...oldRequest, previewToken: preview.token, version: preview.version, requestId: randomUUID() }
    assert.equal((await request(member, '/business/vehicles/' + car.id, 'DELETE', deletion)).status, 403)
    assert.equal((await request(admin, '/business/vehicles/' + car.id, 'DELETE', { ...deletion, confirmation: '' })).status, 400)
    assert.equal((await request(admin, '/business/vehicles/' + car.id, 'DELETE', { ...deletion, reason: '' })).data.error, 'REASON_REQUIRED')
    assert.equal((await request(admin, '/business/vehicles/' + car.id, 'DELETE', { ...deletion, vin: 'TEST0000000000009' })).status, 409)

    const deleted = await request(admin, '/business/vehicles/' + car.id, 'DELETE', deletion)
    assert.equal(deleted.status, 200); assert.equal(deleted.data.localSynced, true)
    assert.equal(deleted.data.recordIds.length, 6)
    assert.equal((await request(admin, '/business/records')).data.length, 0)
    assert.equal((await request(member, '/business/records')).data.length, 0)
    assert.equal((await request(admin, '/business/files/' + report.id)).status, 410)
    assert.equal((await request(admin, '/business/files/' + attachment.data.id)).status, 410)
    assert.ok((await request(admin, '/business/history?vehicleId=' + car.id)).data.some((change: { action: string }) => change.action === 'vehicle.deleted'))
    assert.equal((await request(admin, '/business/export')).data.records.length, 0)
    const retry = await request(admin, '/business/vehicles/' + car.id, 'DELETE', deletion)
    assert.equal(retry.status, 200); assert.equal(retry.data.id, deleted.data.id)
    assert.equal((await request(admin, '/business/vehicles/' + car.id, 'DELETE', { ...deletion, reason: 'Changed request body' })).data.error, 'DELETE_REQUEST_MISMATCH')
    assert.deepEqual((await request(admin, '/business/sync/quarantined')).data, [])
    assert.deepEqual((await request(admin, '/business/sync/quarantined/export')).data.operations, [])
    assert.deepEqual(await admin.business.readBlob(key), original, 'Working deletion must not purge original blobs')

    const restoreForm = new FormData()
    restoreForm.append('file', new Blob([new Uint8Array(backup.data as Buffer)]), 'before-delete.zip')
    restoreForm.append('confirmation', 'RESTORE'); restoreForm.append('reason', 'Restore unrelated state without resurrecting deleted vehicles')
    const previewForm = new FormData(); previewForm.append('file', new Blob([new Uint8Array(backup.data as Buffer)]), 'before-delete.zip')
    const backupPreview = await request(admin, '/business/restore/preview', 'POST', previewForm)
    assert.equal(backupPreview.status, 200); restoreForm.append('previewFingerprint', backupPreview.data.fingerprint); restoreForm.append('archiveRecordIds', JSON.stringify([]))
    const restored = await request(admin, '/business/restore', 'POST', restoreForm)
    assert.equal(restored.status, 200); assert.equal(restored.data.skippedVehicles, 1); assert.equal(restored.data.skippedRecords, 6)
    assert.equal((await request(admin, '/business/records')).data.length, 0)
    assert.equal(admin.store.deletionRows().length, 1)
    const replacement = await request(admin, '/business/records', 'POST', { kind: 'vehicle', data: { vin: car.data.vin, status: 'available', complianceLevel: 'Eu7', physicalLocation: 'New registration' }, reason: 'Reuse VIN under a new identity' })
    assert.equal(replacement.status, 201); assert.notEqual(replacement.data.id, car.id)
    assert.equal(replacement.data.data.physicalLocation, 'New registration')
    const pendingVehicle = await request(admin, '/business/records', 'POST', { kind: 'vehicle', data: { vin: 'TEST0000000000002', status: 'available', complianceLevel: 'Eu7' }, reason: 'Create pending record for preview test' })
    assert.equal(pendingVehicle.status, 201)
    const workspaceStore = admin.workspaces.get(team.id).store
    const pendingOperation = workspaceStore.db.prepare('SELECT id FROM outbox ORDER BY seq DESC LIMIT 1').get()!.id as string
    workspaceStore.db.prepare("UPDATE outbox SET state='pending' WHERE id=?").run(pendingOperation)
    const headBeforePreview = await fs.readFile(path.join(shared, 'business', 'HEAD.json'), 'utf8')
    const readonlyPreviewForm = new FormData(); readonlyPreviewForm.append('file', new Blob([new Uint8Array(backup.data as Buffer)]), 'before-delete.zip')
    const blockedPreview = await request(admin, '/business/restore/preview', 'POST', readonlyPreviewForm)
    assert.equal(blockedPreview.data.error, 'PENDING_BEFORE_RESTORE')
    assert.equal(await fs.readFile(path.join(shared, 'business', 'HEAD.json'), 'utf8'), headBeforePreview)
    await fs.rename(shared, shared + '-offline')
    try { assert.equal((await request(admin, '/business/vehicles/' + replacement.data.id + '/delete-preview')).status, 503) }
    finally { await fs.rename(shared + '-offline', shared) }
    assert.equal(admin.store.db.prepare('PRAGMA user_version').get()!.user_version, 4)
  } finally {
    for (const client of clients) {
      await new Promise<void>(resolve => client.server.close(() => resolve()))
      await client.close()
    }
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('the maintenance gate drains nested asynchronous writes and shutdown settlement waits for maintenance', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vehicle-delete-maintenance-'))
  const store = new LocalStore(root), business = new Business(store), sync = new BusinessSync(business, new TeamDirectory())
  const actor: Actor = { id: 'admin', name: 'Administrator', role: 'admin', deviceId: store.deviceId }
  let releaseWrite!: () => void, releaseMaintenance!: () => void
  const writeBarrier = new Promise<void>(resolve => { releaseWrite = resolve })
  const maintenanceBarrier = new Promise<void>(resolve => { releaseMaintenance = resolve })
  const events: string[] = []
  try {
    const admitted = store.runWrite(async () => {
      await writeBarrier
      await store.runWrite(() => { business.write({ kind: 'vehicle', data: { vin: 'TEST0000000000001', status: 'available' }, actor, reason: 'Admitted nested write' }); events.push('write') })
    })
    const maintenance = store.withMaintenance(async () => { events.push('maintenance'); await maintenanceBarrier })
    await assert.rejects(store.runWrite(() => events.push('unexpected')), { code: 'MAINTENANCE_IN_PROGRESS' })
    assert.throws(() => business.write({ kind: 'vehicle', data: { vin: 'TEST0000000000002', status: 'available' }, actor, reason: 'Unadmitted write' }), { code: 'MAINTENANCE_IN_PROGRESS' })
    let settled = false
    const settlement = sync.settle().then(() => { settled = true })
    releaseWrite(); await admitted
    await new Promise(resolve => setTimeout(resolve, 5))
    assert.deepEqual(events, ['write', 'maintenance'])
    assert.equal(settled, false, 'Shutdown must not close SQLite while maintenance is active')
    releaseMaintenance(); await maintenance; await settlement
    assert.equal(settled, true)
    assert.equal(business.list().length, 1)
  } finally { releaseWrite?.(); releaseMaintenance?.(); await store.settleWork(); store.db.close(); await fs.rm(root, { recursive: true, force: true }) }
})
