import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { promises as fs, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import assert from 'node:assert/strict'
import ExcelJS from 'exceljs'

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const release = path.resolve(process.argv[2] || '')
const executable = path.join(release, 'runtime', 'node.exe'), launcher = path.join(release, 'launcher.mjs')
if (!existsSync(executable) || !existsSync(launcher)) throw new Error('Pass the generated portable application directory.')
const readableStream = JSON.parse(await fs.readFile(path.join(release, 'app', 'node_modules', 'readable-stream', 'package.json'), 'utf8'))
for (const dependency of Object.keys(readableStream.dependencies || {})) {
  let current = path.join(release, 'app', 'node_modules', 'readable-stream'), found = false
  while (true) {
    if (existsSync(path.join(current, 'node_modules', dependency, 'package.json'))) { found = true; break }
    const parent = path.dirname(current)
    if (parent === current) break
    current = parent
  }
  assert.ok(found, `Portable package is missing readable-stream dependency: ${dependency}`)
}
const root = await fs.mkdtemp(path.join(project, 'test', 'test-data-package-')), data = path.join(root, 'local'), shared = path.join(root, 'shared')
await fs.mkdir(shared)
const env = { ...process.env, PORT: '0', VEHICLE_MANAGER_DATA_DIR: data }, execute = promisify(execFile)
let cookie = '', started = false
try {
  await execute(executable, [launcher, '--no-browser'], { cwd: release, env, timeout: 30000 }); started = true
  const state = JSON.parse(await fs.readFile(path.join(data, 'service.json'), 'utf8'))
  await execute(executable, [launcher, '--no-browser'], { cwd: release, env, timeout: 10000 })
  assert.equal(JSON.parse(await fs.readFile(path.join(data, 'service.json'), 'utf8')).pid, state.pid)
  async function request(url, method = 'GET', body) {
    const form = body instanceof FormData
    const response = await fetch(`http://127.0.0.1:${state.port}/api${url}`, { method, headers: { Cookie: cookie, 'X-App-Request': 'vehicle-manager', ...(body && !form ? { 'Content-Type': 'application/json' } : {}) }, body: body ? form ? body : JSON.stringify(body) : undefined })
    const issued = response.headers.get('set-cookie'); if (issued) cookie = issued.split(';')[0]
    const result = response.headers.get('content-type')?.includes('json') ? await response.json() : Buffer.from(await response.arrayBuffer())
    if (!response.ok) throw new Error(`${url}: ${JSON.stringify(result)}`)
    return result
  }
  assert.equal((await request('/bootstrap')).user, null)
  await request('/register', 'POST', { username: 'portable-test', displayName: 'Portable isolated verification', password: 'Portable-Test-Password1' })
  await request('/setup/configure', 'POST', { path: shared, mode: 'create', confirmed: true, teamName: 'Portable test' })
  const vehicle = await request('/business/records', 'POST', { kind: 'vehicle', data: { name: 'Package test', vin: 'TEST0000000000001', status: 'available' }, reason: 'Portable smoke verification' })
  const book = new ExcelJS.Workbook()
  book.addWorksheet('DOVE').addRow(['Vin :', vehicle.data.vin])
  const identification = book.addWorksheet('Identification'); identification.addRow(['ECU', 'Description']); identification.addRow(['EVCU', 'Control', 'CAN UDS', 'Supplier', 'FN', 'PN', '2.0'])
  book.addWorksheet('Defauts')
  const bytes = Buffer.from(await book.xlsx.writeBuffer()), form = new FormData()
  form.append('file', new Blob([bytes]), 'portable.xlsx')
  const preview = await request('/business/dove/preview', 'POST', form)
  assert.equal(preview.match, 'matched'); assert.equal(preview.parsed.controllers.length, 1)
  const report = await request('/business/dove/save', 'POST', { draftId: preview.id })
  assert.deepEqual(await request(`/business/files/${report.id}`), bytes)
  const backup = await request('/business/backup')
  assert.equal(backup.subarray(0, 2).toString(), 'PK')
  console.log(JSON.stringify({ portableRuntime: true, launchReused: true, vehicleCreated: true, isolatedParser: true, originalBytesMatch: true, backupGenerated: true, version: (await request('/bootstrap')).version }))
} finally {
  if (started) {
    await execute(executable, [launcher, '--stop'], { cwd: release, env, timeout: 10000 })
    for (let attempt = 0; attempt < 100 && existsSync(path.join(data, 'service.json')); attempt++) await new Promise(resolve => setTimeout(resolve, 50))
    assert.equal(existsSync(path.join(data, 'service.json')), false, 'Service did not stop cleanly')
  }
  await fs.rm(root, { recursive: true, force: true })
}