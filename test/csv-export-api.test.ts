import { test } from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ZipArchive } from 'archiver'
import unzipper from 'unzipper'
import { createApp } from '../server/app.js'
import { defaultExportConfiguration, exportColumns, MAX_EXPORT_ID_LENGTH, MAX_EXPORT_VEHICLES } from '../shared/csv-export.js'
import type { Actor, BusinessRecord, Fields, VehicleDeletePreview } from '../shared/business.js'

const password = 'csv-export-test-password', vin = 'TEST0000000000001'
type Credentials = { cookie: string; token: string }
async function fixture() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'vehicle-csv-api-'))
  let client = createApp({ dataDir: path.join(directory, 'local') }), server = client.app.listen(0, '127.0.0.1'), serverClosed = false
  if (!server.listening) await once(server, 'listening')
  const sessions = new Map<string, Credentials>()
  async function request(route: string, { method = 'GET', body, session = 'owner', token, signal, settle = true }: { method?: string; body?: unknown; session?: string; token?: string; signal?: AbortSignal; settle?: boolean } = {}) {
    const credentials = sessions.get(session) || { cookie: '', token: '' }
    const response = await fetch(`http://127.0.0.1:${(server.address() as { port: number }).port}/api${route}`, { method, signal, headers: { Cookie: credentials.cookie, 'X-App-Request': 'vehicle-manager', 'X-Workspace-Token': token ?? credentials.token, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) })
    const cookie = response.headers.get('set-cookie'); if (cookie) credentials.cookie = cookie.split(';')[0]
    if (response.ok) credentials.token = response.headers.get('x-workspace-token') || credentials.token
    sessions.set(session, credentials)
    const data = response.headers.get('content-type')?.includes('json') ? await response.json() : Buffer.from(await response.arrayBuffer())
    if (settle) await client.synchronization.settle()
    return { status: response.status, data, headers: response.headers }
  }
  async function register(session = 'owner') {
    const result = await request('/register', { method: 'POST', session, body: { username: `csv-${session}`, displayName: session, password } })
    assert.equal(result.status, 201, JSON.stringify(result.data)); return result.data as { id: string }
  }
  async function team(name = 'CSV test', session = 'owner') {
    const shared = path.join(directory, name); await fs.mkdir(shared)
    const result = await request('/setup/configure', { method: 'POST', session, body: { path: shared, mode: 'create', teamName: name, confirmed: true, retainPending: true } })
    assert.equal(result.status, 200, JSON.stringify(result.data))
    return { id: result.data.teamId as string, shared }
  }
  const select = (id: string, session = 'owner') => request('/workspaces/select', { method: 'POST', session, body: { teamId: id, retainPending: true } })
  async function vehicle(session = 'owner', data: Fields = {}) {
    const result = await request('/business/records', { method: 'POST', session, body: { kind: 'vehicle', data: { vin, status: 'available', project: 'Project A', model: 'Model A', owner: 'Ada', physicalLocation: 'Workshop A', thermal: 'Indirect Heat Pump', ...data }, reason: 'Register CSV test vehicle' } })
    assert.equal(result.status, 201, JSON.stringify(result.data)); return result.data as BusinessRecord
  }
  async function closeServer() { if (!serverClosed) { serverClosed = true; await new Promise<void>(resolve => server.close(() => resolve())) } }
  async function reopen() {
    await closeServer(); await client.close()
    client = createApp({ dataDir: path.join(directory, 'local') }); server = client.app.listen(0, '127.0.0.1'); serverClosed = false
    if (!server.listening) await once(server, 'listening')
  }
  async function close() { await closeServer(); await client.close(); await fs.rm(directory, { recursive: true, force: true }) }
  return { get client() { return client }, get server() { return server }, directory, sessions, request, register, team, select, vehicle, closeServer, reopen, close }
}
const csvRequest = (vehicleIds: string[], configuration = defaultExportConfiguration('en')) => ({ vehicleIds, configuration })
async function csvFiles(bytes: Buffer) {
  const archive = await unzipper.Open.buffer(bytes), files: Record<string, Buffer> = {}
  for (const file of archive.files) files[file.path] = await file.buffer()
  return files
}
function actorFor(workspace: ReturnType<ReturnType<typeof createApp>['workspaces']['get']>): Actor {
  const member = workspace.store.get<{ members: { id: string; name: string; role: 'admin' | 'member' }[] }>('cachedTeam')!.members[0]
  return { ...member, deviceId: workspace.store.deviceId }
}

