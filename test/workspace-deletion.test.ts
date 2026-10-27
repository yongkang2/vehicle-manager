import { test } from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import ExcelJS from 'exceljs'
import unzipper from 'unzipper'
import { createApp } from '../server/app.js'
import type { Actor, BusinessRecord, Operation, VehicleDeletion, VehicleDeletePreview } from '../shared/business.js'

const vin = 'TEST0000000000001'
async function fixture() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'workspace-deletion-'))
  const client = createApp({ dataDir: path.join(directory, 'local') }), server = client.app.listen(0, '127.0.0.1')
  if (!server.listening) await once(server, 'listening')
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`, sessions = new Map<string, { cookie: string; token: string }>()
  async function request(route: string, { method = 'GET', body, session = 'owner', token, signal, settle = true }: { method?: string; body?: unknown; session?: string; token?: string; signal?: AbortSignal; settle?: boolean } = {}) {
    const credentials = sessions.get(session) || { cookie: '', token: '' }, form = body instanceof FormData
    const response = await fetch(`${origin}/api${route}`, { method, signal, headers: { Cookie: credentials.cookie, 'X-App-Request': 'vehicle-manager', 'X-Workspace-Token': token ?? credentials.token, ...(body && !form ? { 'Content-Type': 'application/json' } : {}) }, body: body ? form ? body : JSON.stringify(body) : undefined })
    const cookie = response.headers.get('set-cookie'); if (cookie) credentials.cookie = cookie.split(';')[0]
    if (response.ok) credentials.token = response.headers.get('x-workspace-token') || credentials.token
    sessions.set(session, credentials)
    const data = response.headers.get('content-type')?.includes('json') ? await response.json() : Buffer.from(await response.arrayBuffer())
    if (settle) await client.synchronization.settle()
    return { status: response.status, data }
  }
  const register = async (session = 'owner') => {
    const response = await request('/register', { method: 'POST', session, body: { username: `workspace-delete-${session}`, displayName: session, password: 'workspace-deletion-test-password' } })
    assert.equal(response.status, 201, JSON.stringify(response.data))
  }
  async function team(name: string, session = 'owner') {
    const shared = path.join(directory, name); await fs.mkdir(shared)
    const response = await request('/setup/configure', { method: 'POST', session, body: { path: shared, mode: 'create', teamName: name, confirmed: true, retainPending: true } })
    assert.equal(response.status, 200, JSON.stringify(response.data))
    return { id: response.data.teamId as string, shared }
  }
  const select = (id: string, session = 'owner', retainPending = false) => request('/workspaces/select', { method: 'POST', session, body: { teamId: id, retainPending } })
  const vehicle = async (session = 'owner') => {
    const response = await request('/business/records', { method: 'POST', session, body: { kind: 'vehicle', data: { vin, status: 'available', complianceLevel: 'Eu7', physicalLocation: `Location ${session}` }, reason: 'Register isolated vehicle' } })
    assert.equal(response.status, 201, JSON.stringify(response.data)); return response.data as BusinessRecord
  }
  let serverClosed = false
  const closeServer = async () => { if (!serverClosed) { serverClosed = true; await new Promise<void>(resolve => server.close(() => resolve())) } }
  const close = async () => { await closeServer(); await client.close(); await fs.rm(directory, { recursive: true, force: true }) }
  return { client, server, directory, sessions, request, register, team, select, vehicle, close, closeServer }
}
function upload(bytes: Buffer, filename: string, restore = false): FormData {
  const form = new FormData(); form.append('file', new Blob([new Uint8Array(bytes)]), filename)
  if (restore) { form.append('confirmation', 'RESTORE'); form.append('reason', 'Restore isolated workspace backup') }
  return form
}
async function manifest(bytes: Buffer) {
  const archive = await unzipper.Open.buffer(bytes)
  return JSON.parse((await archive.files.find(file => file.path === 'manifest.json')!.buffer()).toString())
}
async function workbook(): Promise<Buffer> {
  const book = new ExcelJS.Workbook()
  book.addWorksheet('DOVE').addRows([['Vin :', vin], ['Date of record', '2026-10-21']])
  book.addWorksheet('Identification').addRows([['ECU', 'Description', 'Network', 'Supplier'], ['EVCU', 'Controller', 'CAN', 'Supplier', 'FN', 'PN', '1.0', '', 'CAL', '2', '', '', '', '000123']])
  book.addWorksheet('Defauts')
  return Buffer.from(await book.xlsx.writeBuffer())
}

test('workspace UUID collisions cannot leak deletion, quarantine, backups, originals or DOVE drafts across admin/member boundaries', { timeout: 30000 }, async () => {
  const context = await fixture(), { client, request, select } = context
  try {
    await context.register(); const a = await context.team('team-a')
    const car = await context.vehicle(), workspaceA = client.workspaces.get(a.id)
    const staleOperation = JSON.parse(workspaceA.store.db.prepare('SELECT payload FROM outbox WHERE record_id=? ORDER BY seq LIMIT 1').get(car.id)!.payload as string) as Operation
    await context.register('other'); const b = await context.team('team-b', 'other'), workspaceB = client.workspaces.get(b.id)
    const status = (await request('/status', { session: 'other' })).data
    const actor: Actor = { id: status.member.id, name: status.member.name, role: 'admin', deviceId: workspaceB.store.deviceId }
    workspaceB.business.write({ id: car.id, kind: 'vehicle', data: { vin, status: 'available', physicalLocation: 'Location other' }, actor, reason: 'Same UUID in separate team fixture' })
    assert.equal((await request('/business/sync', { session: 'other', method: 'POST', body: {} })).data.pending, 0)
    assert.equal((await request('/setup/configure', { method: 'POST', body: { path: b.shared, teamId: b.id, mode: 'join' } })).status, 200)
    const roster = (await request('/team', { session: 'other' })).data
    const applicant = roster.requests.find((item: { status: string }) => item.status === 'pending')
    assert.equal((await request(`/team/requests/${applicant.id}/approve`, { method: 'POST', session: 'other', body: { role: 'member', memberId: null, reason: 'Member in second workspace' } })).status, 200)
    assert.equal((await request('/status')).data.member.role, 'member')
    assert.equal((await request(`/business/vehicles/${car.id}/delete-preview`)).status, 403)
    assert.equal((await request('/business/backup')).status, 403)
    await select(a.id)
    const bytes = await workbook(), previewA = await request('/business/dove/preview', { method: 'POST', body: upload(bytes, 'a.xlsx') })
    assert.equal(previewA.status, 200)
    const oldToken = context.sessions.get('owner')!.token
    await select(b.id)
    const stale = await request(`/business/vehicles/${car.id}/delete-preview`, { token: oldToken })
    assert.equal(stale.data.error, 'WORKSPACE_CHANGED')
    assert.equal((await request('/business/dove/save', { method: 'POST', body: { draftId: previewA.data.id, confirmation: { confirmed: true, reportOnly: true } } })).data.error, 'DRAFT_EXPIRED')
    const previewB = await request('/business/dove/preview', { method: 'POST', body: upload(bytes, 'b.xlsx') })
    const reportB = await request('/business/dove/save', { method: 'POST', body: { draftId: previewB.data.id, confirmation: { confirmed: true, reportOnly: true } } })
    assert.equal(reportB.status, 201)
    await select(a.id)
    const freshA = await request('/business/dove/preview', { method: 'POST', body: upload(bytes, 'a-fresh.xlsx') })
    const reportA = await request('/business/dove/save', { method: 'POST', body: { draftId: freshA.data.id, confirmation: { confirmed: true, reportOnly: true } } })
    assert.equal(reportA.status, 201); assert.equal(reportA.data.id, reportB.data.id)
    const before = (await request('/business/records')).data.find((record: BusinessRecord) => record.id === car.id)
    assert.equal((await request(`/business/records/${car.id}/archive`, { method: 'POST', body: { version: before.version, archived: true, reason: 'Archive isolated deletion target' } })).status, 200)
    const preview = (await request(`/business/vehicles/${car.id}/delete-preview`)).data as VehicleDeletePreview
    const removed = await request(`/business/vehicles/${car.id}`, { method: 'DELETE', body: { previewToken: preview.token, version: preview.version, vin, confirmation: 'DELETE', reason: 'Delete only workspace A', requestId: randomUUID() } })
    assert.equal(removed.status, 200, JSON.stringify(removed.data))
    workspaceA.store.importQuarantine([{ id: staleOperation.id, vehicleId: car.id, reason: 'VEHICLE_DELETED', quarantinedAt: new Date().toISOString(), operation: staleOperation }])
    assert.equal((await request('/business/sync/quarantined')).data.length, 1)
    const backupA = await request('/business/backup'), dataA = await manifest(backupA.data as Buffer)
    assert.equal(dataA.teamId, a.id); assert.equal(dataA.deletions.length, 1); assert.equal(dataA.quarantinedOperations.length, 1)
    assert.equal((await request(`/business/files/${reportA.data.id}`)).status, 410)
    await select(b.id)
    assert.deepEqual((await request('/business/sync/quarantined')).data, [])
    assert.equal((await request(`/business/files/${reportB.data.id}`)).status, 200)
    assert.equal(workspaceB.business.get(car.id).data.physicalLocation, 'Location other')
    assert.equal(workspaceB.store.deletionRows().length, 0); assert.equal(workspaceB.store.quarantineRows().length, 0)
    const backupB = await request('/business/backup', { session: 'other' }), dataB = await manifest(backupB.data as Buffer)
    assert.equal(dataB.teamId, b.id); assert.equal(dataB.deletions.length, 0); assert.equal(dataB.quarantinedOperations.length, 0)
    assert.equal(dataB.records.some((record: BusinessRecord) => record.id === car.id), true)
    assert.deepEqual(await workspaceA.business.readBlob(String(reportA.data.data.checksum)), bytes)
    assert.deepEqual(await workspaceB.business.readBlob(String(reportB.data.data.checksum)), bytes)
  } finally { await context.close() }
})

test('import-only pending deletion markers pause login and selection; paused preview, delete and restore never publish', async () => {
  const context = await fixture(), { client, request, select } = context
  try {
    await context.register(); const a = await context.team('paused-a'), car = await context.vehicle(), workspace = client.workspaces.get(a.id)
    const archived = await request(`/business/records/${car.id}/archive`, { method: 'POST', body: { version: car.version, archived: true, reason: 'Archive paused test target' } })
    assert.equal(archived.status, 200)
    const backup = (await request('/business/backup')).data as Buffer, status = (await request('/status')).data
    const b = await context.team('paused-b'), vehicleId = randomUUID()
    const actor: Actor = { id: status.member.id, name: status.member.name, role: 'admin', deviceId: workspace.store.deviceId }
    const deletion: VehicleDeletion = { id: randomUUID(), requestId: randomUUID(), vehicleId, vin: 'TEST0000000000002', recordIds: [vehicleId], fileKeys: [], actor, reason: 'Retained backup marker awaiting publication', deletedAt: new Date().toISOString(), revision: randomUUID(), sequence: 1 }
    workspace.store.transaction(() => { workspace.store.applyDeletions([deletion]); workspace.store.set('pendingDeletionImports', [{ deletion, actor }]) })
    assert.equal(workspace.store.db.prepare("SELECT COUNT(*) AS total FROM outbox WHERE state='pending'").get()!.total, 0)
    assert.equal(workspace.synchronization.status().pending, 1)
    assert.equal((await select(a.id)).data.syncPaused, true)
    assert.equal((await select(b.id)).data.error, 'PENDING_BEFORE_SWITCH')
    assert.equal((await request('/login', { method: 'POST', session: 'again', body: { username: 'workspace-delete-owner', password: 'workspace-deletion-test-password' } })).status, 200)
    assert.equal((await request('/status', { session: 'again' })).data.syncPaused, true)
    const headPath = path.join(a.shared, 'business', 'HEAD.json'), before = await fs.readFile(headPath, 'utf8')
    assert.equal((await request(`/business/vehicles/${car.id}/delete-preview`)).data.error, 'CONFIRM_RESUME')
    assert.equal((await request(`/business/vehicles/${car.id}`, { method: 'DELETE', body: { confirmation: 'DELETE', reason: 'Must remain paused', requestId: randomUUID(), vin } })).data.error, 'CONFIRM_RESUME')
    assert.equal((await request('/business/restore', { method: 'POST', body: upload(backup, 'paused.zip', true) })).data.error, 'CONFIRM_RESUME')
    await client.tick()
    assert.equal(await fs.readFile(headPath, 'utf8'), before)
    assert.equal(workspace.synchronization.status().pending, 1)
    assert.equal((await request('/workspaces/resume', { method: 'POST', body: { confirmed: true } })).status, 200)
    assert.equal((await request('/business/sync', { method: 'POST', body: {} })).data.pending, 0)
    assert.equal(JSON.parse(await fs.readFile(headPath, 'utf8')).protocol, 2)
    assert.deepEqual(workspace.store.get('pendingDeletionImports'), [])
    assert.equal(workspace.business.get(car.id).archived, true)
    assert.equal((await select(b.id)).status, 200)
  } finally { await context.close() }
})

test('an aborted asynchronous upload must settle before the same session can switch workspaces', { timeout: 20000 }, async () => {
  const context = await fixture(), { client, request, select } = context
  let release!: () => void
  try {
    await context.register(); const a = await context.team('upload-a'), car = await context.vehicle(), b = await context.team('upload-b')
    await select(a.id)
    const workspace = client.workspaces.get(a.id), originalBlob = workspace.business.blob.bind(workspace.business)
    let entered!: () => void, closed!: () => void
    const started = new Promise<void>(resolve => { entered = resolve }), barrier = new Promise<void>(resolve => { release = resolve }), responseClosed = new Promise<void>(resolve => { closed = resolve })
    context.server.on('request', (incoming, response) => { if (incoming.url?.endsWith('/attachments')) response.once('close', closed) })
    workspace.business.blob = async bytes => { entered(); await barrier; return originalBlob(bytes) }
    const controller = new AbortController()
    const uploadRequest = request(`/business/vehicles/${car.id}/attachments`, { method: 'POST', body: upload(Buffer.from('%PDF-1.4 test original'), 'aborted.pdf'), signal: controller.signal }).then(() => 'completed', () => 'aborted')
    await started; controller.abort(); assert.equal(await uploadRequest, 'aborted'); await responseClosed
    let selected = false
    const switching = request('/workspaces/select', { method: 'POST', body: { teamId: b.id, retainPending: true }, settle: false }).then(result => { selected = true; return result })
    await new Promise(resolve => setTimeout(resolve, 25))
    assert.equal(selected, false, 'Switch must await the admitted write after its HTTP connection closed')
    release(); assert.equal((await switching).status, 200)
    workspace.business.blob = originalBlob
    assert.equal((await request('/status')).data.teamId, b.id)
    assert.equal(workspace.business.list('attachment', car.id).length, 1)
    assert.equal(client.workspaces.get(b.id).business.list('attachment').length, 0)
  } finally { release?.(); await context.close() }
})

for (const { outcome, route } of [{ outcome: 'switch', route: '/business/records' }, { outcome: 'shutdown', route: '/business/records' }, { outcome: 'shutdown', route: '/status' }]) {
  test(`an aborted ${route} access read must settle before workspace ${outcome}`, { timeout: 20000 }, async () => {
    const context = await fixture(), { client, request, select } = context
    let release!: () => void
    try {
      await context.register(); const a = await context.team(`access-a-${outcome}`), b = await context.team(`access-b-${outcome}`)
      await select(a.id)
      const workspace = client.workspaces.get(a.id), originalRead = workspace.teams.read.bind(workspace.teams)
      let entered!: () => void, closed!: () => void, held = false
      const started = new Promise<void>(resolve => { entered = resolve }), barrier = new Promise<void>(resolve => { release = resolve }), responseClosed = new Promise<void>(resolve => { closed = resolve })
      workspace.teams.read = async (...args) => { if (!held) { held = true; entered(); await barrier }; return originalRead(...args) }
      // Express can temporarily strip its mount prefix before this listener runs.
      context.server.on('request', (incoming, response) => { if (incoming.url?.endsWith(route.slice(route.lastIndexOf('/')))) response.once('close', closed) })
      const controller = new AbortController()
      const reading = request(route, { signal: controller.signal }).then(() => 'completed', () => 'aborted')
      await started; controller.abort(); assert.equal(await reading, 'aborted'); await responseClosed
      let finished = false
      if (outcome === 'switch') {
        const switching = request('/workspaces/select', { method: 'POST', body: { teamId: b.id, retainPending: true }, settle: false }).then(result => { finished = true; return result })
        await new Promise(resolve => setTimeout(resolve, 25))
        assert.equal(finished, false, 'Selection must drain cache-bearing access before changing workspace')
        release(); assert.equal((await switching).status, 200)
        assert.equal((await request('/status')).data.teamId, b.id)
      } else {
        await context.closeServer()
        const closing = client.close().then(() => { finished = true })
        await new Promise(resolve => setTimeout(resolve, 25))
        assert.equal(finished, false, 'Closing must not race an admitted access read that will update the cache')
        assert.equal(workspace.store.db.prepare('SELECT 1 AS open').get()!.open, 1)
        release(); await closing
      }
    } finally { release?.(); await context.close() }
  })
}

for (const operation of ['preview', 'delete', 'restore']) {
  test(`aborted ${operation} secondary admin access must drain its read and maintenance before shutdown`, { timeout: 20000 }, async () => {
    const context = await fixture(), { client, request } = context
    let releaseRead!: () => void, releaseMaintenance!: () => void
    try {
      await context.register(); const a = await context.team(`secondary-${operation}`), car = await context.vehicle()
      assert.equal((await request(`/business/records/${car.id}/archive`, { method: 'POST', body: { version: car.version, archived: true, reason: 'Archive secondary access target' } })).status, 200)
      const workspace = client.workspaces.get(a.id)
      const preview = (await request(`/business/vehicles/${car.id}/delete-preview`)).data as VehicleDeletePreview
      const backup = (await request('/business/backup')).data as Buffer
      const restorePreview = operation === 'restore' ? (await request('/business/restore/preview', { method: 'POST', body: upload(backup, 'secondary.zip') })).data : null
      const path = operation === 'restore' ? '/business/restore' : `/business/vehicles/${car.id}${operation === 'preview' ? '/delete-preview' : ''}`
      const body = operation === 'restore' ? upload(backup, 'secondary.zip', true) : operation === 'delete' ? { previewToken: preview.token, version: preview.version, vin, confirmation: 'DELETE', reason: 'Finish admitted deletion after disconnect', requestId: randomUUID() } : undefined
      if (operation === 'restore') { body!.append('previewFingerprint', restorePreview.fingerprint); body!.append('archiveRecordIds', JSON.stringify([])) }
      const method = operation === 'restore' ? 'POST' : operation === 'delete' ? 'DELETE' : 'GET'
      let entered!: () => void, closed!: () => void, maintenanceEntered!: () => void, reads = 0
      const started = new Promise<void>(resolve => { entered = resolve }), readBarrier = new Promise<void>(resolve => { releaseRead = resolve })
      const responseClosed = new Promise<void>(resolve => { closed = resolve }), maintenanceStarted = new Promise<void>(resolve => { maintenanceEntered = resolve }), maintenanceBarrier = new Promise<void>(resolve => { releaseMaintenance = resolve })
      const originalRead = workspace.teams.read.bind(workspace.teams), originalMaintenance = workspace.store.withMaintenance.bind(workspace.store)
      workspace.teams.read = async (...args) => { if (++reads === 2) { entered(); await readBarrier }; return originalRead(...args) }
      workspace.store.withMaintenance = work => originalMaintenance(async () => { maintenanceEntered(); await maintenanceBarrier; return await work() })
      context.server.on('request', (incoming, response) => { if (incoming.url?.endsWith(path.slice(path.lastIndexOf('/')))) response.once('close', closed) })
      const controller = new AbortController()
      const ongoing = request(path, { method, body, signal: controller.signal }).then(() => 'completed', () => 'aborted')
      await started; assert.equal(reads, 2); controller.abort(); assert.equal(await ongoing, 'aborted'); await responseClosed
      await context.closeServer()
      let finished = false
      const closing = client.close().then(() => { finished = true })
      await new Promise(resolve => setTimeout(resolve, 25))
      assert.equal(finished, false, 'Shutdown must drain secondary access before the maintenance lease exists')
      releaseRead(); await maintenanceStarted
      assert.equal(finished, false, 'Shutdown must then drain the admitted maintenance workflow')
      assert.equal(workspace.store.db.prepare('SELECT 1 AS open').get()!.open, 1)
      releaseMaintenance(); await closing
      const head = JSON.parse(await fs.readFile(`${a.shared}/business/HEAD.json`, 'utf8'))
      const snapshot = new DatabaseSync(`${a.shared}/business/snapshots/${head.revision}.sqlite`, { readOnly: true })
      try {
        assert.equal(snapshot.prepare('PRAGMA integrity_check').get()!.integrity_check, 'ok')
        assert.equal(snapshot.prepare('SELECT COUNT(*) AS total FROM records WHERE id=?').get(car.id)!.total, operation === 'delete' ? 0 : 1)
        if (operation === 'delete') assert.equal(head.protocol, 2)
      } finally { snapshot.close() }
    } finally { releaseRead?.(); releaseMaintenance?.(); await context.close() }
  })
}

test('workspace close is idempotent and drains active ticks, writes and maintenance before closing all databases', { timeout: 20000 }, async () => {
  const context = await fixture(), { client, request, select } = context
  let releaseTick!: () => void, releaseWrite!: () => void, releaseMaintenance!: () => void
  try {
    await context.register(); const a = await context.team('close-a'), b = await context.team('close-b')
    await request('/login', { method: 'POST', session: 'second', body: { username: 'workspace-delete-owner', password: 'workspace-deletion-test-password' } })
    await select(a.id)
    const workspaceA = client.workspaces.get(a.id), workspaceB = client.workspaces.get(b.id)
    let tickEntered!: () => void, writeEntered!: () => void, maintenanceEntered!: () => void
    const tickStarted = new Promise<void>(resolve => { tickEntered = resolve }), tickBarrier = new Promise<void>(resolve => { releaseTick = resolve })
    const writeStarted = new Promise<void>(resolve => { writeEntered = resolve }), writeBarrier = new Promise<void>(resolve => { releaseWrite = resolve })
    const maintenanceStarted = new Promise<void>(resolve => { maintenanceEntered = resolve }), maintenanceBarrier = new Promise<void>(resolve => { releaseMaintenance = resolve })
    workspaceA.tick = async () => { tickEntered(); await tickBarrier; workspaceA.store.set('closeTickFinished', true) }
    workspaceB.tick = async () => { tickEntered(); await tickBarrier; workspaceB.store.set('closeTickFinished', true) }
    const tick = client.tick(); await tickStarted
    const write = workspaceB.store.runWrite(async () => { writeEntered(); await writeBarrier; workspaceB.store.set('closeWriteFinished', true) })
    await writeStarted
    const maintenance = workspaceB.store.withMaintenance(async () => { maintenanceEntered(); await maintenanceBarrier; workspaceB.store.set('closeMaintenanceFinished', true) })
    const closeCounts = new Map<unknown, number>()
    for (const store of new Set([client.store, workspaceA.store, workspaceB.store])) {
      const close = store.db.close.bind(store.db)
      store.db.close = () => { closeCounts.set(store, (closeCounts.get(store) || 0) + 1); close() }
    }
    await context.closeServer()
    let finished = false
    const closing = client.close(), repeated = client.close()
    assert.equal(closing, repeated)
    const done = closing.then(() => { finished = true })
    assert.throws(() => client.workspaces.get(a.id), { code: 'MAINTENANCE_IN_PROGRESS' })
    await client.tick(); assert.equal(closeCounts.size, 0); assert.equal(finished, false)
    releaseTick(); await tick
    releaseWrite(); await write; await maintenanceStarted
    assert.equal(closeCounts.size, 0); assert.equal(finished, false)
    releaseMaintenance(); await maintenance; await done
    assert.equal(closeCounts.size, 2)
    for (const count of closeCounts.values()) assert.equal(count, 1)
    await client.close(); await client.tick()
    assert.equal(closeCounts.size, 2)
  } finally { releaseTick?.(); releaseWrite?.(); releaseMaintenance?.(); await context.close() }
})
