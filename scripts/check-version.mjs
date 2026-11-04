import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = file => readFileSync(path.join(project, file), 'utf8')
const run = (command, args) => execFileSync(command, args, { cwd: project, encoding: 'utf8', windowsHide: true }).trim()
const { version } = JSON.parse(read('package.json'))
assert.match(version, /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/)
assert.ok(!process.env.VEHICLE_MANAGER_PACKAGE_VERSION && !process.env.VEHICLE_MANAGER_RELEASE_VERSION, 'Independent version overrides are forbidden; change package.json instead.')
assert.ok(!process.argv.includes('--version'), 'Independent --version overrides are forbidden.')
const lock = JSON.parse(read('package-lock.json'))
assert.equal(lock.version, version, 'Lockfile version differs')
assert.equal(lock.packages[''].version, version, 'Lockfile root version differs')
assert.match(read('shared/version.ts'), new RegExp(`export const appVersion = '${version.replaceAll('.', '\\.')}'`))
if (process.argv.includes('--built')) {
  assert.match(read('dist-server/shared/version.js'), new RegExp(`export const appVersion = ['"]${version.replaceAll('.', '\\.')}['"]`))
}
if (process.argv.includes('--release')) {
  assert.equal(run('git', ['status', '--porcelain', '--untracked-files=no']), '', 'Commit tracked changes before packaging a release')
  const latest = JSON.parse(run('gh', ['api', 'repos/yongkang2/vehicle-manager/releases/latest']))
  const newer = (left, right) => {
    const a = left.split('.').map(Number), b = right.split('.').map(Number)
    for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i]
    return false
  }
  assert.ok(newer(version, latest.tag_name.replace(/^v/, '')), 'Release version must exceed the latest published version')
  assert.equal(run('git', ['ls-remote', 'origin', `refs/tags/v${version}`]), '', 'Release tag already exists')
  run('git', ['fetch', 'origin', `refs/tags/${latest.tag_name}`])
  run('git', ['merge-base', '--is-ancestor', 'FETCH_HEAD', 'HEAD'])
}
console.log(`Version consistency passed: ${version}`)