test('CSV HTTP export honors selected categories/columns and archives, and preserves the existing JSON export', async () => {
  const context = await fixture(), { request } = context
  try {
    await context.register(); const team = await context.team(), car = await context.vehicle('owner', { name: '中文, "Vehicle"\nLine two', notes: '=HYPERLINK("malicious")' })
    const workspace = context.client.workspaces.get(team.id), actor = actorFor(workspace)
    for (const kind of ['part', 'modification', 'equipment'] as const) workspace.business.write({ kind, vehicleId: car.id, data: { name: `${kind} child`, ...(kind === 'part' ? { category: 'controller', serial: '000123' } : {}) }, actor, reason: 'Create linked CSV fixture' })
    workspace.business.write({ kind: 'report', vehicleId: car.id, data: { name: 'Summary.xlsx', checksum: 'a'.repeat(64), size: 0, recordedAt: '2026-10-23', savedAt: '2026-10-23T08:00:00.000Z', parserVersion: '1', parsed: { vin, recordedAt: '2026-10-23', software: '001.02', mileage: 0, soc: 0, vehicleMode: '0007', controllers: [{ name: 'SENSITIVE ECU DETAIL' }], faults: [{ code: 'SENSITIVE FAULT DETAIL' }] }, vehicleSnapshot: { notes: 'SENSITIVE OLD SNAPSHOT' } }, actor, reason: 'Create report summary', internal: true })
    workspace.business.write({ kind: 'attachment', vehicleId: car.id, data: { name: 'metadata.pdf', checksum: 'b'.repeat(64), size: 0, savedAt: '2026-10-23T08:00:00.000Z' }, actor, reason: 'Create attachment metadata', internal: true })
    const configuration = defaultExportConfiguration('en')
    configuration.columns = Object.fromEntries(Object.entries(exportColumns).map(([kind, columns]) => [kind, columns.map(column => column.id)]))
    const exported = await request('/business/export/csv', { method: 'POST', body: csvRequest([car.id], configuration) })
    assert.equal(exported.status, 200, JSON.stringify(exported.data)); assert.match(exported.headers.get('content-type')!, /application\/zip/)
    assert.match(exported.headers.get('content-disposition')!, /\.zip/)
    const files = await csvFiles(exported.data as Buffer)
    assert.deepEqual(Object.keys(files).sort(), ['attachments.csv', 'equipment.csv', 'modifications.csv', 'parts-controllers.csv', 'report-summaries.csv', 'vehicles.csv'])
    for (const [name, bytes] of Object.entries(files)) { assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf], name); assert.ok(bytes.toString().endsWith('\r\n'), name) }
    assert.match(files['vehicles.csv'].toString(), /中文, ""Vehicle""\nLine two/)
    assert.match(files['vehicles.csv'].toString(), /'=HYPERLINK/)
    assert.match(files['parts-controllers.csv'].toString(), /000123/)
    assert.match(files['report-summaries.csv'].toString(), /001\.02/)
    assert.doesNotMatch(Buffer.concat(Object.values(files)).toString(), /SENSITIVE ECU DETAIL|SENSITIVE FAULT DETAIL|SENSITIVE OLD SNAPSHOT/)
    const audit = workspace.store.db.prepare("SELECT detail FROM local_events WHERE action='business.exported' ORDER BY rowid DESC LIMIT 1").get()!
    assert.equal(JSON.parse(audit.detail as string).format, 'csv')
    assert.deepEqual(JSON.parse(audit.detail as string).counts, { vehicle: 1, part: 1, modification: 1, equipment: 1, report: 1, attachment: 1 })
    configuration.columns = { vehicle: ['thermal', 'vin', 'physicalLocation'], equipment: ['name'] }
    configuration.language = 'zh'
    const reordered = await request('/business/export/csv', { method: 'POST', body: csvRequest([car.id], configuration) }), orderedFiles = await csvFiles(reordered.data as Buffer)
    assert.equal(reordered.status, 200)
    assert.deepEqual(Object.keys(orderedFiles).sort(), ['equipment.csv', 'vehicles.csv'])
    const expectedHeaders = configuration.columns.vehicle!.map(id => exportColumns.vehicle.find(column => column.id === id)!.label[1])
    assert.equal(orderedFiles['vehicles.csv'].toString().replace(/^\uFEFF/, '').split('\r\n')[0], expectedHeaders.join(','))
    const existing = await request('/business/export')
    assert.equal(existing.status, 200); assert.ok(Array.isArray(existing.data.records)); assert.equal(typeof existing.data.exportedAt, 'string')
    assert.match(existing.headers.get('content-disposition')!, /vehicle-data\.json/)
    const archived = workspace.business.write({ kind: 'equipment', vehicleId: car.id, data: { name: 'Archived child' }, actor, reason: 'Seed archived child', archived: true })
    const ordinary = await request('/business/export/csv', { method: 'POST', body: csvRequest([car.id], configuration) })
    assert.doesNotMatch((await csvFiles(ordinary.data as Buffer))['equipment.csv'].toString(), /Archived child/)
    configuration.includeArchived = true
    assert.match((await csvFiles((await request('/business/export/csv', { method: 'POST', body: csvRequest([car.id], configuration) })).data as Buffer))['equipment.csv'].toString(), /Archived child/)
    assert.equal(workspace.business.get(archived.id).archived, true)
  } finally { await context.close() }
})

