// Actual ZIP-to-ZIP upgrade acceptance. Every account, record and share is synthetic.
import assert from 'node:assert/strict'
import { promises as fs, existsSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { execFile, execFileSync } from 'node:child_process'
import { promisify } from 'node:util'
import { createRequire } from 'node:module'
import { randomUUID, createHash } from 'node:crypto'

assert.equal(process.platform, 'win32')
const execute = promisify(execFile)
const inputs = process.argv.slice(2).map(value => path.resolve(value))
assert.equal(inputs.length, 2, 'Pass the original 1.9.1 ZIP and the new candidate ZIP')
for (const file of inputs) assert((await fs.stat(file)).isFile())
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vehicle-upgrade-acceptance-'))
const data = path.join(root, 'local'), shared = path.join(root, 'shared'), offline = path.join(root, 'offline-share')
const clients = []
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
async function extract(zip, name) {
  const destination = path.join(root, name)
  await fs.mkdir(destination)
  const quote = value => value.replaceAll("'", "''")
  const command = `$ErrorActionPreference='Stop'; Expand-Archive -LiteralPath '${quote(zip)}' -DestinationPath '${quote(destination)}'`
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(command, 'utf16le').toString('base64')], { windowsHide: true })
  const folders = (await fs.readdir(destination, { withFileTypes: true })).filter(entry => entry.isDirectory())
  assert.equal(folders.length, 1)
  const directory = path.join(destination, folders[0].name)
  return { directory, runtime: path.join(directory, 'runtime', 'node.exe'), launcher: path.join(directory, 'launcher.mjs'), version: JSON.parse(await fs.readFile(path.join(directory, 'app', 'package.json'), 'utf8')).version }
}
function client(pkg, directory) {
  const env = { ...process.env, PORT: '0', VEHICLE_MANAGER_DATA_DIR: directory, PATH: path.dirname(pkg.runtime), NODE_OPTIONS: '' }
  delete env.NODE_PATH; delete env.npm_execpath
  const result = { pkg, directory, env, cookie: '', token: '', state: null, started: false }
  clients.push(result)
  return result
}
async function start(c) {
  await execute(c.pkg.runtime, [c.pkg.launcher, '--no-browser'], { cwd: c.pkg.directory, env: c.env, windowsHide: true, timeout: 30000 })
  c.started = true
  c.state = JSON.parse(await fs.readFile(path.join(c.directory, 'service.json'), 'utf8'))
}
async function stop(c) {
  if (!c.started) return
  await execute(c.pkg.runtime, [c.pkg.launcher, '--stop'], { cwd: c.pkg.directory, env: c.env, windowsHide: true, timeout: 20000 })
  for (let index = 0; index < 200 && existsSync(path.join(c.directory, 'service.json')); index++) await new Promise(resolve => setTimeout(resolve, 50))
  assert(!existsSync(path.join(c.directory, 'service.json')), 'Service must stop before another version opens its data')
  c.started = false
}
async function request(c, route, method = 'GET', body) {
  const form = body instanceof FormData
  const response = await fetch(`http://127.0.0.1:${c.state.port}/api${route}`, { method, headers: { Cookie: c.cookie, 'X-App-Request': 'vehicle-manager', 'X-Workspace-Token': c.token, ...(body && !form ? { 'Content-Type': 'application/json' } : {}) }, body: body ? form ? body : JSON.stringify(body) : undefined, signal: AbortSignal.timeout(30000) })
  c.cookie = response.headers.get('set-cookie')?.split(';')[0] || c.cookie
  c.token = response.headers.get('x-workspace-token') || c.token
  const value = response.headers.get('content-type')?.includes('json') ? await response.json() : Buffer.from(await response.arrayBuffer())
  assert(response.ok, `${method} ${route}: ${response.status} ${JSON.stringify(value)}`)
  return value
}
const credentials = { username: 'upgrade-check', displayName: 'Synthetic upgrade administrator', password: 'Upgrade-Acceptance-2026!' }
const write = (c, kind, fields, vehicleId) => request(c, '/business/records', 'POST', { kind, vehicleId, data: fields, reason: 'Synthetic packaged upgrade acceptance' })
const sync = async c => { const state = await request(c, '/business/sync', 'POST'); assert.equal(state.phase, 'ready'); assert.equal(state.pending, 0); return state }
try {
  const old = await extract(inputs[0], 'old-package'), next = await extract(inputs[1], 'new-package')
  assert.equal(old.version, '1.9.1'); assert.notEqual(next.version, old.version)
  const primary = client(old, data)
  await fs.mkdir(shared); await start(primary)
  await request(primary, '/register', 'POST', credentials)
  const team = await request(primary, '/setup/configure', 'POST', { path: shared, mode: 'create', confirmed: true, teamName: 'Existing packaged team' })
  const vehicle = await write(primary, 'vehicle', { name: 'Existing packaged vehicle', vin: 'TEST0000000000001', status: 'available', complianceLevel: 'Eu7' })
  const second = await write(primary, 'vehicle', { name: 'Linked target', vin: 'TEST0000000000002', status: 'testing', complianceLevel: 'Eu7' })
  const archived = await write(primary, 'vehicle', { name: 'Existing archived vehicle', vin: 'TEST0000000000003', status: 'inactive', complianceLevel: 'Eu7' })
  await request(primary, `/business/records/${archived.id}/archive`, 'POST', { archived: true, version: archived.version, requestId: randomUUID(), reason: 'Existing archive' })
  const equipment = await write(primary, 'equipment', { name: 'Existing logger', equipmentType: 'ETAS tools' }, vehicle.id)
  const appRequire = createRequire(path.join(old.directory, 'app', 'package.json')), ExcelJS = appRequire('exceljs')
  const book = new ExcelJS.Workbook()
  book.addWorksheet('DOVE').addRows([['Vin :', vehicle.data.vin], ['Date of record', '2026-11-01']])
  book.addWorksheet('Identification').addRows([['ECU', 'Description'], ['EVCU', 'Synthetic controller', 'CAN UDS', 'Supplier', 'FN', 'PN', '1.0']])
  book.addWorksheet('Defauts')
  const original = Buffer.from(await book.xlsx.writeBuffer()), upload = new FormData()
  upload.append('file', new Blob([original]), 'existing-report.xlsx')
  const draft = await request(primary, '/business/dove/preview', 'POST', upload)
  const report = await request(primary, '/business/dove/save', 'POST', { draftId: draft.id, confirmation: { confirmed: true, reportOnly: true } })
  const modification = await write(primary, 'modification', { name: 'Existing shared retrofit' }, vehicle.id)
  await sync(primary)
  await request(primary, '/business/modifications/enable', 'POST', { requestId: randomUUID(), reason: 'Synthetic old team activation' })
  const view = await request(primary, `/business/modifications/${modification.id}`)
  await request(primary, `/business/modifications/${modification.id}/populate`, 'POST', { requestId: randomUUID(), version: view.record.version, groupVersion: view.groupVersion, reason: 'Existing shared retrofit', mode: 'linked', targets: [{ vehicleId: second.id, expectedVin: second.data.vin }] })
  await request(primary, '/business/configuration-revisions/enable', 'POST', { requestId: randomUUID(), reason: 'Existing configuration activation' })
  const revisionPath = `/business/vehicles/${vehicle.id}/configuration-revisions`
  const review = await request(primary, `${revisionPath}/preview`, 'POST', {}), decisions = { fields: {}, sections: {} }
  for (const section of review.sections) {
    if (!section.components.length) decisions.sections[section.typeId] = { state: 'unknown', reason: 'Synthetic existing configuration' }
    for (const component of section.components) for (const field of component.fields) if (field.required && !field.value.trim()) decisions.fields[`${component.id}:${field.id}`] = { state: 'unknown', reason: 'Synthetic unknown value' }
  }
  const revision = await request(primary, revisionPath, 'POST', { previewToken: review.token, requestId: randomUUID(), summary: 'Existing reviewed configuration', decisions })
  await sync(primary)
  const frozenRevision = await request(primary, `${revisionPath}/${revision.revisionId}`)
  const backup = await request(primary, '/business/backup')
  assert.equal(backup.subarray(0, 2).toString(), 'PK')
  // Simulate a disconnected test share; both paths are exclusively under root.
  assert.equal(path.dirname(shared), root); assert.equal(path.dirname(offline), root)
  await fs.rename(shared, offline)
  const current = (await request(primary, '/business/workspace?local=1')).data.records.find(record => record.id === vehicle.id)
  await request(primary, `/business/records/${vehicle.id}`, 'PUT', { version: current.version, data: { ...current.data, owner: 'Retained offline owner' }, reason: 'Retain old pending work across upgrade' })
  const oldPending = (await request(primary, '/business/sync')).pending
  assert(oldPending > 0)
  const before = (await request(primary, '/business/workspace?local=1')).data.records
  await stop(primary)
  primary.pkg = next; primary.env.PATH = path.dirname(next.runtime)
  await start(primary)
  await request(primary, '/login', 'POST', credentials)
  assert.equal((await request(primary, '/bootstrap')).version, next.version)
  const upgraded = (await request(primary, '/business/workspace?local=1')).data.records
  for (const record of before) assert.deepEqual(upgraded.find(row => row.id === record.id)?.data, record.data, `Existing record changed: ${record.kind}`)
  assert.equal((await request(primary, '/business/sync')).pending, oldPending, 'Opening offline with the new package must retain the old queue')
  await fs.rename(offline, shared)
  assert.equal(upgraded.find(record => record.id === archived.id).archived, true)
  assert.deepEqual(await request(primary, `/business/files/${report.id}`), original)
  assert.deepEqual(await request(primary, `${revisionPath}/${revision.revisionId}`), frozenRevision)
  assert.equal((await request(primary, `/business/modifications/${modification.id}`)).linkedVehicles.length, 2)
  await request(primary, '/workspaces/resume', 'POST', { confirmed: true }); await sync(primary)
  const query = { search: '', archived: false, page: 1, pageSize: 1, filters: {}, detailId: vehicle.id }
  const page = await request(primary, '/business/vehicle-list?local=1', 'POST', query)
  assert.equal(page.data.vehicleList.total, 2); assert.equal(page.data.vehicleList.ids.length, 1)
  assert(page.data.records.some(record => record.id === equipment.id))
  const fresh = page.data.records.find(record => record.id === vehicle.id)
  await request(primary, `/business/records/${vehicle.id}`, 'PUT', { data: { ...fresh.data, owner: 'Edited after upgrade' }, version: fresh.version, reason: 'Verify packaged editing' })
  await sync(primary)
  const observer = client(next, path.join(root, 'observer'))
  await start(observer)
  await request(observer, '/register', 'POST', { ...credentials, username: 'upgrade-observer', displayName: 'Synthetic observer' })
  await request(observer, '/setup/configure', 'POST', { path: shared, mode: 'join', teamId: team.teamId })
  const roster = await request(primary, '/team'), pending = roster.requests.find(item => item.identity.displayName === 'Synthetic observer')
  assert(pending)
  await request(primary, `/team/requests/${pending.id}/approve`, 'POST', { role: 'member', memberId: null, reason: 'Approve isolated synchronization check' })
  await sync(observer)
  const observed = (await request(observer, '/business/workspace?local=1')).data.records.find(record => record.id === vehicle.id)
  assert.equal(observed.data.owner, 'Edited after upgrade')
  await stop(observer)
  const restoreFile = () => { const form = new FormData(); form.append('file', new Blob([backup]), 'old-backup.zip'); return form }
  const restorePreview = await request(primary, '/business/restore/preview', 'POST', restoreFile())
  assert.deepEqual(restorePreview.conflicts, [])
  const restore = restoreFile()
  for (const [key, value] of Object.entries({ confirmation: 'RESTORE', reason: 'Verify packaged old backup recovery', requestId: randomUUID(), previewFingerprint: restorePreview.fingerprint, archiveRecordIds: JSON.stringify(restorePreview.archiveCandidates.map(record => record.id)), confirmDroppedFields: 'true' })) restore.append(key, value)
  await request(primary, '/business/restore', 'POST', restore)
  await sync(primary)
  const restored = (await request(primary, '/business/workspace?local=1')).data.records.find(record => record.id === vehicle.id)
  assert.equal(restored.data.owner, '')
  assert.deepEqual(await request(primary, `/business/files/${report.id}`), original)
  assert.deepEqual(await request(primary, `${revisionPath}/${revision.revisionId}`), frozenRevision)
  await stop(primary); await start(primary)
  await request(primary, '/login', 'POST', credentials)
  assert.equal((await request(primary, '/business/modifications/' + modification.id)).linkedVehicles.length, 2)
  console.log(JSON.stringify({ oldVersion: old.version, newVersion: next.version, oldZipSha256: hash(await fs.readFile(inputs[0])), candidateZipSha256: hash(await fs.readFile(inputs[1])), extractedLaunch: true, oldAccountsAndTeamReused: true, pendingWorkRetained: true, archivedRecordsRetained: true, originalBytesMatch: true, immutableConfigurationRetained: true, linkedScopeRetained: true, pagedDetails: true, editing: true, twoClientSynchronization: true, oldBackupRestore: true, restartPersistence: true, environment: 'Two isolated services on one Windows host with a synthetic local shared directory; not physical SMB acceptance' }))
} finally {
  for (const c of clients.reverse()) await stop(c)
  assert.equal(path.dirname(root), os.tmpdir())
  await fs.rm(root, { recursive: true, force: true })
}
