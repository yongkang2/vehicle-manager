import { DatabaseSync } from 'node:sqlite'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { Business, checksum, now } from './business.js'
import type { RecordRow } from './business.js'
import { AppError, TeamDirectory } from './team.js'
import type { Identity, TeamDocument } from '../shared/types.js'
import type { Actor, Change, Fields, Operation, SyncConflict, SyncStatus } from '../shared/business.js'

const equivalent = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right)
const stateOf = (row: RecordRow | undefined) => row ? { data: JSON.parse(row.data) as Fields, archived: Boolean(row.archived) } : null
const hashKey = (key: string) => /^[a-f0-9]{64}$/.test(key)
const kinds = "CASE kind WHEN 'vehicle' THEN 0 WHEN 'part' THEN 1 ELSE 2 END"
type Head = { protocol: 1; teamId: string; revision: string; sequence: number; checksum: string; created: string }

export async function atomicFile(destination: string, bytes: Buffer | string): Promise<void> {
  const temporary = `${destination}.${randomUUID()}.tmp`
  try {
    const handle = await fs.open(temporary, 'wx')
    try { await handle.writeFile(bytes); await handle.sync() } finally { await handle.close() }
    await fs.rename(temporary, destination)
  } finally { await fs.rm(temporary, { force: true }).catch(() => {}) }
}
async function optionalRead(filename: string): Promise<Buffer | null> {
  return fs.readFile(filename).catch(error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error })
}
async function immutableFile(filename: string, bytes: Buffer): Promise<void> {
  const existing = await optionalRead(filename)
  if (existing) { if (checksum(existing) !== checksum(bytes)) throw new AppError('FILE_CORRUPTED', 409); return }
  await atomicFile(filename, bytes)
}