test('CSV and template endpoints strictly reject malformed configuration, unknown columns and raw payloads', async () => {
  const context = await fixture(), { request } = context
  try {
    await context.register(); await context.team(); const car = await context.vehicle(), configuration = defaultExportConfiguration('en')
    const invalid: unknown[] = [[], null, {}, { vehicleIds: [], configuration }, { vehicleIds: [car.id, car.id], configuration }, { vehicleIds: [car.id], configuration, records: [] }, { vehicleIds: [car.id], configuration: { ...configuration, version: 2 } }, { vehicleIds: [car.id], configuration: { ...configuration, columns: {} } }, { vehicleIds: [car.id], configuration: { ...configuration, columns: { vehicle: [] } } }, { vehicleIds: [car.id], configuration: { ...configuration, columns: { vehicle: ['vin', 'vin'] } } }, { vehicleIds: [car.id], configuration: { ...configuration, columns: { vehicle: ['__proto__'] } } }, { vehicleIds: [car.id], configuration: { ...configuration, columns: { report: ['parsed.controllers'] } } }, { vehicleIds: [car.id], configuration: { ...configuration, filters: { ...configuration.filters, arbitrary: [] } } }, { vehicleIds: [car.id], configuration: { ...configuration, vehicleIds: [car.id] } }, { vehicleIds: [car.id], configuration: { ...configuration, includeArchived: 'yes' } }, { vehicleIds: [car.id], configuration: { ...configuration, language: 'fr' } }]
    for (const body of invalid) {
      const result = await request('/business/export/csv', { method: 'POST', body })
      assert.equal(result.status, 400, JSON.stringify(body)); assert.equal(result.data.error, 'INVALID_INPUT')
    }
    for (const body of [[], {}, { name: '', configuration }, { name: 'x'.repeat(101), configuration }, { name: 'Invalid', configuration, vehicleIds: [car.id] }, { name: 'Invalid', configuration: { ...configuration, columns: { vehicle: ['notes; DROP TABLE records'] } } }]) {
      const result = await request('/business/export-templates', { method: 'POST', body }); assert.equal(result.status, 400, JSON.stringify(body)); assert.equal(result.data.error, 'INVALID_INPUT')
    }
    assert.deepEqual((await request('/business/export-templates')).data, [])
    assert.equal((await request('/business/export/csv', { method: 'POST', body: csvRequest([randomUUID()], configuration) })).data.error, 'EXPORT_SELECTION_CHANGED')
    const mismatched = structuredClone(configuration); mismatched.filters.project = ['Not the selected project']
    assert.equal((await request('/business/export/csv', { method: 'POST', body: csvRequest([car.id], mismatched) })).status, 409)
  } finally { await context.close() }
})

