import { fork, spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { promises as fs, openSync, closeSync, existsSync } from 'node:fs'
import path from 'node:path'
import net from 'node:net'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = path.dirname(fileURLToPath(import.meta.url))
const application = existsSync(path.join(root, 'app', 'dist-server')) ? path.join(root, 'app') : root
let appVersion
let prepared
let startupLog
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))

function context() {
  prepared ||= (async () => {
    const { resolveDataDirectory } = await import(pathToFileURL(path.join(application, 'dist-server', 'shared', 'data-directory.js')).href)
    const dataDir = process.env.VEHICLE_MANAGER_DATA_DIR ? path.resolve(process.env.VEHICLE_MANAGER_DATA_DIR) : await resolveDataDirectory(root)
    return { dataDir, stateFile: path.join(dataDir, 'service.json'), instanceId: createHash('sha256').update(path.resolve(dataDir).toLowerCase()).digest('hex') }
  })()
  return prepared
}

const readState = stateFile => fs.readFile(stateFile, 'utf8').then(value => JSON.parse(value)).catch(() => null)
async function probe(port, timeout = 1500) {
  try { const response = await fetch(`http://127.0.0.1:${port}/api/bootstrap`, { signal: AbortSignal.timeout(timeout) }); return response.ok ? await response.json() : null } catch { return null }
}
function alive(pid) { if (!Number.isSafeInteger(pid) || pid <= 0) return false; try { process.kill(pid, 0); return true } catch (error) { return error.code === 'EPERM' } }

// Windows named pipes release automatically after a crash and serialize lock recovery.
async function launchGuard(instanceId) {
  if (process.platform !== 'win32') return () => {}
  const deadline = Date.now() + 60000
  for (;;) {
    const guard = net.createServer(socket => socket.destroy())
    try {
      await new Promise((resolve, reject) => {
        guard.once('error', reject)
        guard.listen(`\\\\.\\pipe\\vehicle-manager-launch-${instanceId}`, resolve)
      })
      return () => guard.close()
    } catch (error) {
      if (error.code !== 'EADDRINUSE') throw error
      if (Date.now() >= deadline) throw new Error('Another launcher is still starting this local data. Wait for it to finish, then retry.', { cause: error })
      await delay(200)
    }
  }
}

async function acquireLock(lock, token) {
  const deadline = Date.now() + 60000
  for (;;) {
    try { await fs.mkdir(lock); break } catch (error) {
      if (error.code !== 'EEXIST') throw error
      const owner = await readState(path.join(lock, 'owner.json'))
      const stat = await fs.stat(lock).catch(error => { if (error.code !== 'ENOENT') throw error; return null })
      if (!stat) continue
      if (owner && !alive(owner.pid)) {
        await fs.rm(lock, { recursive: true, force: true })
        continue
      }
      if (!owner && Date.now() - stat.mtimeMs > 5000) {
        // Only remove an empty orphan; a concurrent owner write prevents rmdir.
        try { await fs.rmdir(lock); continue } catch (error) { if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error.code)) throw error }
      }
      if (Date.now() >= deadline) throw new Error('A launch is still in progress, or its startup lock needs inspection. Retry after the other launcher closes.')
      await delay(200)
    }
  }
  try { await fs.writeFile(path.join(lock, 'owner.json'), JSON.stringify({ token, pid: process.pid }), { flag: 'wx' }) }
  catch (error) { await fs.rmdir(lock).catch(() => {}); throw error }
}

