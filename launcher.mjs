import { fork, spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { promises as fs, openSync, closeSync, existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = path.dirname(fileURLToPath(import.meta.url))
const application = existsSync(path.join(root, 'app', 'dist-server')) ? path.join(root, 'app') : root
const packageInfo = JSON.parse(await fs.readFile(path.join(application, 'package.json'), 'utf8'))
const appVersion = process.env.VEHICLE_MANAGER_RELEASE_VERSION || String(packageInfo.version)
const { resolveDataDirectory } = await import(pathToFileURL(path.join(application, 'dist-server', 'shared', 'data-directory.js')).href)
const dataDir = await resolveDataDirectory(root)
const stateFile = path.join(dataDir, 'service.json')
const instanceId = createHash('sha256').update(path.resolve(dataDir).toLowerCase()).digest('hex')
const readState = () => fs.readFile(stateFile, 'utf8').then(value => JSON.parse(value)).catch(() => null)
async function probe(port) {
  try { const response = await fetch(`http://127.0.0.1:${port}/api/bootstrap`, { signal: AbortSignal.timeout(1500) }); return response.ok ? await response.json() : null } catch { return null }
}
function alive(pid) { try { process.kill(pid, 0); return true } catch { return false } }
async function stop() {
  const state = await readState()
  if (!state) { console.log('No service is running for this application folder.'); return }
  const current = await probe(state.port)
  if (!current) { if (alive(state.pid)) throw new Error('The recorded process is alive but could not be verified. No process was stopped.'); await fs.rm(stateFile, { force: true }); return }
  if (current.instanceId !== instanceId || current.pid !== state.pid) throw new Error('The service identity does not match. No process was stopped.')
  const response = await fetch(`http://127.0.0.1:${state.port}/api/local/shutdown`, { method: 'POST', headers: { 'X-App-Request': 'vehicle-manager', 'X-Control-Token': state.controlToken }, signal: AbortSignal.timeout(5000) })
  if (!response.ok) throw new Error('The service rejected the stop request.')
  console.log('Service stop requested. Pending work will finish before the database closes.')
}
async function launch() {
  if (Number(process.versions.node.split('.')[0]) < 24) throw new Error('Node.js 24 or newer is required.')
  if (existsSync(`${dataDir}.update-lock`)) {
    const owner = await fs.readFile(`${dataDir}.update-lock`, 'utf8')
    if (owner !== process.env.VEHICLE_MANAGER_UPDATE_LOCK_OWNER || !alive(Number(owner))) throw new Error('An application update is in progress. Do not start an older release.')
  }
  const managed = process.argv.includes('--managed')
  let managedExit
  await fs.mkdir(dataDir, { recursive: true })
  const lock = path.join(dataDir, '.launch-lock'), token = randomUUID()
  try { await fs.mkdir(lock) } catch (error) {
    if (error.code !== 'EEXIST') throw error
    const owner = await fs.readFile(path.join(lock, 'owner.json'), 'utf8').then(value => JSON.parse(value)).catch(() => null)
    if (!owner || alive(owner.pid)) throw new Error('A launch is already in progress. Retry shortly.')
    await fs.rm(lock, { recursive: true }); await fs.mkdir(lock)
  }
  await fs.writeFile(path.join(lock, 'owner.json'), JSON.stringify({ token, pid: process.pid }), { flag: 'wx' })
  let port
  try {
    const state = await readState()
    if (state) {
      const current = await probe(state.port)
      if (current?.instanceId === instanceId && current.pid === state.pid) {
        if (current.version === appVersion && (!state.version || state.version === appVersion)) port = state.port
        else {
          const response = await fetch(`http://127.0.0.1:${state.port}/api/local/shutdown`, { method: 'POST', headers: { 'X-App-Request': 'vehicle-manager', 'X-Control-Token': state.controlToken }, signal: AbortSignal.timeout(5000) })
          if (!response.ok) throw new Error('A different application version is using this local data and rejected a safe stop. Stop it with its matching Stop.cmd.')
          const deadline = Date.now() + 60000
          while ((alive(state.pid) || await readState()) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 100))
          if (alive(state.pid) || await readState()) throw new Error('The previous application version is still shutting down. Retry after it closes.')
        }
      }
      else if (alive(state.pid)) throw new Error('An existing process could not be verified. Refusing to open this database twice.')
    }
    if (!port) {
      const entry = path.join(application, 'dist-server', 'server', 'main.js')
      if (!existsSync(entry)) throw new Error('Application build is missing. Run npm run build in the development project.')
      const base = Number(process.env.PORT || 4410)
      for (let attempt = 0; attempt < 20 && !port; attempt++) {
        const candidate = base === 0 ? 0 : base + attempt
        if (candidate && await probe(candidate)) continue
        const log = openSync(path.join(dataDir, 'startup.log'), 'a')
        let child
        try {
          child = fork(entry, [], { cwd: application, execArgv: [], env: { ...process.env, PORT: String(candidate), VEHICLE_MANAGER_DATA_DIR: dataDir }, detached: !managed, windowsHide: true, stdio: ['ignore', log, log, 'ipc'] })
          if (managed) managedExit = new Promise(resolve => child.once('exit', code => resolve(code ?? 1)))
          port = await new Promise((resolve, reject) => {
            const notice = setTimeout(() => console.log('The application is still starting. A large local database migration may take several minutes; leave this window open.'), 20000)
            child.once('message', message => { clearTimeout(notice); if (message.type === 'ready' && message.instanceId === instanceId) resolve(message.port); else reject(new Error('Port busy or startup failed.')) })
            child.once('error', error => { clearTimeout(notice); reject(error) })
            child.once('exit', () => { clearTimeout(notice); reject(new Error('Application exited during startup.')) })
          })
          child.disconnect(); if (!managed) child.unref()
        } catch (error) { child?.kill(); if (attempt === 19 || base === 0) throw error } finally { closeSync(log) }
      }
    }
    if (!port) throw new Error('No free local port is available.')
    const url = `http://127.0.0.1:${port}`
    console.log(`Vehicle Data Management: ${url}`)
    if (!process.argv.includes('--no-browser')) {
      const browser = spawn('explorer.exe', [url], { detached: true, stdio: 'ignore', windowsHide: true })
      await new Promise((resolve, reject) => { browser.once('spawn', resolve); browser.once('error', reject) }); browser.unref()
    }
  } finally {
    const owner = await fs.readFile(path.join(lock, 'owner.json'), 'utf8').then(value => JSON.parse(value)).catch(() => null)
    if (owner?.token === token) await fs.rm(lock, { recursive: true })
  }
  if (managedExit && await managedExit !== 0) throw new Error('The managed service did not exit cleanly.')
}
try { if (process.argv.includes('--stop')) await stop(); else await launch() }
catch (error) { console.error(error.message); process.exitCode = 1 }