test('CSV accepts selections across thousands of vehicles beyond the ordinary JSON body limit', { timeout: 30000 }, async () => {
  const context = await fixture(), { request } = context
  try {
    await context.register(); const team = await context.team(), workspace = context.client.workspaces.get(team.id)
    const vehicleIds = Array.from({ length: 4000 }, () => randomUUID()), configuration = defaultExportConfiguration('en')
    configuration.columns = { vehicle: ['id', 'vin'] }
    const body = csvRequest(vehicleIds, configuration)
    assert.ok(Buffer.byteLength(JSON.stringify(body)) > 128 * 1024, 'This fixture must exceed the default API JSON limit')
    const missing = await request('/business/export/csv', { method: 'POST', body })
    assert.equal(missing.status, 409, JSON.stringify(missing.data)); assert.equal(missing.data.error, 'EXPORT_SELECTION_CHANGED')
    const insert = workspace.store.db.prepare('INSERT INTO records VALUES(?,?,?,?,?,?,?,?)'), updated = new Date().toISOString()
    workspace.store.transaction(() => {
      vehicleIds.forEach((id, index) => {
        const recordVin = 'TEST' + String(index + 1).padStart(13, '0')
        insert.run(id, 'vehicle', null, recordVin, JSON.stringify({ vin: recordVin, status: 'available' }), 0, 1, updated)
      })
    })
    const exported = await request('/business/export/csv', { method: 'POST', body })
    assert.equal(exported.status, 200, JSON.stringify(exported.data))
    const files = await csvFiles(exported.data as Buffer), lines = files['vehicles.csv'].toString().replace(/^\uFEFF/, '').trimEnd().split('\r\n')
    assert.equal(lines.length, vehicleIds.length + 1)
    const exportedIds = new Set(lines.slice(1).map(line => line.split(',')[0]))
    assert.equal(exportedIds.size, vehicleIds.length)
    for (const id of vehicleIds) assert.ok(exportedIds.has(id), 'Every selected vehicle must appear regardless of UI pagination')
    assert.equal(workspace.synchronization.status().pending, 0)
    await assert.rejects(fs.access(path.join(team.shared, 'business', 'HEAD.json')), { code: 'ENOENT' }, 'A local CSV must not create a shared business revision')
    const tooMany = await request('/business/export/csv', { method: 'POST', body: csvRequest(Array.from({ length: MAX_EXPORT_VEHICLES + 1 }, () => randomUUID()), configuration) })
    assert.equal(tooMany.status, 400); assert.equal(tooMany.data.error, 'INVALID_INPUT')
    const longId = await request('/business/export/csv', { method: 'POST', body: csvRequest(['x'.repeat(MAX_EXPORT_ID_LENGTH + 1)], configuration) })
    assert.equal(longId.status, 400); assert.equal(longId.data.error, 'INVALID_INPUT')
  } finally { await context.close() }
})

test('oversized CSV and personal-template requests fail with a clear export-size error', { timeout: 30000 }, async () => {
  const context = await fixture(), { request } = context
  try {
    await context.register(); await context.team(); const car = await context.vehicle(), configuration = defaultExportConfiguration('en')
    const saved = await request('/business/export-templates', { method: 'POST', body: { name: 'Retained template', configuration } })
    assert.equal(saved.status, 201)
    const oversized = structuredClone(configuration); oversized.filters.search = 'x'.repeat(5 * 1024 * 1024)
    for (const [route, method, body] of [['/business/export/csv', 'POST', csvRequest([car.id], oversized)], ['/business/export-templates', 'POST', { name: 'Oversized template', configuration: oversized }], [`/business/export-templates/${saved.data.id}`, 'PUT', { configuration: oversized }]] as const) {
      const response = await request(route, { method, body })
      assert.equal(response.status, 413, route); assert.equal(response.data.error, 'EXPORT_TOO_LARGE')
    }
    const templates = (await request('/business/export-templates')).data
    assert.equal(templates.length, 1); assert.deepEqual(templates[0].configuration, configuration, 'Rejected updates must preserve the original template')
  } finally { await context.close() }
})

