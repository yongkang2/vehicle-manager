import { DatabaseSync } from 'node:sqlite'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { Business, checksum, fromRow, now } from './business.js'
import type { RecordRow } from './business.js'
import { AppError } from './team.js'
import type { DeleteCounts, VehicleDeletion } from '../shared/business.js'
import { isProtectedKind, validateConfigurationRecords, validateConfigurationReceiptEntry } from '../shared/configuration-revisions.js'

export type BusinessHead = { protocol: 1 | 2 | 3; teamId: string; revision: string; sequence: number; checksum: string; created: string }
type AtomicWriter = (destination: string, bytes: Buffer | string) => Promise<void>
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/
const digest = /^[a-f0-9]{64}$/
const markerSchema = 'CREATE TABLE IF NOT EXISTS vehicle_deletions(vehicle_id TEXT PRIMARY KEY,request_id TEXT NOT NULL UNIQUE,payload TEXT NOT NULL)'
const corrupt = () => new AppError('SHARE_CORRUPTED', 409)
async function pruneSnapshots(directory: string, currentRevision: string): Promise<void> {
  const root = path.join(directory, 'snapshots'), files: { name: string; modified: number }[] = []
  for (const name of await fs.readdir(root)) if (name.endsWith('.sqlite')) files.push({ name, modified: (await fs.stat(path.join(root, name))).mtimeMs })
  files.sort((left, right) => right.modified - left.modified || right.name.localeCompare(left.name))
  const keep = new Set(files.slice(0, 30).map(file => file.name))
  keep.add(`${currentRevision}.sqlite`)
  const daily = new Set<string>(), cutoff = Date.now() - 90 * 24 * 60 * 60 * 1000
  for (const file of files) {
    if (file.modified < cutoff) continue
    const day = new Date(file.modified).toISOString().slice(0, 10)
    if (!daily.has(day)) { daily.add(day); keep.add(file.name) }
  }
  for (const file of files) if (!keep.has(file.name)) await fs.rm(path.join(root, file.name), { force: true }).catch(() => {})
}
export function validateVehicleDeletion(value: unknown): VehicleDeletion {
  const marker = value as VehicleDeletion
  if (!marker || !uuid.test(marker.id) || !uuid.test(marker.vehicleId) || !uuid.test(marker.requestId) || typeof marker.vin !== 'string' || !Array.isArray(marker.recordIds) || !marker.recordIds.includes(marker.vehicleId) || marker.recordIds.some(id => typeof id !== 'string' || !id || id.length > 120) || new Set(marker.recordIds).size !== marker.recordIds.length || !Array.isArray(marker.fileKeys) || marker.fileKeys.some(key => !digest.test(key)) || !marker.actor || marker.actor.role !== 'admin' || typeof marker.actor.id !== 'string' || typeof marker.actor.deviceId !== 'string' || typeof marker.reason !== 'string' || !marker.reason.trim() || !Number.isFinite(Date.parse(marker.deletedAt)) || !uuid.test(marker.revision) || !Number.isSafeInteger(marker.sequence) || marker.sequence < 1) throw corrupt()
  return marker
}

