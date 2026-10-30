import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'

export const repository = 'yongkang2/vehicle-manager'
export const updateManifestName = 'vehicle-manager-update.json'
export const maximumArchive = 512 * 1024 * 1024
export const maximumExpanded = 1024 * 1024 * 1024
const maximumEntries = 100000
const allowedHosts = new Set(['api.github.com', 'github.com', 'objects.githubusercontent.com', 'release-assets.githubusercontent.com'])

export function parseVersion(value) {
  if (typeof value !== 'string') return null
  const match = /^(\d{1,9})\.(\d{1,9})\.(\d{1,9})$/.exec(value)
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null
}

export function compareVersions(left, right) {
  const first = parseVersion(left), second = parseVersion(right)
  if (!first || !second) throw new Error('Unsupported version format.')
  for (let index = 0; index < 3; index++) if (first[index] !== second[index]) return first[index] - second[index]
  return 0
}

export function newerVersion(candidate, current) {
  return parseVersion(candidate) !== null && parseVersion(current) !== null && compareVersions(candidate, current) > 0
}

export function selectRelease(releases) {
  if (!Array.isArray(releases)) throw new Error('Invalid GitHub release list.')
  return releases.filter(release => release && release.draft === false && release.prerelease === false
    && typeof release.tag_name === 'string' && /^v\d+\.\d+\.\d+$/.test(release.tag_name))
    .sort((left, right) => compareVersions(right.tag_name.slice(1), left.tag_name.slice(1)))[0] || null
}

export function updateAsset(release) {
  const assets = Array.isArray(release?.assets) ? release.assets : []
  const asset = assets.find(item => typeof item?.name === 'string' && /^vehicle-manager-[a-zA-Z0-9._-]+\.zip$/.test(item.name))
  if (!asset || typeof asset.browser_download_url !== 'string' || !Number.isSafeInteger(asset.size) || asset.size <= 0 || asset.size > maximumArchive) return null
  const digest = typeof asset.digest === 'string' && /^sha256:[a-f0-9]{64}$/.test(asset.digest) ? asset.digest.slice(7) : null
  return { name: asset.name, size: asset.size, url: asset.browser_download_url, sha256: digest }
}

export function safeEntryName(name) {
  if (typeof name !== 'string' || !name || name.includes('\\') || name.includes(':') || name.includes('\0') || name.startsWith('/')) return null
  const pieces = name.split('/')
  if (pieces.some(piece => piece === '..' || piece === '.')) return null
  if (pieces.filter(Boolean).some(piece => /[. ]$/.test(piece) || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(piece))) return null
  if (!/^vehicle-manager-[a-zA-Z0-9._-]+$/.test(pieces[0])) return null
  return pieces.slice(1).join('/')
}

export async function hashFile(file) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(file)) hash.update(chunk)
  return hash.digest('hex')
}

export async function atomicJson(file, value) {
  const temporary = `${file}.${randomUUID()}.tmp`
  try { await fs.writeFile(temporary, JSON.stringify(value)); await fs.rename(temporary, file) }
  finally { await fs.rm(temporary, { force: true }) }
}

export function readJson(file) {
  return fs.readFile(file, 'utf8').then(JSON.parse).catch(error => { if (error.code === 'ENOENT') return null; throw error })
}

async function githubFetch(address) {
  for (let count = 0; count < 6; count++) {
    const url = new URL(address)
    if (url.protocol !== 'https:' || !allowedHosts.has(url.hostname) || url.username || url.password) throw new Error('Untrusted update download address.')
    const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(300000), headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'VehicleManager-Updater' } })
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      address = new URL(response.headers.get('location'), url).href
      await response.body?.cancel()
      continue
    }
    if (!response.ok) throw new Error(`GitHub update request failed (${response.status}).`)
    return response
  }
  throw new Error('Too many update redirects.')
}

