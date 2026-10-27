import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

type ServiceState = { pid?: number; port?: number }

async function hashFile(filename: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(filename)) hash.update(chunk)
  return hash.digest('hex')
}

function processAlive(pid: unknown): boolean {
  if (!Number.isSafeInteger(pid) || Number(pid) <= 0) return false
  try { process.kill(Number(pid), 0); return true } catch { return false }
}

async function fileInventory(directory: string): Promise<Map<string, { size: number; hash: string }>> {
  const result = new Map<string, { size: number; hash: string }>()
  async function visit(current: string, relative = ''): Promise<void> {
    for (const entry of await fs.readdir(current, { withFileTypes: true })) {
      const child = path.join(current, entry.name), name = path.join(relative, entry.name)
      if (entry.isDirectory()) await visit(child, name)
      else if (entry.isFile()) {
        const stat = await fs.stat(child)
        result.set(name, { size: stat.size, hash: await hashFile(child) })
      } else throw new Error('Local data contains an unsupported filesystem entry.')
    }
  }
  await visit(directory)
  return result
}

async function legacyDataDirectory(projectRoot: string): Promise<string> {
  const local = path.join(projectRoot, 'data')
  const localEntries = await fs.readdir(local).catch(error => error.code === 'ENOENT' ? null : Promise.reject(error))
  if (localEntries?.length || !/^vehicle-manager-/i.test(path.basename(projectRoot))) return local
  const siblings = await fs.readdir(path.dirname(projectRoot), { withFileTypes: true })
  const candidates: string[] = []
  for (const entry of siblings) {
    if (!entry.isDirectory() || !/^vehicle-manager-/i.test(entry.name) || path.resolve(path.dirname(projectRoot), entry.name) === path.resolve(projectRoot)) continue
    const candidate = path.join(path.dirname(projectRoot), entry.name, 'data')
    if (await fs.stat(path.join(candidate, 'local.sqlite')).then(stat => stat.isFile()).catch(() => false)) candidates.push(candidate)
  }
  if (candidates.length > 1) throw new Error('Multiple previous release data directories were found. Stop both versions, then copy the intended data/ folder into this release folder and start again.')
  return candidates[0] || local
}

export async function resolveDataDirectory(projectRoot: string): Promise<string> {
  const override = process.env.VEHICLE_MANAGER_DATA_DIR
  if (override) {
    const resolved = path.resolve(override)
    await fs.mkdir(resolved, { recursive: true })
    return resolved
  }
  const local = process.env.LOCALAPPDATA || (process.platform === 'win32' ? path.join(os.homedir(), 'AppData', 'Local') : path.join(os.homedir(), '.local', 'share'))
  const destination = path.join(local, 'VehicleManager', 'data')
  const marker = path.join(destination, '.data-migrated')
  const destinationEntries = await fs.readdir(destination).catch(error => error.code === 'ENOENT' ? null : Promise.reject(error))
  if (destinationEntries?.includes(path.basename(marker))) return destination
  const legacy = await legacyDataDirectory(projectRoot)
  const legacyEntries = await fs.readdir(legacy).catch(error => error.code === 'ENOENT' ? null : Promise.reject(error))
  if (!legacyEntries?.length) {
    await fs.mkdir(destination, { recursive: true })
    await fs.writeFile(marker, JSON.stringify({ source: null, created: new Date().toISOString() }), { flag: 'wx' }).catch(error => { if (error.code !== 'EEXIST') throw error })
    return destination
  }
  if (destinationEntries?.length) throw new Error('Both the new local data directory and legacy data directory contain files. Resolve them before starting to avoid splitting this device identity.')
  const lockOwner = await fs.readFile(path.join(legacy, '.launch-lock', 'owner.json'), 'utf8').then(text => JSON.parse(text) as ServiceState).catch(() => null)
  if (lockOwner && processAlive(lockOwner.pid)) throw new Error('The old application is starting with this local data. Wait for it to finish, stop it with its matching Stop.cmd, then retry.')
  const state = await fs.readFile(path.join(legacy, 'service.json'), 'utf8').then(text => JSON.parse(text) as ServiceState).catch(() => null)
  if (state && processAlive(state.pid)) throw new Error('The old application is still running with this local data. Stop it with its matching Stop.cmd, then start the updated application again.')
  await fs.mkdir(path.dirname(destination), { recursive: true })
  const temporary = `${destination}.migration-${randomUUID()}`
  const legacyBackup = `${legacy}.migrated-backup-${new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14)}-${randomUUID().slice(0, 8)}`
  let legacyArchived = false
  try {
    await fs.cp(legacy, temporary, { recursive: true, errorOnExist: true, force: false })
    const [sourceFiles, copiedFiles] = await Promise.all([fileInventory(legacy), fileInventory(temporary)])
    if (sourceFiles.size !== copiedFiles.size || [...sourceFiles].some(([name, file]) => JSON.stringify(file) !== JSON.stringify(copiedFiles.get(name)))) throw new Error('The local data migration did not verify; the original data was left untouched.')
    await fs.rename(legacy, legacyBackup); legacyArchived = true
    await fs.rm(path.join(temporary, 'service.json'), { force: true })
    await fs.rm(path.join(temporary, '.launch-lock'), { recursive: true, force: true })
    await fs.writeFile(path.join(temporary, '.data-migrated'), JSON.stringify({ source: path.resolve(legacy), backup: path.resolve(legacyBackup), created: new Date().toISOString() }), { flag: 'wx' })
    await fs.rename(temporary, destination)
  } catch (error) {
    await fs.rm(temporary, { recursive: true, force: true }).catch(() => {})
    if (legacyArchived) await fs.rename(legacyBackup, legacy).catch(() => {})
    throw error
  }
  return destination
}