import { createHash, verify, randomUUID } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'

const require = createRequire(new URL('./app/package.json', import.meta.url))
const semver = require('semver')
const unzipper = require('unzipper')
const maximumArchive = 512 * 1024 * 1024
const maximumExpanded = 1024 * 1024 * 1024
const allowedHosts = new Set(['api.github.com', 'github.com', 'objects.githubusercontent.com', 'release-assets.githubusercontent.com'])
export const updateChannel = 'pre'
export const updateManifestName = 'vehicle-manager-update-pre.json'
export function isPreviewVersion(version) {
  return typeof version === 'string' && /^\d+\.\d+\.\d+-pre\.\d+$/.test(version) && Boolean(semver.valid(version))
}
export function selectPreviewRelease(releases) {
  if (!Array.isArray(releases)) throw new Error('Invalid GitHub release list.')
  return releases.filter(release => !release.draft && release.prerelease === true
    && typeof release.tag_name === 'string' && release.tag_name.startsWith('stable-launcher-v')
    && isPreviewVersion(release.tag_name.slice('stable-launcher-v'.length)))
    .sort((left, right) => semver.rcompare(left.tag_name.slice('stable-launcher-v'.length), right.tag_name.slice('stable-launcher-v'.length)))[0] || null
}

export async function atomicJson(file, value) {
  const temporary = `${file}.${randomUUID()}.tmp`
  try { await fs.writeFile(temporary, JSON.stringify(value), { flag: 'wx' }); await fs.rename(temporary, file) }
  finally { await fs.rm(temporary, { force: true }) }
}
export async function hashFile(file) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(file)) hash.update(chunk)
  return hash.digest('hex')
}
export function newerVersion(candidate, current) {
  return Boolean(semver.valid(candidate) && semver.valid(current) && semver.gt(candidate, current))
}
export function verifyManifest(document, publicKey) {
  const payload = document?.payload
  if (!payload || document.signature?.length > 1024 || typeof document.signature !== 'string'
    || !verify(null, Buffer.from(JSON.stringify(payload)), publicKey, Buffer.from(document.signature, 'base64'))) throw new Error('The update manifest signature is invalid.')
  if (payload.application !== 'vehicle-manager' || payload.platform !== 'win-x64' || payload.channel !== updateChannel || !isPreviewVersion(payload.version)
    || !/^vehicle-manager-[a-zA-Z0-9._-]+\.zip$/.test(payload.fileName) || !/^[a-f0-9]{64}$/.test(payload.sha256)
    || !Number.isSafeInteger(payload.size) || payload.size <= 0 || payload.size > maximumArchive) throw new Error('The signed update manifest is not supported.')
  return payload
}
async function githubFetch(address) {
  for (let count = 0; count < 6; count++) {
    const url = new URL(address)
    if (url.protocol !== 'https:' || !allowedHosts.has(url.hostname) || url.username || url.password) throw new Error('Untrusted update download address.')
    const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(300000), headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'VehicleManager-StableLauncher' } })
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
async function smallJson(response) {
  let bytes = 0
  const chunks = []
  for await (const chunk of response.body) {
    bytes += chunk.length
    if (bytes > 1024 * 1024) throw new Error('Update metadata is too large.')
    chunks.push(chunk)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}
export async function discoverUpdate(config) {
  if (config.channel && config.channel !== updateChannel) throw new Error('This launcher only accepts the isolated pre-release channel.')
  let document, asset
  if (config.localFeed) {
    if (!path.isAbsolute(config.localFeed)) throw new Error('The local update feed must be absolute.')
    const manifestFile = path.join(config.localFeed, updateManifestName)
    if ((await fs.stat(manifestFile)).size > 1024 * 1024) throw new Error('Update metadata is too large.')
    document = JSON.parse(await fs.readFile(manifestFile, 'utf8'))
  } else {
    const releases = await smallJson(await githubFetch('https://api.github.com/repos/yongkang2/vehicle-manager/releases?per_page=100'))
    const release = selectPreviewRelease(releases)
    if (!release) throw new Error('No published stable-launcher pre-release is available.')
    const manifest = release.assets?.find(item => item.name === updateManifestName)
    if (!manifest) throw new Error('This pre-release has no pre-channel update manifest.')
    document = await smallJson(await githubFetch(manifest.browser_download_url))
    if (document.payload?.version !== release.tag_name.slice('stable-launcher-v'.length)) throw new Error('Pre-release tag and manifest versions differ.')
    asset = release.assets
  }
  const payload = verifyManifest(document, config.publicKey)
  const source = config.localFeed ? path.join(config.localFeed, payload.fileName) : asset?.find(item => item.name === payload.fileName)?.browser_download_url
  if (!source) throw new Error('The signed update package is missing.')
  return { payload, source, document }
}
export async function extractPackage(archive, destination, expectedVersion) {
  const directory = await unzipper.Open.file(archive)
  if (directory.files.length > 100000) throw new Error('The update archive has too many entries.')
  const seen = new Set(), roots = new Set()
  let expanded = 0, actual = 0
  for (const entry of directory.files) {
    const name = entry.path
    const pieces = name.split('/')
    if (name.includes('\\') || name.includes(':') || name.includes('\0') || name.startsWith('/') || pieces.some(piece => piece === '..' || piece === '.')) throw new Error('Unsafe update archive path.')
    if (pieces.filter(Boolean).some(piece => /[. ]$/.test(piece) || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(piece))) throw new Error('Unsafe Windows update archive path.')
    if (!/^vehicle-manager-[a-zA-Z0-9._-]+$/.test(pieces[0])) throw new Error('Unexpected package root.')
    roots.add(pieces.shift())
    const relative = pieces.join('/').replace(/\/$/, '')
    if (!relative) continue
    const key = relative.toLowerCase()
    if (seen.has(key)) throw new Error('Duplicate update archive entry.')
    seen.add(key)
    const mode = (entry.externalFileAttributes >>> 16) & 0o170000
    if (mode && mode !== 0o100000 && mode !== 0o040000) throw new Error('Linked archive entries are not supported.')
    expanded += entry.uncompressedSize
    if (expanded > maximumExpanded) throw new Error('The extracted update exceeds the safe limit.')
    const target = path.join(destination, ...pieces)
    if (entry.type === 'Directory') { await fs.mkdir(target, { recursive: true }); continue }
    await fs.mkdir(path.dirname(target), { recursive: true })
    const limit = new Transform({ transform(chunk, encoding, callback) {
      actual += chunk.length
      callback(actual > maximumExpanded ? new Error('The extracted update exceeds the safe limit.') : null, chunk)
    } })
    await pipeline(entry.stream(), limit, createWriteStream(target, { flags: 'wx' }))
  }
  if (roots.size !== 1) throw new Error('The update must contain exactly one package root.')
  const manifest = JSON.parse(await fs.readFile(path.join(destination, 'app', 'package.json'), 'utf8'))
  if (manifest.name !== 'stellantis-vehicle-manager' || manifest.version !== expectedVersion) throw new Error('Package identity/version does not match the signed manifest.')
  await fs.access(path.join(destination, 'app', 'dist-server', 'server', 'main.js'))
  await fs.access(path.join(destination, 'app', 'dist', 'index.html'))
}
export async function downloadUpdate(config, currentVersion, home) {
  const update = await discoverUpdate(config)
  if (!newerVersion(update.payload.version, currentVersion)) return null
  const temporary = path.join(home, `download-${randomUUID()}.zip`)
  const stage = path.join(home, 'versions', `.staging-${randomUUID()}`)
  let size = 0
  try {
    const source = config.localFeed ? createReadStream(update.source) : (await githubFetch(update.source)).body
    const limit = new Transform({ transform(chunk, encoding, callback) {
      size += chunk.length
      callback(size > update.payload.size ? new Error('Update package size mismatch.') : null, chunk)
    } })
    await pipeline(source, limit, createWriteStream(temporary, { flags: 'wx' }))
    if (size !== update.payload.size || await hashFile(temporary) !== update.payload.sha256) throw new Error('Update package checksum/size mismatch.')
    await fs.mkdir(stage, { recursive: true })
    await extractPackage(temporary, stage, update.payload.version)
    const destination = path.join(home, 'versions', update.payload.version)
    await fs.writeFile(path.join(stage, '.package-sha256'), update.payload.sha256)
    const previousHash = await fs.readFile(path.join(destination, '.package-sha256'), 'utf8').catch(error => { if (error.code === 'ENOENT') return null; throw error })
    if (previousHash === update.payload.sha256) await fs.rm(stage, { recursive: true, force: true })
    else await fs.rename(stage, destination)
    await atomicJson(path.join(home, 'pending.json'), { version: update.payload.version, document: update.document })
    return update.payload.version
  } finally { await fs.rm(temporary, { force: true }); await fs.rm(stage, { recursive: true, force: true }) }
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