async function githubJson(address) {
  const response = await githubFetch(address)
  const chunks = []
  let bytes = 0
  for await (const chunk of response.body) {
    bytes += chunk.length
    if (bytes > 2 * 1024 * 1024) throw new Error('Update metadata is too large.')
    chunks.push(chunk)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

export async function currentVersion(home) {
  const manifest = await readJson(path.join(home, 'app', 'package.json'))
  if (!parseVersion(manifest?.version)) throw new Error('The installed application version is unknown.')
  return manifest.version
}

export async function discoverLatest() {
  const release = selectRelease(await githubJson(`https://api.github.com/repos/${repository}/releases?per_page=30`))
  if (!release) throw new Error('No published release is available yet.')
  const version = release.tag_name.slice(1)
  const asset = updateAsset(release)
  if (!asset) throw new Error('The latest release has no Windows package asset.')
  let sha256 = asset.sha256
  if (!sha256) {
    const manifest = (release.assets || []).find(item => item.name === updateManifestName)
    if (!manifest || typeof manifest.browser_download_url !== 'string') throw new Error('The release has no checksum information.')
    const document = await githubJson(manifest.browser_download_url)
    if (document?.version !== version || document?.fileName !== asset.name || !/^[a-f0-9]{64}$/.test(document?.sha256 || '')) throw new Error('The release checksum manifest is not supported.')
    sha256 = document.sha256
  }
  return { version, fileName: asset.name, size: asset.size, url: asset.url, sha256 }
}

export async function checkUpdate(home) {
  const current = await currentVersion(home)
  const pending = await readJson(path.join(home, 'pending.json'))
  const latest = await discoverLatest()
  return { version: newerVersion(latest.version, current) ? latest.version : null, downloaded: pending?.version || null }
}

async function extractUpdate(home, archive, destination, expectedVersion) {
  const require = createRequire(path.join(home, 'app', 'package.json'))
  const unzipper = require('unzipper')
  const directory = await unzipper.Open.file(archive)
  if (directory.files.length > maximumEntries) throw new Error('The update archive has too many entries.')
  const seen = new Set(), roots = new Set()
  let expanded = 0, actual = 0
  await fs.mkdir(destination, { recursive: true })
  for (const entry of directory.files) {
    const relative = safeEntryName(entry.path)
    if (relative === null) throw new Error('Unsafe update archive path.')
    roots.add(entry.path.split('/')[0])
    if (!relative) continue
    const key = relative.toLowerCase()
    if (seen.has(key)) throw new Error('Duplicate update archive entry.')
    seen.add(key)
    const mode = (entry.externalFileAttributes >>> 16) & 0o170000
    if (mode && mode !== 0o100000 && mode !== 0o040000) throw new Error('Linked archive entries are not supported.')
    expanded += entry.uncompressedSize
    if (expanded > maximumExpanded) throw new Error('The extracted update exceeds the safe limit.')
    const target = path.join(destination, ...relative.split('/'))
    if (entry.type === 'Directory') { await fs.mkdir(target, { recursive: true }); continue }
    await fs.mkdir(path.dirname(target), { recursive: true })
    const limit = new Transform({ transform(chunk, encoding, callback) {
      actual += chunk.length
      callback(actual > maximumExpanded ? new Error('The extracted update exceeds the safe limit.') : null, chunk)
    } })
    await pipeline(entry.stream(), limit, createWriteStream(target, { flags: 'wx' }))
  }
  if (roots.size !== 1) throw new Error('The update must contain exactly one package root.')
  const manifest = await readJson(path.join(destination, 'app', 'package.json'))
  if (manifest?.name !== 'stellantis-vehicle-manager' || manifest.version !== expectedVersion) throw new Error('Package identity/version does not match the published release.')
  await fs.access(path.join(destination, 'app', 'dist-server', 'server', 'main.js'))
  await fs.access(path.join(destination, 'app', 'dist', 'index.html'))
}

export async function downloadUpdate(home) {
  const current = await currentVersion(home)
  const pending = await readJson(path.join(home, 'pending.json'))
  const latest = await discoverLatest()
  if (!newerVersion(latest.version, current)) return { version: null, downloaded: pending?.version || null }
  const updating = path.join(home, '.updates')
  const temporary = path.join(updating, `download-${randomUUID()}.zip`)
  const stage = path.join(updating, `stage-${randomUUID()}`)
  const destination = path.join(updating, 'versions', latest.version)
  let size = 0
  try {
    await fs.mkdir(updating, { recursive: true })
    const response = await githubFetch(latest.url)
    const limit = new Transform({ transform(chunk, encoding, callback) {
      size += chunk.length
      callback(size > latest.size ? new Error('Update package size mismatch.') : null, chunk)
    } })
    await pipeline(response.body, limit, createWriteStream(temporary, { flags: 'wx' }))
    if (size !== latest.size) throw new Error('Update package size mismatch.')
    if (await hashFile(temporary) !== latest.sha256) throw new Error('Update package checksum mismatch.')
    await extractUpdate(home, temporary, stage, latest.version)
    await fs.writeFile(path.join(stage, '.package-sha256'), latest.sha256)
    await fs.rm(destination, { recursive: true, force: true })
    await fs.mkdir(path.dirname(destination), { recursive: true })
    await fs.rename(stage, destination)
    await atomicJson(path.join(home, 'pending.json'), { version: latest.version, fileName: latest.fileName, size: latest.size, sha256: latest.sha256, created: new Date().toISOString() })
    return { version: latest.version, downloaded: latest.version }
  } finally {
    await fs.rm(temporary, { force: true })
    await fs.rm(stage, { recursive: true, force: true })
  }
}

async function inventory(directory, relative = '', files = []) {
  for (const entry of await fs.readdir(path.join(directory, relative), { withFileTypes: true })) {
    const name = path.join(relative, entry.name)
    if (entry.isSymbolicLink() || (!entry.isFile() && !entry.isDirectory())) throw new Error('Linked data entries are not supported.')
    if (entry.isDirectory()) await inventory(directory, name, files)
    else files.push(name)
  }
  return files
}

export async function verifiedCopy(source, destination) {
  const sourceStat = await fs.lstat(source)
  if (sourceStat.isSymbolicLink() || !sourceStat.isDirectory()) throw new Error('A real data directory is required.')
  const files = await inventory(source)
  await fs.mkdir(destination, { recursive: true })
  for (const file of files) {
    const target = path.join(destination, file)
    await fs.mkdir(path.dirname(target), { recursive: true })
    await fs.copyFile(path.join(source, file), target, 1)
    if (await hashFile(path.join(source, file)) !== await hashFile(target)) throw new Error('Data backup verification failed.')
  }
  return files.length
}

function alive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false
  try { process.kill(pid, 0); return true } catch { return false }
}

async function waitForServiceStop(dataDir, timeout = 180000) {
  const stateFile = path.join(dataDir, 'service.json')
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const state = await readJson(stateFile)
    if (!state) return
    if (!alive(Number(state.pid))) { await fs.rm(stateFile, { force: true }); return }
    await new Promise(resolve => setTimeout(resolve, 200))
  }
  throw new Error('The local service did not stop in time; the update was not installed.')
}

