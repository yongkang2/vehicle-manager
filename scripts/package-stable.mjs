import { promises as fs } from 'node:fs'
import { generateKeyPairSync, sign, createPublicKey } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import os from 'node:os'
import semver from 'semver'
import { atomicJson, hashFile, isPreviewVersion, updateChannel, updateManifestName } from '../stable-update.mjs'

const root = path.resolve(import.meta.dirname, '..')
const manifest = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'))
const index = process.argv.indexOf('--version')
const version = index >= 0 ? process.argv[index + 1] : `${manifest.version}-pre.1`
if (!semver.valid(version) || !isPreviewVersion(version)) throw new Error('This branch only builds pre-release versions, for example 1.1.0-pre.1.')
const keyDirectory = process.env.VEHICLE_MANAGER_SIGNING_DIRECTORY || path.join(os.homedir(), 'Documents', 'Work Files', '01 Projects', 'VehicleManager Pre Update Signing')
await fs.mkdir(keyDirectory, { recursive: true })
const privateFile = path.join(keyDirectory, 'update-private.pem'), publicFile = path.join(keyDirectory, 'update-public.pem')
let privateKey
try { privateKey = await fs.readFile(privateFile, 'utf8') }
catch (error) {
  if (error.code !== 'ENOENT') throw error
  const keys = generateKeyPairSync('ed25519', { privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } })
  await fs.writeFile(privateFile, keys.privateKey, { flag: 'wx', mode: 0o600 })
  privateKey = keys.privateKey
  console.log('Created developer-only update signing key. Keep it private and retain it for future releases.')
}
await fs.writeFile(publicFile, createPublicKey(privateKey).export({ type: 'spki', format: 'pem' }))
const result = spawnSync(process.execPath, ['scripts/package.mjs'], {
  cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], maxBuffer: 8 * 1024 * 1024,
  env: { ...process.env, VEHICLE_MANAGER_PACKAGE_VERSION: version, VEHICLE_MANAGER_UPDATE_PUBLIC_KEY_FILE: publicFile },
})
process.stdout.write(result.stdout || '')
if (result.error) throw result.error
if (result.status !== 0) throw new Error(`Portable packaging failed (${result.status}).`)
const portable = JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1))
const output = path.join(root, 'releases', 'pre')
await fs.mkdir(output, { recursive: true })
const fileName = path.basename(portable.zip)
await fs.copyFile(portable.zip, path.join(output, fileName))
const payload = { application: 'vehicle-manager', platform: 'win-x64', channel: updateChannel, version, fileName, sha256: await hashFile(portable.zip), size: (await fs.stat(portable.zip)).size }
await atomicJson(path.join(output, updateManifestName), { payload, signature: sign(null, Buffer.from(JSON.stringify(payload)), privateKey).toString('base64') })
console.log(JSON.stringify({ version, channel: updateChannel, tag: `stable-launcher-v${version}`, folder: portable.folder, zip: path.join(output, fileName), manifest: path.join(output, updateManifestName), signingDirectory: keyDirectory }))