async function stop() {
  const { stateFile, instanceId } = await context()
  const state = await readState(stateFile)
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
  const { dataDir, stateFile, instanceId } = await context()
  startupLog = path.join(dataDir, 'startup.log')
  if (existsSync(`${dataDir}.update-lock`)) {
    throw new Error('A legacy application update lock exists. Finish the old update before starting this version.')
  }
  const managed = process.argv.includes('--managed')
  let managedExit
  await fs.mkdir(dataDir, { recursive: true })
  const lock = path.join(dataDir, '.launch-lock'), token = randomUUID()
  const releaseGuard = await launchGuard(instanceId)
  let port
  try {
    await acquireLock(lock, token)
    const state = await readState(stateFile)
    if (state) {
      let current = await probe(state.port)
      if (!current && alive(state.pid)) current = await probe(state.port, 5000)
      if (current?.instanceId === instanceId && current.pid === state.pid) {
        if (current.version === appVersion && (!state.version || state.version === appVersion)) port = state.port
        else {
          const response = await fetch(`http://127.0.0.1:${state.port}/api/local/shutdown`, { method: 'POST', headers: { 'X-App-Request': 'vehicle-manager', 'X-Control-Token': state.controlToken }, signal: AbortSignal.timeout(5000) })
          if (!response.ok) throw new Error('A different application version is using this local data and rejected a safe stop. Stop it with its matching Stop.cmd.')
          const deadline = Date.now() + 60000
          while ((alive(state.pid) || await readState(stateFile)) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 100))
          if (alive(state.pid) || await readState(stateFile)) throw new Error('The previous application version is still shutting down. Retry after it closes.')
        }
      }
      else if (alive(state.pid)) throw new Error('An existing process could not be verified. Refusing to open this database twice.')
    }
    if (!port) {
      const entry = path.join(application, 'dist-server', 'server', 'main.js')
      if (!existsSync(entry)) throw new Error('Application build is missing. Run npm run build in the development project.')
      const base = Number(process.env.PORT || 4410)
      if (!Number.isInteger(base) || base < 0 || base > 65535) throw new Error('PORT must be an integer between 0 and 65535.')
      for (let attempt = 0; attempt < 20 && !port; attempt++) {
        const candidate = base === 0 ? 0 : base + attempt
        if (candidate > 65535) break
        if (candidate && await probe(candidate)) continue
        const log = openSync(path.join(dataDir, 'startup.log'), 'a')
        let child
        try {
          child = fork(entry, [], {
            cwd: application, execArgv: ['--import', pathToFileURL(path.join(application, 'dist-server', 'server', 'timestamp-output.js')).href], detached: !managed, windowsHide: true, stdio: ['ignore', log, log, 'ipc'],
            env: { ...process.env, PORT: String(candidate), VEHICLE_MANAGER_DATA_DIR: dataDir },
          })
          if (managed) managedExit = new Promise(resolve => child.once('exit', code => resolve(code ?? 1)))
          port = await new Promise((resolve, reject) => {
            const notice = setTimeout(() => console.log('The application is still starting. A large local database migration may take several minutes; leave this window open.'), 20000)
            child.once('message', message => { clearTimeout(notice); if (message?.type === 'ready' && message.instanceId === instanceId && Number.isInteger(message.port) && message.port > 0 && message.port <= 65535) resolve(message.port); else reject(Object.assign(new Error(`Service startup failed${message?.code ? ` (${message.code})` : ': invalid startup response'}.`), { code: message?.code })) })
            child.once('error', error => { clearTimeout(notice); reject(error) })
            child.once('exit', (code, signal) => { clearTimeout(notice); reject(new Error(`Application exited during startup (code ${code}, signal ${signal || 'none'}).`)) })
          })
          child.disconnect(); if (!managed) child.unref()
        } catch (error) {
          if (child?.pid && child.exitCode === null && child.signalCode === null) {
            await new Promise(resolve => { child.once('exit', resolve); child.kill() })
          }
          if (error.code !== 'EADDRINUSE' || attempt === 19 || base === 0) throw error
        } finally { closeSync(log) }
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
    try {
      const owner = await readState(path.join(lock, 'owner.json'))
      if (owner?.token === token) await fs.rm(lock, { recursive: true })
    } finally { releaseGuard() }
  }
  if (managedExit && await managedExit !== 0) throw new Error('The managed service did not exit cleanly.')
}

async function main() {
  const packageInfo = JSON.parse(await fs.readFile(path.join(application, 'package.json'), 'utf8'))
  appVersion = String(packageInfo.version)
  if (['--check', '--download', '--apply'].some(flag => process.argv.includes(flag))) throw new Error('Automatic updates are not supported. Download releases manually.')
  if (process.argv.includes('--stop')) return stop()
  return launch()
}

if (path.resolve(process.argv[1] || '') === fileURLToPath(import.meta.url)) main().catch(async error => {
  console.error(error.message)
  console.error(`Launcher log: ${path.join(root, 'launcher.log')}`)
  if (startupLog) console.error(`Service startup log: ${startupLog}`)
  const stamp = new Date().toISOString()
  const lines = String(error.stack || error).split(/\r?\n/).map(line => `[${stamp}] [launcher] ${line}`).join('\n')
  try { await fs.appendFile(path.join(root, 'launcher.log'), `${lines}\n`) } catch (logError) { console.error(`Could not write launcher log: ${logError.message}`) }
  process.exitCode = 1
})