test('personal templates support save, copy, rename, update, delete and restart without storing vehicle selections', async () => {
  const context = await fixture(), { request } = context
  try {
    await context.register(); const team = await context.team(); const car = await context.vehicle(), configuration = defaultExportConfiguration('en')
    configuration.filters.project = ['Project A']; configuration.columns = { vehicle: ['vin', 'name'] }
    const created = await request('/business/export-templates', { method: 'POST', body: { name: '  My selection  ', configuration } })
    assert.equal(created.status, 201); assert.equal(created.data.name, 'My selection'); assert.ok(created.data.id); assert.ok(created.data.updated)
    assert.deepEqual(created.data.configuration, configuration); assert.equal(JSON.stringify(created.data).includes(car.id), false)
    assert.equal((await request('/business/export-templates', { method: 'POST', body: { name: 'my selection', configuration } })).data.error, 'EXPORT_TEMPLATE_EXISTS')
    const copied = await request('/business/export-templates', { method: 'POST', body: { name: 'Copy', configuration } }); assert.equal(copied.status, 201); assert.notEqual(copied.data.id, created.data.id)
    assert.equal((await request(`/business/export-templates/${created.data.id}`, { method: 'PUT', body: { name: 'Renamed selection' } })).data.name, 'Renamed selection')
    const revised = structuredClone(configuration); revised.language = 'zh'; revised.columns = { vehicle: ['physicalLocation', 'vin'], equipment: ['name'] }; revised.includeArchived = true
    assert.deepEqual((await request(`/business/export-templates/${created.data.id}`, { method: 'PUT', body: { configuration: revised } })).data.configuration, revised)
    assert.equal((await request(`/business/export-templates/${created.data.id}`, { method: 'PUT', body: { name: 'Copy' } })).data.error, 'EXPORT_TEMPLATE_EXISTS')
    assert.equal((await request(`/business/export-templates/${created.data.id}`, { method: 'PUT', body: { vehicleIds: [car.id] } })).status, 400)
    await context.reopen()
    const templates = (await request('/business/export-templates')).data
    assert.equal(templates.length, 2); assert.deepEqual(templates.find((item: { id: string }) => item.id === created.data.id).configuration, revised)
    const next = await context.vehicle('owner', { vin: 'TEST0000000000002', name: 'New matching vehicle' })
    assert.equal((await request('/business/export/csv', { method: 'POST', body: csvRequest([car.id, next.id], revised) })).status, 200, 'A saved filter must apply to current matching identities, not an old vehicle ID list')
    const backup = await request('/business/backup'), archive = await unzipper.Open.buffer(backup.data as Buffer)
    const manifest = JSON.parse((await archive.files.find(file => file.path === 'manifest.json')!.buffer()).toString())
    assert.equal(manifest.format, 2)
    assert.doesNotMatch(JSON.stringify(manifest), /Renamed selection|My selection|csvExportTemplates/)
    assert.equal(context.client.workspaces.get(team.id).store.db.prepare('PRAGMA user_version').get()!.user_version, 4)
    assert.deepEqual((await request(`/business/export-templates/${copied.data.id}`, { method: 'DELETE' })).data, { ok: true })
    assert.equal((await request(`/business/export-templates/${copied.data.id}`, { method: 'DELETE' })).data.error, 'EXPORT_TEMPLATE_NOT_FOUND')
    assert.equal((await request(`/business/export-templates/${randomUUID()}`, { method: 'PUT', body: { name: 'Missing' } })).status, 404)
    assert.equal((await request('/business/export-templates')).data.length, 1)
  } finally { await context.close() }
})

test('lowercase and mixed-case CSV/template routes never synchronize pending work, including while paused or offline', async () => {
  const context = await fixture(), { request } = context
  try {
    await context.register(); const team = await context.team(), car = await context.vehicle(), workspace = context.client.workspaces.get(team.id), configuration = defaultExportConfiguration('en')
    workspace.business.write({ id: car.id, kind: 'vehicle', data: { ...car.data, notes: 'Unpublished local edit' }, version: workspace.business.get(car.id).version, actor: actorFor(workspace), reason: 'Retain unsynchronized work' })
    const beforeQueue = workspace.store.db.prepare('SELECT * FROM outbox ORDER BY seq').all(), headPath = path.join(team.shared, 'business', 'HEAD.json'), beforeHead = await fs.readFile(headPath, 'utf8')
    assert.ok(workspace.synchronization.status().pending > 0)
    const originalSync = workspace.synchronization.synchronize.bind(workspace.synchronization); let synchronizations = 0
    workspace.synchronization.synchronize = async (...args) => { synchronizations++; return originalSync(...args) }
    for (const mode of ['online', 'paused', 'offline']) {
      if (mode === 'paused') context.client.store.db.prepare('UPDATE sessions SET sync_enabled=0').run()
      if (mode === 'offline') await fs.rename(team.shared, team.shared + '-offline')
      try {
        for (const pathCase of ['lowercase', 'mixed-case']) {
          const templatesPath = pathCase === 'lowercase' ? '/business/export-templates' : '/business/Export-Templates'
          const recordsPath = pathCase === 'lowercase' ? '/business/export/records' : '/business/Export/Records'
          const csvPath = pathCase === 'lowercase' ? '/business/export/csv' : '/business/Export/CSV'
          const records = await request(recordsPath); assert.equal(records.status, 200); assert.equal(records.data.find((item: BusinessRecord) => item.id === car.id).data.notes, 'Unpublished local edit')
          assert.equal((await request(templatesPath)).status, 200)
          const saved = await request(templatesPath, { method: 'POST', body: { name: `Selection ${mode} ${pathCase}`, configuration } }); assert.equal(saved.status, 201)
          assert.equal((await request(`${templatesPath}/${saved.data.id}`, { method: 'PUT', body: { name: `Changed ${mode} ${pathCase}` } })).status, 200)
          const exported = await request(csvPath, { method: 'POST', body: csvRequest([car.id]) }); assert.equal(exported.status, 200, JSON.stringify(exported.data))
          assert.match((await csvFiles(exported.data as Buffer))['vehicles.csv'].toString(), /Unpublished local edit/)
          assert.equal((await request(`${templatesPath}/${saved.data.id}`, { method: 'DELETE' })).status, 200)
          assert.deepEqual(workspace.store.db.prepare('SELECT * FROM outbox ORDER BY seq').all(), beforeQueue)
          assert.equal(synchronizations, 0, `Export/template operations must not invoke sync (${mode}, ${pathCase})`)
        }
      } finally { if (mode === 'offline') await fs.rename(team.shared + '-offline', team.shared) }
      assert.equal(await fs.readFile(headPath, 'utf8'), beforeHead)
    }
    assert.equal((await request('/status')).data.syncPaused, true)
    workspace.synchronization.synchronize = originalSync
  } finally { await context.close() }
})