export class SharedBusinessSnapshot {
  private constructor(readonly business: Business, readonly directory: string, readonly work: string, private master: DatabaseSync | null, public head: BusinessHead | null, private atomic: AtomicWriter) {}
  get db(): DatabaseSync { if (!this.master) throw corrupt(); return this.master }
  static async open(business: Business, shared: string, teamId: string, atomic: AtomicWriter): Promise<SharedBusinessSnapshot> {
    const directory = path.join(shared, 'business'), local = path.join(business.store.directory, 'sync-work')
    await fs.mkdir(directory, { recursive: true }); await fs.mkdir(local, { recursive: true })
    for (const name of ['snapshots', 'operations', 'blobs']) await fs.mkdir(path.join(directory, name), { recursive: true })
    const work = path.join(local, `${randomUUID()}.sqlite`)
    let master: DatabaseSync | null = null
    try {
      const bytes = await fs.readFile(path.join(directory, 'HEAD.json')).catch(error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error })
      let head: BusinessHead | null = null
      if (bytes) {
        try { head = JSON.parse(bytes.toString()) as BusinessHead } catch { throw corrupt() }
        if (!head || ![1, 2, 3].includes(head.protocol) || head.teamId !== teamId || !uuid.test(head.revision) || !Number.isSafeInteger(head.sequence) || head.sequence < 1 || !digest.test(head.checksum)) throw corrupt()
        const sequence = business.store.get<number>('businessSequence') || 0
        if (head.sequence < sequence || (head.sequence === sequence && business.store.get('businessRevision') !== head.revision) || head.protocol < (business.store.get<number>('businessProtocol') || 1)) throw new AppError('BUSINESS_ROLLBACK', 409)
        const snapshot = await fs.readFile(path.join(directory, 'snapshots', `${head.revision}.sqlite`))
        if (checksum(snapshot) !== head.checksum) throw corrupt()
        await fs.writeFile(work, snapshot, { flag: 'wx' })
        master = new DatabaseSync(work)
        master.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL;')
        if (master.prepare('PRAGMA integrity_check').get()!.integrity_check !== 'ok' || master.prepare("SELECT value FROM metadata WHERE key='teamId'").get()?.value !== teamId || Number(master.prepare("SELECT value FROM metadata WHERE key='sequence'").get()?.value) !== head.sequence || master.prepare('PRAGMA foreign_key_check').all().length) throw corrupt()
        if (head.protocol >= 2 && (master.prepare("SELECT value FROM metadata WHERE key='protocol'").get()?.value !== String(head.protocol) || !master.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='vehicle_deletions'").get())) throw corrupt()
      } else {
        if (business.store.get('businessRevision') || (await fs.readdir(path.join(directory, 'snapshots'))).some(name => name.endsWith('.sqlite'))) throw corrupt()
        master = new DatabaseSync(work)
        master.exec('PRAGMA journal_mode=DELETE; PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL;')
        for (const name of ['records', 'changes']) master.exec(business.store.db.prepare("SELECT sql FROM sqlite_master WHERE name=? AND type='table'").get(name)!.sql as string)
        master.exec('CREATE TABLE applied(id TEXT PRIMARY KEY,payload TEXT NOT NULL); CREATE TABLE metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL);')
      }
      master.exec(markerSchema)
      const result = new SharedBusinessSnapshot(business, directory, work, master, head, atomic)
      const markers = result.deletions()
      if (head?.protocol === 1 && markers.length) throw corrupt()
      const records = (result.db.prepare('SELECT * FROM records').all() as RecordRow[]).map(fromRow)
      if (head && head.protocol < 3 && records.some(record => isProtectedKind(record.kind) || record.kind === 'part' && record.data.category === 'component')) throw corrupt()
      if (head?.protocol === 3) {
        try {
          validateConfigurationRecords(records)
          for (const entry of result.db.prepare("SELECT key,value FROM metadata WHERE key LIKE 'configurationRequest:%'").all()) validateConfigurationReceiptEntry({ key: String(entry.key), value: String(entry.value) })
        } catch { throw corrupt() }
      }
      return result
    } catch (error) { master?.close(); await fs.rm(work, { force: true }).catch(() => {}); throw error }
  }
  deletions(): VehicleDeletion[] {
    return this.db.prepare('SELECT vehicle_id,request_id,payload FROM vehicle_deletions ORDER BY vehicle_id').all().map(row => {
      let marker: VehicleDeletion
      try { marker = JSON.parse(String(row.payload)) as VehicleDeletion } catch { throw corrupt() }
      validateVehicleDeletion(marker)
      if (marker.vehicleId !== row.vehicle_id || marker.requestId !== row.request_id) throw corrupt()
      if (this.db.prepare('SELECT id FROM records WHERE id=? OR vehicle_id=?').get(marker.vehicleId, marker.vehicleId) || marker.recordIds.some(id => this.db.prepare('SELECT id FROM records WHERE id=?').get(id))) throw corrupt()
      return marker
    })
  }
  graph(vehicleId: string): RecordRow[] { return this.db.prepare('SELECT * FROM records WHERE id=? OR vehicle_id=? ORDER BY kind,id').all(vehicleId, vehicleId) as RecordRow[] }
  counts(graph: RecordRow[]): DeleteCounts {
    const counts: DeleteCounts = { vehicle: 0, part: 0, modification: 0, equipment: 0, report: 0, attachment: 0 }
    for (const row of graph) { if (row.kind === 'configurationRevision') counts.configurationRevision = (counts.configurationRevision || 0) + 1; else if (row.kind in counts) counts[row.kind]++; else throw corrupt() }
    return counts
  }
  async publish(teamId: string, requestedProtocol: 1 | 2 | 3, revision = randomUUID(), sequence = (this.head?.sequence || 0) + 1): Promise<BusinessHead> {
    const protocol = Math.max(requestedProtocol, this.head?.protocol || 1) as 1 | 2 | 3
    this.db.prepare('INSERT OR REPLACE INTO metadata VALUES(?,?)').run('teamId', teamId)
    this.db.prepare('INSERT OR REPLACE INTO metadata VALUES(?,?)').run('sequence', String(sequence))
    if (protocol >= 2) this.db.prepare('INSERT OR REPLACE INTO metadata VALUES(?,?)').run('protocol', String(protocol))
    if (protocol === 3) {
      try { validateConfigurationRecords((this.db.prepare('SELECT * FROM records').all() as RecordRow[]).map(fromRow)) } catch { throw corrupt() }
    }
    if (this.db.prepare('PRAGMA integrity_check').get()!.integrity_check !== 'ok' || this.db.prepare('PRAGMA foreign_key_check').all().length) throw corrupt()
    this.master!.close(); this.master = null
    const bytes = await fs.readFile(this.work), destination = path.join(this.directory, 'snapshots', `${revision}.sqlite`)
    const existing = await fs.readFile(destination).catch(error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error })
    if (existing) { if (checksum(existing) !== checksum(bytes)) throw corrupt() } else await this.atomic(destination, bytes)
    const head: BusinessHead = { protocol, teamId, revision, sequence, checksum: checksum(bytes), created: now() }
    const headPath = path.join(this.directory, 'HEAD.json')
    try { await this.atomic(headPath, JSON.stringify(head, null, 2)) }
    catch (error) {
      // A network filesystem can commit a rename but lose its acknowledgement.
      const published = await fs.readFile(headPath, 'utf8').then(text => { try { return JSON.parse(text) as BusinessHead } catch { return null } }).catch(() => null)
      if (!published || JSON.stringify(published) !== JSON.stringify(head)) throw error
    }
    this.head = head
    this.master = new DatabaseSync(this.work)
    this.master.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL;')
    await pruneSnapshots(this.directory, revision).catch(() => {})
    return head
  }
  async close(): Promise<void> { this.master?.close(); this.master = null; await fs.rm(this.work, { force: true }).catch(() => {}) }
}
