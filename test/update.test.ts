import { test } from 'node:test'
import assert from 'node:assert/strict'
import { compareVersions, newerVersion, parseVersion, safeEntryName, selectRelease, updateAsset } from '../update.mjs'

test('release versions compare numerically and reject unsupported formats', () => {
  assert.deepEqual(parseVersion('1.10.2'), [1, 10, 2])
  assert.equal(parseVersion('1.1.0-pre.1'), null)
  assert.equal(parseVersion('v1.1.0'), null)
  assert.equal(compareVersions('1.10.0', '1.9.0'), 1)
  assert.equal(compareVersions('1.9.0', '1.10.0'), -1)
  assert.equal(compareVersions('2.0.0', '2.0.0'), 0)
  assert.equal(newerVersion('1.1.1', '1.1.0'), true)
  assert.equal(newerVersion('1.1.0', '1.1.0'), false)
  assert.equal(newerVersion('1.0.9', '1.1.0'), false)
  assert.equal(newerVersion('latest', '1.1.0'), false)
  assert.throws(() => compareVersions('1.1', '1.1.0'), /Unsupported version/)
})

test('release selection ignores preview channels, drafts and unversioned tags', () => {
  const release = (tag_name: string, prerelease = false, draft = false) => ({ tag_name, prerelease, draft })
  const selected = selectRelease([
    release('v1.0.3'),
    release('v1.1.0', true),
    release('stable-launcher-v9.9.9-pre.1', true),
    release('v2.0.0', false, true),
    release('v1.10.0'),
    release('nightly'),
    release('v1.9.0'),
  ])
  assert.equal(selected?.tag_name, 'v1.10.0')
  assert.equal(selectRelease([release('v1.1.0', true)]), null)
  assert.equal(selectRelease([]), null)
  assert.throws(() => selectRelease(null), /Invalid GitHub release list/)
})

test('the update asset needs a bounded Windows package and a checksum', () => {
  const asset = { name: 'vehicle-manager-1.1.1-win-x64-20261030010101.zip', size: 1024, browser_download_url: 'https://github.com/x/y/releases/download/v1.1.1/pkg.zip', digest: `sha256:${'a'.repeat(64)}` }
  assert.deepEqual(updateAsset({ assets: [asset] }), { name: asset.name, size: 1024, url: asset.browser_download_url, sha256: 'a'.repeat(64) })
  assert.equal(updateAsset({ assets: [{ ...asset, digest: null }] })?.sha256, null)
  assert.equal(updateAsset({ assets: [{ ...asset, name: 'notes.txt' }] }), null)
  assert.equal(updateAsset({ assets: [{ ...asset, size: 0 }] }), null)
  assert.equal(updateAsset({}), null)
})

test('archive entries are validated before extraction', () => {
  assert.equal(safeEntryName('vehicle-manager-1.1.1-win-x64-20261030010101/app/package.json'), 'app/package.json')
  assert.equal(safeEntryName('vehicle-manager-1.1.1-win-x64-20261030010101/'), '')
  assert.equal(safeEntryName('vehicle-manager-x/../app/package.json'), null)
  assert.equal(safeEntryName('vehicle-manager-x/app\\package.json'), null)
  assert.equal(safeEntryName('/vehicle-manager-x/app/package.json'), null)
  assert.equal(safeEntryName('vehicle-manager-x/app/package.json:stream'), null)
  assert.equal(safeEntryName('vehicle-manager-x/app/con.txt'), null)
  assert.equal(safeEntryName('vehicle-manager-x/app/package.json.'), null)
  assert.equal(safeEntryName('other-root/app/package.json'), null)
})
