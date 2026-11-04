import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

test('version checker validates source and rejects independent package versions', () => {
  const checker = fileURLToPath(new URL('../scripts/check-version.mjs', import.meta.url))
  assert.doesNotThrow(() => execFileSync(process.execPath, [checker], { stdio: 'pipe' }))
  for (const env of [{ VEHICLE_MANAGER_PACKAGE_VERSION: '9.9.9' }, { VEHICLE_MANAGER_RELEASE_VERSION: '9.9.9' }]) {
    assert.throws(() => execFileSync(process.execPath, [checker], { env: { ...process.env, ...env }, stdio: 'pipe' }))
  }
  assert.throws(() => execFileSync(process.execPath, [checker, '--version', '9.9.9'], { stdio: 'pipe' }))
})

test('version checker rejects stale source, lockfile and built versions', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'vehicle-version-'))
  try {
    for (const directory of ['scripts', 'shared', 'dist-server/shared']) mkdirSync(path.join(root, directory), { recursive: true })
    copyFileSync(new URL('../scripts/check-version.mjs', import.meta.url), path.join(root, 'scripts/check-version.mjs'))
    const files: Record<string, string> = {
      'package.json': JSON.stringify({ version: '1.2.2' }),
      'package-lock.json': JSON.stringify({ version: '1.2.2', packages: { '': { version: '1.2.2' } } }),
      'shared/version.ts': "export const appVersion = '1.2.2'",
      'dist-server/shared/version.js': "export const appVersion = '1.2.2'",
    }
    for (const [name, value] of Object.entries(files)) writeFileSync(path.join(root, name), value)
    const check = () => execFileSync(process.execPath, [path.join(root, 'scripts/check-version.mjs'), '--built'], { stdio: 'pipe' })
    assert.doesNotThrow(check)
    for (const name of ['package-lock.json', 'shared/version.ts', 'dist-server/shared/version.js']) {
      writeFileSync(path.join(root, name), files[name].replaceAll('1.2.2', '1.2.1'))
      assert.throws(check)
      writeFileSync(path.join(root, name), files[name])
    }
  } finally { rmSync(root, { recursive: true, force: true }) }
})