async function waitForServiceVersion(dataDir, version, timeout = 180000) {
  const stateFile = path.join(dataDir, 'service.json')
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const state = await readJson(stateFile)
    if (state && state.version === version && alive(Number(state.pid))) {
      try {
        const response = await fetch(`http://127.0.0.1:${state.port}/api/bootstrap`, { signal: AbortSignal.timeout(1500) })
        if (response.ok) return state
      } catch { }
    }
    await new Promise(resolve => setTimeout(resolve, 200))
  }
  throw new Error('The updated application did not start in time.')
}

async function replaceLauncherFiles(home, staged) {
  for (const name of ['update.mjs', 'launcher.mjs']) {
    const source = path.join(staged, name), target = path.join(home, name)
    if (await hashFile(source).catch(() => null) === await hashFile(target).catch(() => null)) continue
    await fs.copyFile(source, target).catch(error => { if (!['EPERM', 'EACCES', 'EBUSY'].includes(error.code)) throw error })
  }
}

async function pruneBackups(home, keep = 3) {
  const directory = path.join(home, 'backups')
  const entries = await fs.readdir(directory).catch(() => [])
  const ordered = entries.sort().reverse()
  for (const name of ordered.slice(keep)) await fs.rm(path.join(directory, name), { recursive: true, force: true }).catch(() => {})
}