export class BusinessSync {
  private running: Promise<SyncStatus> | null = null
  private phase: SyncStatus['phase'] = 'idle'
  private error: string | null = null
  constructor(readonly business: Business, readonly teams: TeamDirectory) {}
  status(): SyncStatus {
    const store = this.business.store
    return { phase: this.phase, error: this.error, pending: store.db.prepare("SELECT COUNT(*) AS total FROM outbox WHERE state='pending'").get()!.total as number, conflicts: store.db.prepare('SELECT payload FROM conflicts').all().map(row => JSON.parse(row.payload as string)), lastSync: store.get<string>('businessLastSync'), revision: store.get<string>('businessRevision') }
  }
  async settle(): Promise<void> { if (this.running) await this.running }
  synchronize(directory: string, teamId: string, identity: Identity): Promise<SyncStatus> {
    if (this.running) return this.running
    this.phase = 'syncing'
    this.running = this.teams.withAccess(directory, teamId, identity, false, team => this.cycle(directory, team)).catch(error => {
      this.error = error instanceof AppError ? error.code : 'SHARE_IO_ERROR'
      this.phase = this.error === 'SHARE_BUSY' ? 'busy' : 'offline'
      return this.status()
    }).finally(() => { this.running = null })
    return this.running
  }
  private newMaster(filename: string): DatabaseSync {
    const master = new DatabaseSync(filename)
    master.exec('PRAGMA journal_mode=DELETE; PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL;')
    for (const name of ['records', 'changes']) master.exec(this.business.store.db.prepare("SELECT sql FROM sqlite_master WHERE name=? AND type='table'").get(name)!.sql as string)
    master.exec('CREATE TABLE applied(id TEXT PRIMARY KEY,payload TEXT NOT NULL); CREATE TABLE metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL);')
    return master
  }
  private checkConflict(master: DatabaseSync, operations: Operation[], team: TeamDocument): SyncConflict | null {
    const first = operations[0], last = operations.at(-1)!
    const row = master.prepare('SELECT * FROM records WHERE id=?').get(first.recordId) as RecordRow | undefined
    const remote = stateOf(row), fields: string[] = []
    for (const operation of operations) {
      const member = team.members.find(item => item.id === operation.actor.id && item.enabled)
      const binding = team.bindings.find(item => item.memberId === operation.actor.id && item.deviceId === operation.actor.deviceId && item.enabled)
      const privileged = operation.maintenance === 'restore' || (operation.base && operation.base.archived !== operation.desired.archived)
      if (!member || !binding || (privileged && member.role !== 'admin')) fields.push('_permission')
    }
    const duplicateReport = first.kind === 'report' && !first.base && remote?.data.checksum === last.desired.data.checksum && row?.vehicle_id === first.vehicleId
    if (!duplicateReport) {
      if (!first.base) { if (remote) fields.push('_record') }
      else if (!remote) fields.push('_record')
      else {
        for (const key of Object.keys(last.desired.data)) if (!equivalent(first.base.data[key], last.desired.data[key]) && !equivalent(remote.data[key], first.base.data[key]) && !equivalent(remote.data[key], last.desired.data[key])) fields.push(key)
        if (remote.archived !== first.base.archived && (last.desired.archived !== remote.archived || !equivalent(last.desired.data, first.base.data) || operations.some(operation => operation.files.length))) fields.push('_archived')
        if (last.desired.archived !== first.base.archived && !equivalent(remote.data, first.base.data)) fields.push('_archived')
      }
    }
    if (first.kind === 'vehicle' && master.prepare('SELECT id FROM records WHERE vin=? AND id<>?').get(String(last.desired.data.vin), first.recordId)) fields.push('_vin')
    if (first.vehicleId) {
      const parent = master.prepare('SELECT archived FROM records WHERE id=?').get(first.vehicleId)
      if (!parent || (parent.archived && !operations.every(operation => operation.maintenance === 'restore'))) fields.push('_parent')
    }
    if (!fields.length) return null
    const conflict = { recordId: first.recordId, kind: first.kind, name: String(last.desired.data.name || first.recordId), fields: [...new Set(fields)], local: last.desired, remote, base: first.base, operationIds: operations.map(operation => operation.id) }
    return { ...conflict, token: checksum(JSON.stringify(conflict)) }
  }
  private apply(master: DatabaseSync, operations: Operation[]): void {
    const first = operations[0], last = operations.at(-1)!
    const row = master.prepare('SELECT * FROM records WHERE id=?').get(first.recordId) as RecordRow | undefined
    const duplicateReport = first.kind === 'report' && !first.base && row && JSON.parse(row.data).checksum === last.desired.data.checksum
    if (!first.decision && !duplicateReport) {
      const data: Fields = row ? JSON.parse(row.data) : structuredClone(last.desired.data)
      if (first.base) for (const key of Object.keys(last.desired.data)) if (!equivalent(first.base.data[key], last.desired.data[key])) data[key] = last.desired.data[key]
      const archived = !row || !first.base || first.base.archived !== last.desired.archived ? last.desired.archived : Boolean(row.archived)
      const vin = first.kind === 'vehicle' ? String(data.vin) : null
      if (row) master.prepare('UPDATE records SET data=?,vin=?,archived=?,version=version+1,updated=? WHERE id=?').run(JSON.stringify(data), vin, archived ? 1 : 0, now(), first.recordId)
      else master.prepare('INSERT INTO records VALUES(?,?,?,?,?,?,?,?)').run(first.recordId, first.kind, first.vehicleId, vin, JSON.stringify(data), archived ? 1 : 0, 1, now())
    }
    for (const operation of operations) {
      for (const change of operation.changes) master.prepare('INSERT OR IGNORE INTO changes VALUES(?,?,?,?,?)').run(change.id, change.recordId, change.vehicleId, JSON.stringify(change), change.created)
      master.prepare('INSERT INTO applied VALUES(?,?)').run(operation.id, JSON.stringify(operation))
    }
  }
  private async filesToShare(directory: string, operations: Operation[]): Promise<void> {
    for (const key of new Set(operations.flatMap(operation => operation.files))) {
      if (!hashKey(key)) throw new AppError('INVALID_INPUT')
      const bytes = await this.business.readBlob(key)
      await immutableFile(path.join(directory, 'blobs', key), bytes)
    }
  }
  private async ingest(master: DatabaseSync, directory: string, head: Head, conflicts: SyncConflict[]): Promise<void> {
    const records = master.prepare(`SELECT * FROM records ORDER BY ${kinds},id`).all() as RecordRow[]
    for (const row of records.filter(item => ['report', 'attachment'].includes(item.kind))) {
      const data = JSON.parse(row.data) as { checksum: string; size: number }
      if (!hashKey(data.checksum)) throw new AppError('INVALID_INPUT')
      const localPath = path.join(this.business.store.directory, 'blobs', data.checksum)
      const local = await optionalRead(localPath)
      if (local && checksum(local) === data.checksum) continue
      const bytes = await fs.readFile(path.join(directory, 'blobs', data.checksum))
      if (checksum(bytes) !== data.checksum || bytes.length !== data.size) throw new AppError('FILE_CORRUPTED', 409)
      await fs.mkdir(path.dirname(localPath), { recursive: true })
      await atomicFile(localPath, bytes)
    }
    const store = this.business.store
    store.transaction(() => {
      for (const operation of store.db.prepare("SELECT id FROM outbox WHERE state='pending'").all()) if (master.prepare('SELECT id FROM applied WHERE id=?').get(operation.id)) store.db.prepare("UPDATE outbox SET state='sent' WHERE id=?").run(operation.id)
      const pending = new Set(store.db.prepare("SELECT record_id FROM outbox WHERE state='pending'").all().map(row => row.record_id))
      for (const row of records) {
        if (pending.has(row.id)) continue
        const duplicate = row.kind === 'vehicle' ? store.db.prepare('SELECT id FROM records WHERE vin=? AND id<>?').get(JSON.parse(row.data).vin, row.id) : null
        if (duplicate) {
          if (!pending.has(duplicate.id)) throw new AppError('VIN_EXISTS', 409)
          store.db.prepare('UPDATE records SET vin=?,version=version+1 WHERE id=?').run(`pending:${duplicate.id}`, duplicate.id)
        }
        const local = store.db.prepare('SELECT * FROM records WHERE id=?').get(row.id) as RecordRow | undefined
        if (!local) store.db.prepare('INSERT INTO records VALUES(?,?,?,?,?,?,?,?)').run(row.id, row.kind, row.vehicle_id, row.kind === 'vehicle' ? String(JSON.parse(row.data).vin) : null, row.data, row.archived, 1, row.updated)
        else if (row.data !== local.data || row.archived !== local.archived) store.db.prepare('UPDATE records SET data=?,vin=?,archived=?,version=version+1,updated=? WHERE id=?').run(row.data, row.kind === 'vehicle' ? String(JSON.parse(row.data).vin) : null, row.archived, row.updated, row.id)
      }
      for (const change of master.prepare('SELECT * FROM changes').all()) store.db.prepare('INSERT OR IGNORE INTO changes VALUES(?,?,?,?,?)').run(change.id, change.record_id, change.vehicle_id, change.payload, change.created)
      store.db.exec('DELETE FROM conflicts')
      for (const conflict of conflicts) store.db.prepare('INSERT INTO conflicts VALUES(?,?)').run(conflict.recordId, JSON.stringify(conflict))
      store.set('businessRevision', head.revision); store.set('businessSequence', head.sequence); store.set('businessLastSync', now())
    })
  }
  private async cycle(shared: string, team: TeamDocument): Promise<SyncStatus> {
    const directory = path.join(shared, 'business'), localDirectory = path.join(this.business.store.directory, 'sync-work')
    await fs.mkdir(directory, { recursive: true }); await fs.mkdir(localDirectory, { recursive: true })
    for (const name of ['snapshots', 'operations', 'blobs']) await fs.mkdir(path.join(directory, name), { recursive: true })
    const work = path.join(localDirectory, `${randomUUID()}.sqlite`)
    let master: DatabaseSync | null = null
    try {
      const bytes = await optionalRead(path.join(directory, 'HEAD.json'))
      let head: Head | null = null
      if (bytes) {
        head = JSON.parse(bytes.toString()) as Head
        const sequence = this.business.store.get<number>('businessSequence') || 0
        if (head.protocol !== 1 || head.teamId !== team.id || !/^[a-f0-9-]{36}$/.test(head.revision) || !Number.isSafeInteger(head.sequence) || head.sequence < 1 || !hashKey(head.checksum)) throw new AppError('SHARE_CORRUPTED', 409)
        if (head.sequence < sequence || (head.sequence === sequence && this.business.store.get('businessRevision') !== head.revision)) throw new AppError('BUSINESS_ROLLBACK', 409)
        const snapshot = await fs.readFile(path.join(directory, 'snapshots', `${head.revision}.sqlite`))
        if (checksum(snapshot) !== head.checksum) throw new AppError('SHARE_CORRUPTED', 409)
        await fs.writeFile(work, snapshot, { flag: 'wx' })
        master = new DatabaseSync(work)
        master.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=DELETE;')
        if (master.prepare('PRAGMA integrity_check').get()!.integrity_check !== 'ok' || master.prepare("SELECT value FROM metadata WHERE key='teamId'").get()?.value !== team.id || Number(master.prepare("SELECT value FROM metadata WHERE key='sequence'").get()?.value) !== head.sequence) throw new AppError('SHARE_CORRUPTED', 409)
      } else {
        if (this.business.store.get('businessRevision') || (await fs.readdir(path.join(directory, 'snapshots'))).some(name => name.endsWith('.sqlite'))) throw new AppError('SHARE_CORRUPTED', 409)
        master = this.newMaster(work)
      }
      const pending = this.business.store.db.prepare("SELECT payload FROM outbox WHERE state='pending' ORDER BY seq").all().map(row => JSON.parse(row.payload as string) as Operation)
      const groups = new Map<string, Operation[]>()
      let changed = !head
      for (const operation of pending) {
        await immutableFile(path.join(directory, 'operations', `${operation.id}.json`), Buffer.from(JSON.stringify(operation)))
        if (master.prepare('SELECT id FROM applied WHERE id=?').get(operation.id)) continue
        if (!groups.has(operation.recordId)) groups.set(operation.recordId, [])
        groups.get(operation.recordId)!.push(operation)
      }
      const conflicts: SyncConflict[] = []
      const ordered = [...groups.values()].sort((left, right) => Number(right[0].kind === 'vehicle') - Number(left[0].kind === 'vehicle'))
      for (const operations of ordered) {
        const conflict = this.checkConflict(master, operations, team)
        if (conflict && !operations[0].decision) { conflicts.push(conflict); continue }
        if (conflict?.fields.includes('_permission')) { conflicts.push(conflict); continue }
        await this.filesToShare(directory, operations)
        master.exec('BEGIN IMMEDIATE')
        try { this.apply(master, operations); master.exec('COMMIT'); changed = true } catch (error) { master.exec('ROLLBACK'); throw error }
      }
      if (changed) {
        const sequence = (head?.sequence || 0) + 1, revision = randomUUID()
        master.prepare('INSERT OR REPLACE INTO metadata VALUES(?,?)').run('teamId', team.id)
        master.prepare('INSERT OR REPLACE INTO metadata VALUES(?,?)').run('sequence', String(sequence))
        if (master.prepare('PRAGMA integrity_check').get()!.integrity_check !== 'ok' || master.prepare('PRAGMA foreign_key_check').all().length) throw new AppError('SHARE_CORRUPTED', 409)
        master.close(); master = null
        const snapshot = await fs.readFile(work)
        await immutableFile(path.join(directory, 'snapshots', `${revision}.sqlite`), snapshot)
        head = { protocol: 1, teamId: team.id, revision, sequence, checksum: checksum(snapshot), created: now() }
        await atomicFile(path.join(directory, 'HEAD.json'), JSON.stringify(head, null, 2))
        master = new DatabaseSync(work)
      }
      await this.ingest(master, directory, head!, conflicts)
      this.error = null; this.phase = conflicts.length ? 'conflict' : 'ready'
      return this.status()
    } finally { master?.close(); await fs.rm(work, { force: true }).catch(() => {}) }
  }
  async resolve(directory: string, teamId: string, identity: Identity, actor: Actor, recordId: string, token: string, choices: Record<string, string>, reason: string): Promise<SyncStatus> {
    await this.synchronize(directory, teamId, identity)
    if (this.phase === 'offline' || this.phase === 'busy') throw new AppError(this.error || 'SHARE_UNAVAILABLE', 409)
    const store = this.business.store
    const row = store.db.prepare('SELECT payload FROM conflicts WHERE record_id=?').get(recordId)
    const conflict = row ? JSON.parse(row.payload as string) as SyncConflict : null
    if (!conflict || conflict.token !== token || conflict.fields.some(field => !['local', 'shared'].includes(choices[field]))) throw new AppError('CONFLICT_CHANGED', 409)
    if (conflict.fields.includes('_permission') && actor.role !== 'admin') throw new AppError('ADMIN_REQUIRED', 403)
    const operations = store.db.prepare("SELECT payload FROM outbox WHERE record_id=? AND state='pending' ORDER BY seq").all(recordId).map(row => JSON.parse(row.payload as string) as Operation)
    const current = this.business.get(recordId)
    if (!equivalent(conflict.local, { data: current.data, archived: current.archived }) || !equivalent(conflict.operationIds, operations.map(operation => operation.id))) throw new AppError('CONFLICT_CHANGED', 409)
    const discard = conflict.fields.some(field => field.startsWith('_') && choices[field] === 'shared')
    if (conflict.fields.includes('_vin') && !discard) throw new AppError('VIN_EXISTS', 409)
    const desired = structuredClone(conflict.remote || conflict.local)
    if (!discard) {
      for (const field of Object.keys(current.data)) if ((!conflict.base || !equivalent(conflict.base.data[field], current.data[field])) && (!conflict.fields.includes(field) || choices[field] === 'local')) desired.data[field] = current.data[field]
      if (!conflict.base || conflict.base.archived !== current.archived || choices._archived === 'local') desired.archived = current.archived
    }
    const id = randomUUID(), created = now()
    const change: Change = { id, recordId, kind: current.kind, vehicleId: current.vehicleId || current.id, before: current.data, after: desired.data, archivedBefore: current.archived, archivedAfter: desired.archived, actor, action: 'conflict.resolved', reason, sourceId: null, created }
    const operation: Operation = { id, recordId, kind: current.kind, vehicleId: current.vehicleId, base: conflict.remote, desired, changes: [...operations.flatMap(operation => operation.changes), change], actor, files: discard ? [] : operations.flatMap(operation => operation.files), created, decision: discard }
    store.transaction(() => {
      for (const previous of operations) store.db.prepare("UPDATE outbox SET state='superseded' WHERE id=?").run(previous.id)
      store.db.prepare('INSERT INTO outbox(id,record_id,payload) VALUES(?,?,?)').run(id, recordId, JSON.stringify(operation))
      store.db.prepare('INSERT INTO changes VALUES(?,?,?,?,?)').run(id, recordId, change.vehicleId, JSON.stringify(change), created)
      store.db.prepare('UPDATE records SET data=?,archived=?,vin=?,version=version+1,updated=? WHERE id=?').run(JSON.stringify(desired.data), discard && !conflict.remote ? 1 : desired.archived ? 1 : 0, current.kind === 'vehicle' ? discard && !conflict.remote ? `discarded:${recordId}` : String(desired.data.vin) : null, created, recordId)
      store.db.prepare('DELETE FROM conflicts WHERE record_id=?').run(recordId)
    })
    return this.synchronize(directory, teamId, identity)
  }
}