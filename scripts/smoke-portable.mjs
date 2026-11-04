import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { promises as fs, existsSync } from 'node:fs'
import path from 'node:path'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import os from 'node:os'
import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'

const release = path.resolve(process.argv[2] || '')
const executable = path.join(release, 'runtime', 'node.exe'), launcher = path.join(release, 'launcher.mjs')
if (!existsSync(executable) || !existsSync(launcher)) throw new Error('Pass the generated portable application directory.')
const appRequire = createRequire(path.join(release, 'app', 'package.json'))
const ExcelJS = appRequire('exceljs')
const readableStream = appRequire('readable-stream')
assert.equal(typeof readableStream.Readable, 'function')
for (const [name, specifier, version] of [['process', 'process/', '0.11.10'], ['string_decoder', 'string_decoder/', '1.3.0'], ['safe-buffer', 'safe-buffer', '5.2.1']]) {
  const resolved = appRequire.resolve(specifier)
  let directory = path.dirname(resolved), actualVersion
  while (directory !== path.dirname(directory)) {
    const packageFile = path.join(directory, 'package.json')
    if (existsSync(packageFile)) {
      const pkg = JSON.parse(await fs.readFile(packageFile, 'utf8'))
      if (pkg.name === name) { actualVersion = pkg.version; break }
    }
    directory = path.dirname(directory)
  }
  assert.equal(actualVersion, version, `Portable package has the wrong ${name} package`)
}
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vehicle-portable-验收 ')), data = path.join(root, 'local'), shared = path.join(root, 'shared')
await fs.mkdir(shared)
const env = { ...process.env, PORT: '0', VEHICLE_MANAGER_DATA_DIR: data, PATH: path.dirname(executable), NODE_OPTIONS: '' }, execute = promisify(execFile)
delete env.NODE_PATH
delete env.npm_execpath
let cookie = '', workspaceToken = '', started = false
try {
  await execute(executable, [launcher, '--no-browser'], { cwd: release, env, timeout: 30000 }); started = true
  let state = JSON.parse(await fs.readFile(path.join(data, 'service.json'), 'utf8'))
  await execute(executable, [launcher, '--no-browser'], { cwd: release, env, timeout: 10000 })
  assert.equal(JSON.parse(await fs.readFile(path.join(data, 'service.json'), 'utf8')).pid, state.pid)
  async function request(url, method = 'GET', body) {
    const form = body instanceof FormData
    const response = await fetch(`http://127.0.0.1:${state.port}/api${url}`, { method, headers: { Cookie: cookie, 'X-Workspace-Token': workspaceToken, 'X-App-Request': 'vehicle-manager', ...(body && !form ? { 'Content-Type': 'application/json' } : {}) }, body: body ? form ? body : JSON.stringify(body) : undefined })
    workspaceToken = response.headers.get('x-workspace-token') || workspaceToken
    const issued = response.headers.get('set-cookie'); if (issued) cookie = issued.split(';')[0]
    const result = response.headers.get('content-type')?.includes('json') ? await response.json() : Buffer.from(await response.arrayBuffer())
    if (!response.ok) throw new Error(`${url}: ${JSON.stringify(result)}`)
    return result
  }
  assert.equal((await request('/bootstrap')).user, null)
  await request('/register', 'POST', { username: 'portable-test', displayName: 'Portable isolated verification', password: 'Portable-Test-Password1' })
  await request('/setup/configure', 'POST', { path: shared, mode: 'create', confirmed: true, teamName: 'Portable test' })
  const vehicle = await request('/business/records', 'POST', { kind: 'vehicle', data: { name: 'Package test', vin: 'TEST0000000000001', status: 'available', complianceLevel: 'Eu7' }, reason: 'Portable smoke verification' })
  const book = new ExcelJS.Workbook()
  book.addWorksheet('DOVE').addRow(['Vin :', vehicle.data.vin])
  const identification = book.addWorksheet('Identification'); identification.addRow(['ECU', 'Description']); identification.addRow(['EVCU', 'Control', 'CAN UDS', 'Supplier', 'FN', 'PN', '2.0'])
  book.addWorksheet('Defauts')
  const bytes = Buffer.from(await book.xlsx.writeBuffer()), form = new FormData()
  form.append('file', new Blob([bytes]), 'portable.xlsx')
  const preview = await request('/business/dove/preview', 'POST', form)
  assert.equal(preview.match, 'matched'); assert.equal(preview.parsed.controllers.length, 1)
  const report = await request('/business/dove/save', 'POST', { draftId: preview.id, confirmation: { confirmed: true, reportOnly: true } })
  assert.deepEqual(await request(`/business/files/${report.id}`), bytes)
  const battery = await request('/business/records', 'POST', { kind: 'part', vehicleId: vehicle.id, data: { name: 'HV Battery', category: 'battery', productPart: 'BAT-PN-001', serial: '000123', maturity: 'POC', lifeStatus: 'BOL' }, reason: 'Install fictional portable verification battery' })
  assert.equal((await request('/business/sync', 'POST')).pending, 0)
  const enabled = await request('/business/configuration-revisions/enable', 'POST', { requestId: randomUUID(), reason: 'All isolated portable verification clients are upgraded' })
  assert.equal(enabled.enabled, true); assert.equal(enabled.policyEnabled, false)
  const headPath = path.join(shared, 'business', 'HEAD.json')
  assert.equal(JSON.parse(await fs.readFile(headPath, 'utf8')).protocol, 3)
  const revisions = `/business/vehicles/${vehicle.id}/configuration-revisions`
  function publication(value) {
    const decisions = { fields: {}, sections: {} }
    for (const section of value.sections) {
      if (!section.components.length) decisions.sections[section.typeId] = { state: 'notInstalled', reason: 'Not fitted to this fictional portable verification vehicle' }
      for (const component of section.components) for (const field of component.fields) if (field.required && !field.value.trim()) decisions.fields[`${component.id}:${field.id}`] = { state: 'unknown', reason: 'Fictional supplier identification is pending' }
    }
    return { previewToken: value.token, requestId: randomUUID(), title: 'Portable verification', summary: 'Freeze reviewed fictional vehicle configuration', decisions }
  }
  const firstCommand = publication(await request(`${revisions}/preview`, 'POST', {})), first = await request(revisions, 'POST', firstCommand)
  assert.equal(first.label, 'R01'); assert.equal(first.localSynced, true)
  const frozenFirst = await request(`${revisions}/${first.revisionId}`)
  assert.equal(frozenFirst.data.schema, 1)
  assert.ok(frozenFirst.data.snapshot.sections.find(section => section.typeId === 'hv-battery')?.components.some(component => component.id === battery.id))
  const type = enabled.types.find(row => row.id === 'hv-battery')
  assert.ok(type)
  const policyCommand = { version: type.version, name: type.name, description: type.description, reviewState: 'disabled', requestId: randomUUID(), reason: 'Exclude battery from subsequent fictional configuration reviews' }
  const disabled = await request(`/business/component-types/${type.id}`, 'PUT', policyCommand)
  assert.equal(disabled.reviewState, 'disabled')
  const policyHead = await fs.readFile(headPath, 'utf8')
  assert.equal(JSON.parse(policyHead).protocol, 4)
  assert.deepEqual(await request(`/business/component-types/${type.id}`, 'PUT', policyCommand), disabled)
  assert.equal(await fs.readFile(headPath, 'utf8'), policyHead)
  const secondPreview = await request(`${revisions}/preview`, 'POST', {})
  assert.ok(!secondPreview.sections.some(section => section.typeId === type.id))
  assert.equal(secondPreview.reviewScope.find(scope => scope.typeId === type.id)?.included, false)
  const secondCommand = publication(secondPreview), second = await request(revisions, 'POST', secondCommand)
  assert.equal(second.label, 'R02'); assert.equal(second.localSynced, true)
  const frozenSecond = await request(`${revisions}/${second.revisionId}`)
  assert.equal(frozenSecond.data.schema, 2); assert.equal(frozenSecond.data.snapshot.schema, 2)
  assert.ok(!frozenSecond.data.snapshot.sections.some(section => section.typeId === type.id))
  assert.equal(frozenSecond.data.snapshot.reviewScope.find(scope => scope.typeId === type.id)?.reviewState, 'disabled')
  assert.deepEqual(await request(`${revisions}/${first.revisionId}`), frozenFirst)
  const working = await request('/business/workspace?local=1')
  assert.equal(working.data.catalog.policyEnabled, true)
  assert.equal(working.data.revisionSummaries.find(row => row.vehicleId === vehicle.id)?.hasChanges, false)
  assert.ok(working.data.records.some(record => record.id === battery.id))
  assert.ok(working.data.records.every(record => !['configurationRevision', 'componentType'].includes(record.kind)))
  const backup = await request('/business/backup')
  assert.equal(backup.subarray(0, 2).toString(), 'PK')
  const archive = await appRequire('unzipper').Open.buffer(backup)
  const manifest = JSON.parse((await archive.files.find(file => file.path === 'manifest.json').buffer()).toString())
  assert.equal(manifest.format, 4); assert.equal(manifest.schemaVersion, 5); assert.equal(manifest.fieldVersion, 3)
  assert.ok(manifest.records.some(record => record.id === vehicle.id))
  assert.ok(manifest.records.some(record => record.id === report.id))
  assert.deepEqual(manifest.records.find(record => record.id === first.revisionId), frozenFirst)
  assert.deepEqual(manifest.records.find(record => record.id === second.revisionId), frozenSecond)
  assert.equal(manifest.records.find(record => record.id === type.id)?.data.reviewState, 'disabled')
  for (const command of [firstCommand, secondCommand, policyCommand]) assert.ok(manifest.configurationReceipts.some(entry => entry.key === `configurationRequest:${command.requestId}`))
  await execute(executable, [launcher, '--stop'], { cwd: release, env, timeout: 15000 }); started = false
  for (let attempt = 0; attempt < 200 && existsSync(path.join(data, 'service.json')); attempt++) await new Promise(resolve => setTimeout(resolve, 50))
  assert.equal(existsSync(path.join(data, 'service.json')), false)
  const database = new DatabaseSync(path.join(data, 'local.sqlite'), { readOnly: true })
  try {
    assert.equal(database.prepare('PRAGMA user_version').get().user_version, 5)
    for (const revision of [frozenFirst, frozenSecond]) assert.deepEqual(JSON.parse(database.prepare('SELECT data FROM records WHERE id=?').get(revision.id).data), revision.data)
  } finally { database.close() }
  await execute(executable, [launcher, '--no-browser'], { cwd: release, env, timeout: 30000 }); started = true
  state = JSON.parse(await fs.readFile(path.join(data, 'service.json'), 'utf8'))
  await request('/logout', 'POST')
  await request('/login', 'POST', { username: 'portable-test', password: 'Portable-Test-Password1' })
  const records = await request('/business/records')
  assert.ok(records.some(record => record.id === vehicle.id))
  assert.ok(records.some(record => record.id === report.id))
  assert.deepEqual(await request(`/business/files/${report.id}`), bytes)
  assert.deepEqual((await request(revisions)).map(revision => revision.label), ['R02', 'R01'])
  assert.deepEqual(await request(`${revisions}/${first.revisionId}`), frozenFirst)
  assert.deepEqual(await request(`${revisions}/${second.revisionId}`), frozenSecond)
  assert.deepEqual(await request(revisions, 'POST', firstCommand), first)
  assert.deepEqual(await request(revisions, 'POST', secondCommand), second)
  assert.deepEqual(await request(`/business/component-types/${type.id}`, 'PUT', policyCommand), disabled)
  assert.equal(JSON.parse(await fs.readFile(headPath, 'utf8')).protocol, 4)
  console.log(JSON.stringify({ restartPersistence: true, packagedDependenciesOnly: true, unicodeDataPath: true, portableRuntime: true, launchReused: true, vehicleCreated: true, isolatedParser: true, originalBytesMatch: true, backupGenerated: true, configurationProtocol3: true, publishedR01: true, componentPolicyProtocol4: true, frozenR02Exclusion: true, backupFormat4Field3: true, schema5Persistence: true, durableConfigurationReceipts: true, version: (await request('/bootstrap')).version }))
} finally {
  if (started) {
    await execute(executable, [launcher, '--stop'], { cwd: release, env, timeout: 10000 })
    for (let attempt = 0; attempt < 100 && existsSync(path.join(data, 'service.json')); attempt++) await new Promise(resolve => setTimeout(resolve, 50))
    assert.equal(existsSync(path.join(data, 'service.json')), false, 'Service did not stop cleanly')
  }
  await fs.rm(root, { recursive: true, force: true })
}
