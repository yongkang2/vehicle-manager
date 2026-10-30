import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { setTimeout as retry } from 'node:timers/promises'
import { DatabaseSync } from 'node:sqlite'

const source = path.resolve(process.argv[2] || '')
const feed = path.resolve(process.argv[3] || 'releases/pre')
const rollback = process.argv.includes('--rollback')
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vehicle-manager-stable-'))
const home = path.join(root, 'program'), data = path.join(root, 'data')
const environment = { ...process.env, VEHICLE_MANAGER_PROGRAM_DIR: home, VEHICLE_MANAGER_DATA_DIR: data, VEHICLE_MANAGER_LOCAL_UPDATE_FEED: feed, PORT: '0' }
const stateFile = path.join(data, 'service.json')
const readState = () => fs.readFile(stateFile, 'utf8').then(JSON.parse).catch(() => null)
async function until(check, label) {
  const deadline = Date.now() + 180000
  while (Date.now() < deadline) { const result = await check(); if (result) return result; await retry(100) }
  throw new Error(`Timed out: ${label}. Test retained: ${root}`)
}
let state, cookie = ''
async function request(endpoint, body) {
  console.log(`Checking ${endpoint}`)
  const response = await fetch(`http://127.0.0.1:${state.port}${endpoint}`, {
    method: body === undefined ? 'GET' : 'POST', signal: AbortSignal.timeout(900000),
    headers: { Cookie: cookie, 'X-App-Request': 'vehicle-manager', 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
  })
  cookie = response.headers.get('set-cookie')?.split(';')[0] || cookie
  const result = await response.json()
  assert.ok(response.ok, JSON.stringify(result)); return result
}
try {
  execFileSync(path.join(source, 'runtime', 'node.exe'), [path.join(source, 'stable-launcher.mjs'), '--install', '--no-browser'], { env: environment, encoding: 'utf8', timeout: 180000 })
  state = await until(readState, 'initial startup')
  const from = state.version
  const user = await request('/api/register', { username: 'stable-check', displayName: 'Stable check', password: 'isolated-stable-test' })
  const before = await request('/api/status')
  await fs.writeFile(path.join(data, 'upgrade-sentinel.bin'), 'original local bytes')
  const checked = await request('/api/updates/check', {})
  assert.ok(checked.availableVersion, 'The signed feed must contain a newer version.')
  const downloaded = await request('/api/updates/download', {})
  assert.equal(downloaded.phase, 'ready')
  if (rollback) {
    const staged = path.join(home, 'versions', downloaded.downloadedVersion, 'app', 'dist-server', 'server')
    const application = path.join(staged, 'app.js')
    const original = await fs.readFile(application, 'utf8')
    const changed = original.replace("if (command === 'update-health') {", "if (command === 'update-health') { throw new Error('Intentional isolated health-check failure');")
    assert.notEqual(changed, original)
    await fs.writeFile(application, changed)
    const main = path.join(staged, 'main.js')
    const startup = await fs.readFile(main, 'utf8')
    await fs.writeFile(main, startup.replace('const port =', "import { writeFileSync } from 'node:fs'; writeFileSync(path.join(dataDir, 'upgrade-sentinel.bin'), 'failed version changed local data');\nconst port ="))
  }
  await request('/api/updates/install', { confirmed: true })
  const expectedVersion = rollback ? from : downloaded.downloadedVersion
  const expectedStage = rollback ? 'rolled-back' : 'committed'
  state = await until(async () => {
    const next = await readState()
    const journal = await fs.readFile(path.join(home, 'update-journal.json'), 'utf8').then(JSON.parse).catch(() => null)
    return next?.version === expectedVersion && journal?.stage === expectedStage ? next : null
  }, rollback ? 'previous version recovery' : 'updated service readiness')
  await until(async () => {
    const response = await fetch(`http://127.0.0.1:${state.port}/api/bootstrap`)
    if (!response.ok) return false
    const journal = await fs.readFile(path.join(home, 'update-journal.json'), 'utf8').then(JSON.parse)
    return journal.stage === expectedStage
  }, 'health check commit')
  const after = await request('/api/status')
  assert.equal(after.user.id, user.id)
  assert.equal(after.deviceId, before.deviceId)
  assert.equal(await fs.readFile(path.join(data, 'upgrade-sentinel.bin'), 'utf8'), 'original local bytes')
  const config = await fs.readFile(path.join(home, 'launcher.json'), 'utf8').then(JSON.parse)
  assert.equal(config.active, state.version)
  assert.equal(config.channel, 'pre')
  assert.equal(config.localFeed, feed)
  assert.equal(config.dataDir, data)
  const backups = await fs.readdir(path.join(home, 'backups'))
  assert.equal(backups.length, 1)
  await fs.access(path.join(home, 'backups', backups[0], 'backup-complete.json'))
  const backup = new DatabaseSync(path.join(home, 'backups', backups[0], 'data', 'local.sqlite'), { readOnly: true })
  try { assert.equal(backup.prepare('PRAGMA integrity_check').get().integrity_check, 'ok') } finally { backup.close() }
  await request('/api/logout', {})
  await request('/api/login', { username: 'stable-check', password: 'isolated-stable-test' })
  console.log(JSON.stringify({ from, to: state.version, rollbackVerified: rollback, restarted: true, accountRetained: true, deviceRetained: true, originalsRetained: true, backupVerified: true, sourcePersisted: true, root }))
} finally {
  state = await readState()
  if (state) {
    await fetch(`http://127.0.0.1:${state.port}/api/local/shutdown`, { method: 'POST', headers: { 'X-App-Request': 'vehicle-manager', 'X-Control-Token': state.controlToken } }).catch(() => {})
    await until(async () => !await readState(), 'test shutdown')
  }
}