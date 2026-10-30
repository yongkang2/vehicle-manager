import { test } from 'node:test'
import assert from 'node:assert/strict'
import { generateKeyPairSync, sign } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { createWriteStream } from 'node:fs'
import { ZipArchive } from 'archiver'
import { createRequire } from 'node:module'
import { copyLauncherDependencies } from '../stable-launcher.mjs'
import { verifyManifest, newerVersion, verifiedCopy, extractPackage, selectPreviewRelease } from '../stable-update.mjs'

test('stable updates require a trusted signature and valid package metadata', () => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const payload = { application: 'vehicle-manager', platform: 'win-x64', channel: 'pre', version: '1.2.0-pre.1', fileName: 'vehicle-manager-1.2.0-pre.1.zip', sha256: 'a'.repeat(64), size: 10 }
  const document = { payload, signature: sign(null, Buffer.from(JSON.stringify(payload)), privateKey).toString('base64') }
  assert.equal(verifyManifest(document, publicKey).version, '1.2.0-pre.1')
  assert.throws(() => verifyManifest({ ...document, payload: { ...payload, version: '9.0.0' } }, publicKey), /signature/)
  const other = generateKeyPairSync('ed25519')
  assert.throws(() => verifyManifest(document, other.publicKey), /signature/)
  const stable = { ...payload, channel: 'stable', version: '1.2.0' }
  assert.throws(() => verifyManifest({ payload: stable, signature: sign(null, Buffer.from(JSON.stringify(stable)), privateKey).toString('base64') }, publicKey), /not supported/)
})

test('pre-channel release selection ignores main releases, drafts and unrelated previews', () => {
  const release = (tag_name: string, prerelease = true, draft = false) => ({ tag_name, prerelease, draft })
  const selected = selectPreviewRelease([
    release('v99.0.0', false),
    release('stable-launcher-v8.0.0-pre.1', true, true),
    release('another-feature-v9.0.0-pre.1'),
    release('stable-launcher-v1.2.0-pre.2'),
    release('stable-launcher-v1.2.0-pre.10'),
    release('stable-launcher-v2.0.0', false),
  ])
  assert.equal(selected?.tag_name, 'stable-launcher-v1.2.0-pre.10')
  assert.equal(selectPreviewRelease([release('v99.0.0', false)]), null)
})

test('stable version checks reject downgrades and compare multi-digit versions correctly', () => {
  assert.equal(newerVersion('1.10.0', '1.9.0'), true)
  assert.equal(newerVersion('1.9.0', '1.10.0'), false)
  assert.equal(newerVersion('1.1.0', '1.1.0'), false)
  assert.equal(newerVersion('../other', '1.1.0'), false)
})

test('cold backups preserve nested originals and reject linked data entries', async () => {
  const root = await fs.mkdtemp(path.join(import.meta.dirname, 'test-data-'))
  try {
    const data = path.join(root, 'data')
    await fs.mkdir(path.join(data, 'originals'), { recursive: true })
    await fs.writeFile(path.join(data, 'originals', 'report.bin'), 'original bytes')
    assert.equal(await verifiedCopy(data, path.join(root, 'backup')), 1)
    assert.equal(await fs.readFile(path.join(root, 'backup', 'originals', 'report.bin'), 'utf8'), 'original bytes')
    await fs.symlink(path.join(root, 'backup'), path.join(data, 'linked'), 'junction')
    await assert.rejects(verifiedCopy(data, path.join(root, 'unsafe-backup')), /Linked/)
  } finally { await fs.rm(root, { recursive: true, force: true }) }
})

test('signed archives cannot extract traversal paths or a mismatched application', async () => {
  const root = await fs.mkdtemp(path.join(import.meta.dirname, 'test-data-'))
  async function archive(file: string, entries: Record<string, string>) {
    const output = createWriteStream(file), zip = new ZipArchive()
    const complete = new Promise<void>((resolve, reject) => { output.once('close', resolve); output.once('error', reject); zip.once('error', reject) })
    zip.pipe(output)
    for (const [name, content] of Object.entries(entries)) zip.append(content, { name })
    await zip.finalize(); await complete
  }
  try {
    const zip = path.join(root, 'update.zip')
    await archive(zip, { 'vehicle-manager-1.2.0/app/package.json': JSON.stringify({ name: 'another-app', version: '1.2.0' }) })
    await assert.rejects(extractPackage(zip, path.join(root, 'output'), '1.2.0'), /identity/)
    const unsafe = path.join(root, 'unsafe.zip')
    await archive(unsafe, { 'vehicle-manager-1.2.0/C:outside.txt': 'unsafe' })
    await assert.rejects(extractPackage(unsafe, path.join(root, 'unsafe-output'), '1.2.0'), /Unsafe/)
  } finally { await fs.rm(root, { recursive: true, force: true }) }
})

test('the pre launcher copies only its own complete dependency graph', async () => {
  const root = await fs.mkdtemp(path.join(import.meta.dirname, 'test-data-'))
  try {
    const count = await copyLauncherDependencies(path.resolve(import.meta.dirname, '..'), root)
    assert.ok(count > 1 && count < 30)
    const require = createRequire(path.join(root, 'app', 'package.json'))
    assert.equal(require('semver').valid('1.1.0-pre.1'), '1.1.0-pre.1')
    assert.equal(typeof require('unzipper').Open.file, 'function')
    await assert.rejects(fs.access(path.join(root, 'node_modules', 'react')))
  } finally { await fs.rm(root, { recursive: true, force: true }) }
})