test('CSV and personal templates enforce approved access, account/workspace privacy and stale-session tokens', async () => {
  const context = await fixture(), { request } = context
  try {
    assert.equal((await request('/business/export-templates', { session: 'anonymous' })).status, 401)
    await context.register(); const a = await context.team('Privacy A'), carA = await context.vehicle(), configuration = defaultExportConfiguration('en')
    const personal = (await request('/business/export-templates', { method: 'POST', body: { name: 'Owner A only', configuration } })).data
    const oldToken = context.sessions.get('owner')!.token
    await context.team('Privacy B'); const carB = await context.vehicle('owner', { physicalLocation: 'Workspace B' })
    assert.deepEqual((await request('/business/export-templates')).data, [])
    assert.equal((await request(`/business/export-templates/${personal.id}`, { method: 'PUT', body: { name: 'Steal across teams' } })).status, 404)
    assert.equal((await request('/business/export/csv', { method: 'POST', body: csvRequest([carA.id]) })).data.error, 'EXPORT_SELECTION_CHANGED')
    assert.equal((await request('/business/export-templates', { token: oldToken })).data.error, 'WORKSPACE_CHANGED')
    assert.equal((await request('/business/export/csv', { method: 'POST', token: oldToken, body: csvRequest([carB.id]) })).data.error, 'WORKSPACE_CHANGED')
    assert.equal((await request('/business/export/csv', { method: 'POST', body: csvRequest([carB.id]) })).status, 200)
    await context.select(a.id); assert.equal((await request('/business/export-templates')).data[0].id, personal.id)
    await context.register('member')
    assert.equal((await request('/setup/configure', { method: 'POST', session: 'member', body: { path: a.shared, mode: 'join', teamId: a.id } })).status, 200)
    assert.equal((await request('/business/export-templates', { session: 'member' })).status, 403)
    const roster = (await request('/team')).data, applicant = roster.requests.find((item: { status: string }) => item.status === 'pending')
    assert.equal((await request(`/team/requests/${applicant.id}/approve`, { method: 'POST', body: { role: 'member', memberId: null, reason: 'Approve CSV member' } })).status, 200)
    assert.deepEqual((await request('/business/export-templates', { session: 'member' })).data, [])
    assert.equal((await request(`/business/export-templates/${personal.id}`, { method: 'DELETE', session: 'member' })).status, 404)
    assert.equal((await request('/business/export-templates', { method: 'POST', session: 'member', body: { name: 'Member only', configuration } })).status, 201)
    assert.equal((await request('/business/export/csv', { method: 'POST', session: 'member', body: csvRequest([carA.id]) })).status, 200)
    assert.equal((await request('/business/export-templates')).data.length, 1)
    const approved = (await request('/status', { session: 'member' })).data.member
    assert.equal((await request(`/team/members/${approved.id}`, { method: 'POST', body: { role: 'member', enabled: false, reason: 'Revoke CSV access' } })).status, 200)
    for (const [route, method, body] of [['/business/export-templates', 'GET', undefined], ['/business/export-templates', 'POST', { name: 'Denied', configuration }], ['/business/export/csv', 'POST', csvRequest([carA.id])]] as const) {
      const denied = await request(route, { method, body, session: 'member' }); assert.equal(denied.status, 403); assert.equal(denied.data.error, 'ACCESS_DISABLED')
    }
    const savedToken = context.sessions.get('owner')!.token
    await request('/login', { method: 'POST', body: { username: 'csv-owner', password } })
    assert.equal((await request('/business/export-templates', { token: savedToken })).data.error, 'WORKSPACE_CHANGED')
  } finally { await context.close() }
})