function relaunch(home, dataDir) {
  const child = spawn(path.join(home, 'runtime', 'node.exe'), [path.join(home, 'launcher.mjs')], {
    cwd: home, detached: true, stdio: 'ignore', windowsHide: true,
    env: { ...process.env, VEHICLE_MANAGER_PROGRAM_DIR: home, VEHICLE_MANAGER_DATA_DIR: dataDir, VEHICLE_MANAGER_UPDATE_LOCK_OWNER: String(process.pid) },
  })
  child.unref()
}

export async function installUpdate(home, dataDir, version) {
  const pending = await readJson(path.join(home, 'pending.json'))
  if (!pending || pending.version !== version) throw new Error('The prepared update is no longer available.')
  const staged = path.join(home, '.updates', 'versions', version)
  const stagedApp = path.join(staged, 'app')
  const manifest = await readJson(path.join(stagedApp, 'package.json'))
  if (manifest?.name !== 'stellantis-vehicle-manager' || manifest.version !== version) throw new Error('The downloaded package does not match the prepared version.')
  await fs.access(path.join(stagedApp, 'dist-server', 'server', 'main.js'))
  await fs.access(path.join(stagedApp, 'dist', 'index.html'))
  const current = await currentVersion(home)
  if (!newerVersion(version, current)) throw new Error('The prepared update would not upgrade this installation.')
  await waitForServiceStop(dataDir)

  const lock = `${dataDir}.update-lock`
  await fs.writeFile(lock, String(process.pid), { flag: 'wx' }).catch(error => { if (error.code !== 'EEXIST') throw error })
  const transaction = `${new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14)}-${randomUUID().slice(0, 8)}`
  const backupDirectory = path.join(home, 'backups', transaction)
  const installed = path.join(home, 'app'), previous = path.join(home, `app.previous-${transaction}`)
  try {
    await verifiedCopy(dataDir, path.join(backupDirectory, 'data'))
    await atomicJson(path.join(backupDirectory, 'backup-complete.json'), { source: dataDir, created: new Date().toISOString() })
    await fs.rename(installed, previous)
    try { await fs.rename(stagedApp, installed) }
    catch (error) { await fs.rename(previous, installed); throw error }
    await replaceLauncherFiles(home, staged)
    await fs.rm(path.join(home, 'pending.json'), { force: true })
    relaunch(home, dataDir)
    try { await waitForServiceVersion(dataDir, version) }
    catch (error) {
      await fs.rename(installed, path.join(home, `app.failed-${transaction}`)).catch(() => {})
      await fs.rename(previous, installed)
      await atomicJson(path.join(backupDirectory, 'rollback.json'), { target: version, previous: current, error: String(error.message), created: new Date().toISOString() })
      relaunch(home, dataDir)
      throw error
    }
    await fs.rm(previous, { recursive: true, force: true }).catch(() => {})
    await pruneBackups(home)
    await fs.rm(staged, { recursive: true, force: true }).catch(() => {})
    await fs.appendFile(path.join(home, 'launcher.log'), `${new Date().toISOString()} Updated ${current} to ${version}\n`).catch(() => {})
    return { from: current, to: version, backup: path.join(backupDirectory, 'data') }
  } finally {
    await fs.rm(lock, { force: true }).catch(() => {})
  }
}
