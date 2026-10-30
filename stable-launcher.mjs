import { promises as fs, openSync, closeSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { randomUUID, createHash, createPublicKey } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import os from 'node:os'
import { createRequire } from 'node:module'
import { setTimeout as retry } from 'node:timers/promises'
import { atomicJson, discoverUpdate, downloadUpdate, newerVersion, verifiedCopy, verifyManifest, isPreviewVersion, updateChannel } from './stable-update.mjs'

const root = path.dirname(fileURLToPath(import.meta.url))
const alive = pid => { try { process.kill(pid, 0); return true } catch { return false } }
const readJson = file => fs.readFile(file, 'utf8').then(JSON.parse).catch(error => { if (error.code === 'ENOENT') return null; throw error })
const readConfig = home => readJson(path.join(home, 'launcher.json'))
const readState = data => readJson(path.join(data, 'service.json'))
export async function copyLauncherDependencies(source, home) {
  const copied = new Map()
  async function copy(name, resolver) {
    let packageFile
    try { packageFile = resolver.resolve(`${name}/package.json`) }
    catch (error) {
      if (error.code !== 'ERR_PACKAGE_PATH_NOT_EXPORTED') throw error
      let directory = path.dirname(resolver.resolve(name))
      while (directory !== path.dirname(directory)) {
        const candidate = path.join(directory, 'package.json')
        const metadata = await readJson(candidate)
        if (metadata?.name === name) { packageFile = candidate; break }
        directory = path.dirname(directory)
      }
      if (!packageFile) throw new Error(`Could not locate launcher dependency ${name}.`)
    }
    const manifest = JSON.parse(await fs.readFile(packageFile, 'utf8'))
    if (copied.has(name)) {
      if (copied.get(name) !== manifest.version) throw new Error('Conflicting launcher dependency versions.')
      return
    }
    copied.set(name, manifest.version)
    await fs.cp(path.dirname(packageFile), path.join(home, 'node_modules', ...name.split('/')), { recursive: true })
    const nested = createRequire(packageFile)
    for (const dependency of Object.keys(manifest.dependencies || {})) await copy(dependency, nested)
  }
  const resolver = createRequire(path.join(source, 'app', 'package.json'))
  for (const name of ['semver', 'unzipper']) await copy(name, resolver)
  return copied.size
}
async function openBrowser(url) {
  if (process.argv.includes('--no-browser')) return
  const browser = spawn('explorer.exe', [url], { detached: true, stdio: 'ignore', windowsHide: true })
  await new Promise((resolve, reject) => { browser.once('spawn', resolve); browser.once('error', reject) })
  browser.unref()
}
async function control(state, endpoint) {
  const response = await fetch(`http://127.0.0.1:${state.port}/api/local/${endpoint}`, {
    method: 'POST', signal: AbortSignal.timeout(60000), headers: { 'X-App-Request': 'vehicle-manager', 'X-Control-Token': state.controlToken },
  })
  if (!response.ok) throw new Error(`Local ${endpoint} failed (${response.status}).`)
  return response.json()
}
async function waitReady(run, config, version) {
  const deadline = Date.now() + 180000
  while (Date.now() < deadline) {
    if (run.code !== undefined) throw new Error(`Service exited during startup (${run.code}).`)
    const state = await readState(config.dataDir)
    if (state && state.version === version) {
      try {
        const response = await fetch(`http://127.0.0.1:${state.port}/api/bootstrap`, { signal: AbortSignal.timeout(1500) })
        const bootstrap = await response.json()
        const expected = createHash('sha256').update(path.resolve(config.dataDir).toLowerCase()).digest('hex')
        if (response.ok && bootstrap.pid === state.pid && bootstrap.instanceId === expected && bootstrap.version === version) return state
      } catch { }
    }
    await retry(100)
  }
  throw new Error('The service did not become ready before the startup deadline.')
}
async function startVersion(home, config, version, checking = false) {
  const request = path.join(home, `request-${randomUUID()}.json`)
  const directory = path.join(home, 'versions', version)
  const log = openSync(path.join(home, 'launcher.log'), 'a')
  let child
  try {
    child = spawn(path.join(home, 'runtime', 'node.exe'), [path.join(directory, 'launcher.mjs'), '--managed', '--no-browser'], {
      cwd: directory, windowsHide: true, stdio: ['ignore', log, log],
      env: { ...process.env, VEHICLE_MANAGER_DATA_DIR: config.dataDir, VEHICLE_MANAGER_RELEASE_VERSION: version,
        VEHICLE_MANAGER_STABLE_HOME: home, VEHICLE_MANAGER_UPDATE_REQUEST: request, VEHICLE_MANAGER_STARTUP_CHECK: checking ? '1' : '0', VEHICLE_MANAGER_UPDATE_LOCK_OWNER: String(process.pid) },
    })
  } finally { closeSync(log) }
  const run = { child, request, code: undefined, state: null, exit: null }
  run.exit = new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', code => { run.code = code ?? 1; resolve(run.code) })
  })
  run.exit.catch(() => {})
  try { run.state = await waitReady(run, config, version); return run }
  catch (error) { error.run = run; throw error }
}
async function stopVersion(run, data) {
  if (!run) return
  if (run.code === undefined) {
    const state = await readState(data)
    if (state) await control(state, 'shutdown')
    else throw new Error('No verified service identity is available; preserve the backup and recover this interrupted startup manually.')
    await Promise.race([run.exit, retry(60000).then(() => { throw new Error('The service could not be stopped safely.') })])
  }
  if (await readState(data)) throw new Error('The service still owns its data directory.')
}
export async function installLauncher(source, home, options = {}) {
  if (path.resolve(source) === path.resolve(home)) throw new Error('Install into a separate program directory.')
  const existing = await readConfig(home)
  if (existing) {
    if (existing.channel !== updateChannel) throw new Error('Choose a separate pre-release installation directory; existing installations are not changed.')
    return home
  }
  const manifest = JSON.parse(await fs.readFile(path.join(source, 'app', 'package.json'), 'utf8'))
  if (!isPreviewVersion(manifest.version)) throw new Error('This launcher only installs pre-release application versions.')
  const publicKey = await fs.readFile(path.join(source, 'update-public-key.pem'), 'utf8')
  createPublicKey(publicKey)
  const dataDir = options.dataDir ? path.resolve(options.dataDir) : path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'VehicleManager', 'pre-data')
  const current = await readState(dataDir)
  if (current && alive(current.pid)) throw new Error('Stop the previous service before installing the stable launcher.')
  await fs.mkdir(home, { recursive: true })
  await fs.mkdir(path.join(home, 'versions'), { recursive: true })
  const initial = path.join(home, 'versions', manifest.version)
  await fs.mkdir(initial, { recursive: true })
  for (const name of ['app', 'runtime', 'launcher.mjs', 'Start.cmd', 'Stop.cmd']) await fs.cp(path.join(source, name), path.join(initial, name), { recursive: true, errorOnExist: true, force: false })
  for (const name of ['stable-launcher.mjs', 'stable-update.mjs']) await fs.copyFile(path.join(source, name), path.join(home, name))
  await fs.cp(path.join(source, 'runtime'), path.join(home, 'runtime'), { recursive: true })
  await copyLauncherDependencies(source, home)
  await fs.writeFile(path.join(home, 'Start.cmd'), '@echo off\r\ncd /d "%~dp0"\r\n"runtime\\node.exe" stable-launcher.mjs\r\nif errorlevel 1 pause\r\n')
  await fs.writeFile(path.join(home, 'Stop.cmd'), '@echo off\r\ncd /d "%~dp0"\r\n"runtime\\node.exe" stable-launcher.mjs --stop\r\nif errorlevel 1 pause\r\n')
  await atomicJson(path.join(home, 'launcher.json'), { application: 'vehicle-manager', channel: updateChannel, active: manifest.version, dataDir, publicKey,
    localFeed: options.localFeed ? path.resolve(options.localFeed) : null })
  return home
}
async function applyUpdate(home, config, request) {
  const pending = await readJson(path.join(home, 'pending.json'))
  const payload = verifyManifest(pending?.document, config.publicKey)
  if (request.version !== pending.version || pending.version !== payload.version || !newerVersion(payload.version, config.active)) throw new Error('The prepared update changed or would downgrade this installation.')
  if (await readState(config.dataDir)) throw new Error('The service has not stopped; refusing to back up live data.')
  const transaction = randomUUID()
  const backup = path.join(home, 'backups', transaction, 'data')
  const journal = { previous: config.active, target: payload.version, backup, stage: 'backing-up' }
  const journalFile = path.join(home, 'update-journal.json')
  await atomicJson(journalFile, journal)
  const dataLock = `${config.dataDir}.update-lock`
  await fs.writeFile(dataLock, String(process.pid), { flag: 'wx' })
  let next
  try {
    await verifiedCopy(config.dataDir, backup)
    await atomicJson(path.join(home, 'backups', transaction, 'backup-complete.json'), { source: config.dataDir, created: new Date().toISOString() })
    journal.stage = 'checking'; await atomicJson(journalFile, journal)
    next = await startVersion(home, config, payload.version, true)
    await control(next.state, 'update-health')
    await atomicJson(path.join(home, 'launcher.json'), { ...config, active: payload.version })
    journal.stage = 'committed'; await atomicJson(journalFile, journal)
    await fs.rm(path.join(home, 'pending.json'), { force: true })
    await control(next.state, 'update-activate')
    await openBrowser(`http://127.0.0.1:${next.state.port}`)
    return next
  } catch (error) {
    if (journal.stage === 'committed') throw error
    await stopVersion(next || error.run, config.dataDir)
    if (journal.stage === 'checking') {
      const restored = `${config.dataDir}.restore-${transaction}`
      await verifiedCopy(backup, restored)
      await fs.rename(config.dataDir, `${config.dataDir}.failed-${transaction}`)
      await fs.rename(restored, config.dataDir)
    }
    journal.stage = 'rolled-back'; journal.error = String(error.message)
    await atomicJson(path.join(home, 'launcher.json'), config)
    await atomicJson(journalFile, journal)
    await fs.appendFile(path.join(home, 'launcher.log'), `Update failed; previous version retained: ${error.message}\n`)
    const previous = await startVersion(home, config, config.active)
    await openBrowser(`http://127.0.0.1:${previous.state.port}`)
    return previous
  } finally { await fs.rm(dataLock, { force: true }) }
}
async function launch(home) {
  let config = await readConfig(home)
  if (!config) throw new Error('Install the stable launcher before starting it.')
  const lock = path.join(home, '.supervisor-lock')
  const owner = await readJson(lock)
  if (owner && alive(owner.pid)) {
    const state = await readState(config.dataDir)
    if (!state) throw new Error('The launcher is busy starting or updating. Retry shortly.')
    await openBrowser(`http://127.0.0.1:${state.port}`); return
  }
  if (owner) await fs.rm(lock)
  await fs.writeFile(lock, JSON.stringify({ pid: process.pid }), { flag: 'wx' })
  try {
    const journal = await readJson(path.join(home, 'update-journal.json'))
    if (journal && !['committed', 'rolled-back'].includes(journal.stage)) throw new Error('An interrupted update needs recovery. Preserve the journal and backup before restarting.')
    const existing = await readState(config.dataDir)
    if (existing && alive(existing.pid)) throw new Error('Another application is using these local data. Stop it with its matching Stop.cmd.')
    let run = await startVersion(home, config, config.active)
    await openBrowser(`http://127.0.0.1:${run.state.port}`)
    for (;;) {
      const code = await run.exit
      const request = await readJson(run.request)
      await fs.rm(run.request, { force: true })
      if (!request) { if (code !== 0) throw new Error('The local service did not stop cleanly.'); break }
      if (code !== 0) throw new Error('The service did not stop cleanly; update cancelled.')
      config = await readConfig(home)
      run = await applyUpdate(home, config, request)
    }
  } finally { await fs.rm(lock, { force: true }) }
}
async function main() {
  const home = process.env.VEHICLE_MANAGER_PROGRAM_DIR ? path.resolve(process.env.VEHICLE_MANAGER_PROGRAM_DIR) : root
  if (process.argv.includes('--install')) {
    const destination = process.env.VEHICLE_MANAGER_PROGRAM_DIR || path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'VehicleManager', 'pre-program')
    await installLauncher(root, destination, { dataDir: process.env.VEHICLE_MANAGER_DATA_DIR, localFeed: process.env.VEHICLE_MANAGER_LOCAL_UPDATE_FEED })
    const child = spawn(path.join(destination, 'runtime', 'node.exe'), [path.join(destination, 'stable-launcher.mjs'), ...(process.argv.includes('--no-browser') ? ['--no-browser'] : [])], { cwd: destination, detached: true, stdio: 'ignore', windowsHide: true, env: { ...process.env, VEHICLE_MANAGER_PROGRAM_DIR: destination } })
    child.unref(); console.log(`Stable launcher installed: ${path.join(destination, 'Start.cmd')}`); return
  }
  const config = await readConfig(home)
  if (!config) throw new Error('This is not an installed stable launcher. Use Install-Launcher.cmd first.')
  if (config.channel !== updateChannel) throw new Error('This launcher requires a separate pre-channel installation.')
  if (process.argv.includes('--stop')) { const state = await readState(config.dataDir); if (state) await control(state, 'shutdown'); return }
  if (process.argv.includes('--check') || process.argv.includes('--download')) {
    const update = process.argv.includes('--download') ? await downloadUpdate(config, config.active, home) : (await discoverUpdate(config)).payload.version
    const pending = await readJson(path.join(home, 'pending.json'))
    console.log(JSON.stringify({ version: newerVersion(update, config.active) ? update : null, downloaded: pending?.version || null })); return
  }
  await launch(home)
}
if (path.resolve(process.argv[1] || '') === fileURLToPath(import.meta.url)) main().catch(async error => {
  console.error(error.message)
  try { await fs.appendFile(path.join(root, 'launcher.log'), `${new Date().toISOString()} ${error.stack}\n`) } catch { }
  process.exitCode = 1
})