test('a deleted export selection never silently targets a re-registered VIN or exports deleted children', async () => {
  const context = await fixture(), { request } = context
  try {
    await context.register(); await context.team(); const car = await context.vehicle()
    assert.equal((await request(`/business/records/${car.id}/archive`, { method: 'POST', body: { archived: true, version: car.version, reason: 'Archive CSV target' } })).status, 200)
    const preview = (await request(`/business/vehicles/${car.id}/delete-preview`)).data as VehicleDeletePreview
    assert.equal((await request(`/business/vehicles/${car.id}`, { method: 'DELETE', body: { previewToken: preview.token, version: preview.version, vin, confirmation: 'DELETE', reason: 'Delete CSV target', requestId: randomUUID() } })).status, 200)
    const replacement = await context.vehicle('owner', { name: 'New identity, same VIN' }); assert.notEqual(replacement.id, car.id)
    const stale = await request('/business/export/csv', { method: 'POST', body: csvRequest([car.id]) }); assert.equal(stale.status, 409); assert.equal(stale.data.error, 'EXPORT_SELECTION_CHANGED')
    const fresh = await request('/business/export/csv', { method: 'POST', body: csvRequest([replacement.id]) }); assert.equal(fresh.status, 200)
    assert.match((await csvFiles(fresh.data as Buffer))['vehicles.csv'].toString(), /New identity, same VIN/)
    assert.deepEqual((await request('/business/export/records')).data.map((item: BusinessRecord) => item.id), [replacement.id])
  } finally { await context.close() }
})

test('CSV export and personal template changes cannot enter during active workspace maintenance', async () => {
  const context = await fixture(), { request } = context; let release!: () => void
  try {
    await context.register(); const team = await context.team(), car = await context.vehicle(), workspace = context.client.workspaces.get(team.id)
    let entered!: () => void; const started = new Promise<void>(resolve => { entered = resolve }), barrier = new Promise<void>(resolve => { release = resolve })
    const maintenance = workspace.store.withMaintenance(async () => { entered(); await barrier })
    await started
    for (const [route, method, body] of [['/business/export-templates', 'GET', undefined], ['/business/export-templates', 'POST', { name: 'Blocked', configuration: defaultExportConfiguration('en') }], ['/business/export/csv', 'POST', csvRequest([car.id])]] as const) {
      const blocked = await request(route, { method, body, settle: false }); assert.equal(blocked.status, 503); assert.equal(blocked.data.error, 'MAINTENANCE_IN_PROGRESS')
    }
    release(); await maintenance
    assert.deepEqual((await request('/business/export-templates')).data, [])
  } finally { release?.(); await context.close() }
})

