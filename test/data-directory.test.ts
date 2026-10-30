import { test } from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { resolveDataDirectory } from '../shared/data-directory.js'

test('local data migration refuses a running old service and preserves files after it stops', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vehicle-data-dir-'))
  const local = path.join(root, 'local'), project = path.join(root, 'release')
  const previousLocal = process.env.LOCALAPPDATA, previousOverride = process.env.VEHICLE_MANAGER_DATA_DIR
  process.env.LOCALAPPDATA = local
  delete process.env.VEHICLE_MANAGER_DATA_DIR
  try {
    const legacy = path.join(project, 'data')
    await fs.mkdir(legacy, { recursive: true })
    await fs.writeFile(path.join(legacy, 'local.sqlite'), 'database bytes')
    await fs.writeFile(path.join(legacy, 'identity.json'), '{"deviceId":"stable-device"}')
    const launchLock = path.join(legacy, '.launch-lock'); await fs.mkdir(launchLock)
    await fs.writeFile(path.join(launchLock, 'owner.json'), JSON.stringify({ pid: process.pid }))
    await assert.rejects(resolveDataDirectory(project), /old application is starting/)
    await fs.rm(launchLock, { recursive: true, force: true })
    await fs.writeFile(path.join(legacy, 'service.json'), JSON.stringify({ pid: process.pid, port: 4410 }))
    await assert.rejects(resolveDataDirectory(project), /old application is still running/)
    await fs.writeFile(path.join(legacy, 'service.json'), JSON.stringify({ pid: 2147483647, port: 4410 }))
    const destination = await resolveDataDirectory(project)
    assert.equal(await fs.readFile(path.join(destination, 'local.sqlite'), 'utf8'), 'database bytes')
    assert.equal(await fs.readFile(path.join(destination, 'identity.json'), 'utf8'), '{"deviceId":"stable-device"}')
    assert.equal(await fs.stat(path.join(destination, 'service.json')).then(() => true, () => false), false)
    await assert.rejects(fs.stat(legacy), { code: 'ENOENT' })
    const archived = (await fs.readdir(project)).find(name => name.startsWith('data.migrated-backup-'))!
    assert.equal(await fs.readFile(path.join(project, archived, 'local.sqlite'), 'utf8'), 'database bytes')
    assert.ok((await fs.readdir(destination)).includes('.data-migrated'))
    assert.equal(await resolveDataDirectory(project), destination)
  } finally {
    if (previousLocal === undefined) delete process.env.LOCALAPPDATA
    else process.env.LOCALAPPDATA = previousLocal
    if (previousOverride === undefined) delete process.env.VEHICLE_MANAGER_DATA_DIR
    else process.env.VEHICLE_MANAGER_DATA_DIR = previousOverride
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('first portable launch finds one adjacent older release data directory', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vehicle-data-sibling-'))
  const local = path.join(root, 'local'), parent = path.join(root, 'releases')
  const previousLocal = process.env.LOCALAPPDATA, previousOverride = process.env.VEHICLE_MANAGER_DATA_DIR
  process.env.LOCALAPPDATA = local
  delete process.env.VEHICLE_MANAGER_DATA_DIR
  try {
    const oldRelease = path.join(parent, 'vehicle-manager-1.0.3-win-x64-old'), newRelease = path.join(parent, 'vehicle-manager-1.1.0-win-x64-new')
    await fs.mkdir(path.join(oldRelease, 'data'), { recursive: true }); await fs.mkdir(newRelease, { recursive: true })
    await fs.writeFile(path.join(oldRelease, 'data', 'local.sqlite'), 'previous release db')
    const destination = await resolveDataDirectory(newRelease)
    assert.equal(await fs.readFile(path.join(destination, 'local.sqlite'), 'utf8'), 'previous release db')
    assert.ok((await fs.readdir(oldRelease)).some(name => name.startsWith('data.migrated-backup-')))
  } finally {
    if (previousLocal === undefined) delete process.env.LOCALAPPDATA
    else process.env.LOCALAPPDATA = previousLocal
    if (previousOverride === undefined) delete process.env.VEHICLE_MANAGER_DATA_DIR
    else process.env.VEHICLE_MANAGER_DATA_DIR = previousOverride
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('first portable launch picks the most recently used old data directory', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vehicle-data-ambiguous-'))
  const local = path.join(root, 'local'), parent = path.join(root, 'releases')
  const previousLocal = process.env.LOCALAPPDATA, previousOverride = process.env.VEHICLE_MANAGER_DATA_DIR
  process.env.LOCALAPPDATA = local
  delete process.env.VEHICLE_MANAGER_DATA_DIR
  try {
    const newRelease = path.join(parent, 'vehicle-manager-1.1.0-win-x64-new')
    await fs.mkdir(newRelease, { recursive: true })
    const older = path.join(parent, 'vehicle-manager-1.0.1-win-x64-first'), newer = path.join(parent, 'vehicle-manager-1.0.2-win-x64-second')
    for (const [name, since] of [[older, '2026-01-05T08:00:00Z'], [newer, '2026-01-09T08:00:00Z']] as const) {
      const data = path.join(name, 'data'); await fs.mkdir(data, { recursive: true })
      const file = path.join(data, 'local.sqlite'); await fs.writeFile(file, name)
      await fs.utimes(file, new Date(since), new Date(since))
    }
    const destination = await resolveDataDirectory(newRelease)
    assert.equal(await fs.readFile(path.join(destination, 'local.sqlite'), 'utf8'), newer)
    const marker = JSON.parse(await fs.readFile(path.join(destination, '.data-migrated'), 'utf8'))
    assert.equal(marker.source, path.resolve(newer, 'data'))
    assert.deepEqual(marker.otherCandidates, [path.resolve(older, 'data')])
  } finally {
    if (previousLocal === undefined) delete process.env.LOCALAPPDATA
    else process.env.LOCALAPPDATA = previousLocal
    if (previousOverride === undefined) delete process.env.VEHICLE_MANAGER_DATA_DIR
    else process.env.VEHICLE_MANAGER_DATA_DIR = previousOverride
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('Windows rename denial keeps the old folder and starts only from the verified copy', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vehicle-data-rename-denied-'))
  const local = path.join(root, 'local'), project = path.join(root, 'release'), legacy = path.join(project, 'data')
  const previousLocal = process.env.LOCALAPPDATA, previousOverride = process.env.VEHICLE_MANAGER_DATA_DIR
  process.env.LOCALAPPDATA = local
  delete process.env.VEHICLE_MANAGER_DATA_DIR
  try {
    await fs.mkdir(legacy, { recursive: true })
    await fs.writeFile(path.join(legacy, 'local.sqlite'), 'verified identity data')
    const renameLegacy = async (source: string, destination: string) => {
      if (source === legacy) throw Object.assign(new Error('directory in use'), { code: 'EPERM' })
      return fs.rename(source, destination)
    }
    const destination = await resolveDataDirectory(project, renameLegacy)
    assert.equal(await fs.readFile(path.join(destination, 'local.sqlite'), 'utf8'), 'verified identity data')
    assert.equal(await fs.readFile(path.join(legacy, 'local.sqlite'), 'utf8'), 'verified identity data')
    const marker = JSON.parse(await fs.readFile(path.join(destination, '.data-migrated'), 'utf8'))
    assert.equal(marker.sourceRetained, true)
    assert.equal(marker.backup, null)
  } finally {
    if (previousLocal === undefined) delete process.env.LOCALAPPDATA
    else process.env.LOCALAPPDATA = previousLocal
    if (previousOverride === undefined) delete process.env.VEHICLE_MANAGER_DATA_DIR
    else process.env.VEHICLE_MANAGER_DATA_DIR = previousOverride
    await fs.rm(root, { recursive: true, force: true })
  }
})