for (const invalidation of ['logout', 'workspace-epoch', 'learned-deletion', 'project-filter', 'archived'] as const) {
  test(`CSV final publication rechecks ${invalidation} after asynchronous ZIP generation`, { timeout: 20000 }, async () => {
    const context = await fixture(), { request } = context; let release!: () => void
    const originalFinalize = ZipArchive.prototype.finalize
    try {
      await context.register(); const team = await context.team(), car = await context.vehicle(), workspace = context.client.workspaces.get(team.id)
      const auditsBefore = workspace.store.db.prepare("SELECT COUNT(*) AS total FROM local_events WHERE action='business.exported'").get()!.total
      let entered!: () => void
      const started = new Promise<void>(resolve => { entered = resolve }), barrier = new Promise<void>(resolve => { release = resolve })
      ZipArchive.prototype.finalize = function () { entered(); return barrier.then(() => originalFinalize.call(this)) }
      const configuration = defaultExportConfiguration('en')
      if (invalidation === 'project-filter') configuration.filters.project = ['Project A']
      const exporting = request('/business/export/csv', { method: 'POST', body: csvRequest([car.id], configuration) })
      await Promise.race([started, exporting.then(result => { throw new Error(`Export completed with ${result.status} without reaching asynchronous ZIP finalization`) })])
      if (invalidation === 'logout') assert.equal((await request('/logout', { method: 'POST', body: {}, settle: false })).status, 200)
      else if (invalidation === 'workspace-epoch') context.client.store.db.prepare('UPDATE sessions SET workspace_epoch=workspace_epoch+1').run()
      else if (invalidation === 'learned-deletion') workspace.store.rememberDeletions([{ id: randomUUID(), requestId: randomUUID(), vehicleId: car.id, vin, recordIds: [car.id], fileKeys: [], actor: actorFor(workspace), reason: 'Canonical marker learned after CSV snapshot', deletedAt: new Date().toISOString(), revision: randomUUID(), sequence: 1 }])
      else if (invalidation === 'project-filter') assert.equal((await request(`/business/records/${car.id}`, { method: 'PUT', body: { data: { ...car.data, project: 'No longer matching' }, version: car.version, reason: 'Concurrent project change during ZIP generation' }, settle: false })).status, 200)
      else assert.equal((await request(`/business/records/${car.id}/archive`, { method: 'POST', body: { archived: true, version: car.version, reason: 'Concurrent archive during ZIP generation' }, settle: false })).status, 200)
      release(); const blocked = await exporting
      assert.equal(blocked.status, invalidation === 'logout' ? 401 : 409)
      assert.equal(blocked.data.error, invalidation === 'logout' ? 'LOGIN_REQUIRED' : invalidation === 'workspace-epoch' ? 'WORKSPACE_CHANGED' : 'EXPORT_SELECTION_CHANGED')
      assert.match(blocked.headers.get('content-type')!, /application\/json/)
      assert.equal(blocked.headers.get('content-disposition'), null, 'A rejected result must not advertise a download')
      assert.equal(workspace.store.db.prepare("SELECT COUNT(*) AS total FROM local_events WHERE action='business.exported'").get()!.total, auditsBefore, 'Rejected exports must not be logged as successful')
    } finally { release?.(); ZipArchive.prototype.finalize = originalFinalize; await context.close() }
  })
}

for (const outcome of ['switch', 'shutdown'] as const) {
  test(`an aborted ZIP export must finish before workspace ${outcome}`, { timeout: 20000 }, async () => {
    const context = await fixture(), { request } = context; let release!: () => void
    const originalFinalize = ZipArchive.prototype.finalize
    try {
      await context.register(); const a = await context.team('Export drain A'), car = await context.vehicle(), b = await context.team('Export drain B')
      await context.select(a.id)
      let entered!: () => void, closed!: () => void
      const started = new Promise<void>(resolve => { entered = resolve }), barrier = new Promise<void>(resolve => { release = resolve }), responseClosed = new Promise<void>(resolve => { closed = resolve })
      ZipArchive.prototype.finalize = function () { entered(); return barrier.then(() => originalFinalize.call(this)) }
      context.server.on('request', (incoming, response) => { if (incoming.url?.endsWith('/csv')) response.once('close', closed) })
      const controller = new AbortController()
      const exporting = request('/business/export/csv', { method: 'POST', body: csvRequest([car.id]), signal: controller.signal }).then(() => 'completed', () => 'aborted')
      await Promise.race([started, exporting.then(result => { throw new Error(`Export ${result} without reaching asynchronous ZIP finalization`) })])
      controller.abort(); assert.equal(await exporting, 'aborted'); await responseClosed
      let finished = false
      if (outcome === 'switch') {
        const switching = request('/workspaces/select', { method: 'POST', body: { teamId: b.id, retainPending: true }, settle: false }).then(result => { finished = true; return result })
        await new Promise(resolve => setTimeout(resolve, 25)); assert.equal(finished, false, 'Selection must drain the entire asynchronous export after response close')
        release(); assert.equal((await switching).status, 200); assert.equal((await request('/status')).data.teamId, b.id)
      } else {
        const workspace = context.client.workspaces.get(a.id)
        await context.closeServer(); const closing = context.client.close().then(() => { finished = true })
        await new Promise(resolve => setTimeout(resolve, 25)); assert.equal(finished, false, 'Shutdown must not close SQLite while archive creation is in flight')
        assert.equal(workspace.store.db.prepare('SELECT 1 AS alive').get()!.alive, 1)
        release(); await closing
      }
    } finally { release?.(); ZipArchive.prototype.finalize = originalFinalize; await context.close() }
  })
}
