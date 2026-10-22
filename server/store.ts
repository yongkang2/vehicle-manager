import { DatabaseSync } from 'node:sqlite'
import { AsyncLocalStorage } from 'node:async_hooks'
import { mkdirSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { hostname } from 'node:os'
import path from 'node:path'
import { AppError } from './team.js'
import type { Operation, QuarantinedOperation, VehicleDeletion } from '../shared/business.js'

const schemaError = () => new AppError('LOCAL_SCHEMA_INVALID', 503)
const coreSql = `CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);
  CREATE TABLE accounts(id TEXT PRIMARY KEY,username TEXT NOT NULL UNIQUE,display_name TEXT NOT NULL,salt TEXT NOT NULL,hash TEXT NOT NULL,created TEXT NOT NULL);
  CREATE TABLE sessions(token TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES accounts(id),expires INTEGER NOT NULL);
  CREATE TABLE local_events(id TEXT PRIMARY KEY,actor_id TEXT NOT NULL,action TEXT NOT NULL,detail TEXT NOT NULL,created TEXT NOT NULL);`
const businessSql = `CREATE TABLE records(id TEXT PRIMARY KEY,kind TEXT NOT NULL,vehicle_id TEXT REFERENCES records(id),vin TEXT UNIQUE,data TEXT NOT NULL,archived INTEGER NOT NULL DEFAULT 0,version INTEGER NOT NULL,updated TEXT NOT NULL);
  CREATE INDEX records_vehicle ON records(vehicle_id,kind);
  CREATE TABLE changes(id TEXT PRIMARY KEY,record_id TEXT NOT NULL,vehicle_id TEXT NOT NULL,payload TEXT NOT NULL,created TEXT NOT NULL);
  CREATE TABLE outbox(seq INTEGER PRIMARY KEY,id TEXT UNIQUE NOT NULL,record_id TEXT NOT NULL,payload TEXT NOT NULL,state TEXT NOT NULL DEFAULT 'pending');
  CREATE TABLE conflicts(record_id TEXT PRIMARY KEY,payload TEXT NOT NULL);`
const deletionSql = `CREATE TABLE vehicle_deletions(vehicle_id TEXT PRIMARY KEY,request_id TEXT UNIQUE NOT NULL,payload TEXT NOT NULL);
  CREATE TABLE quarantined_operations(id TEXT PRIMARY KEY,payload TEXT NOT NULL);`
const workspaceSql = `CREATE TABLE workspaces(id TEXT PRIMARY KEY,name TEXT NOT NULL,shared_path TEXT NOT NULL,directory TEXT NOT NULL);
  CREATE TABLE account_workspaces(user_id TEXT NOT NULL REFERENCES accounts(id),workspace_id TEXT NOT NULL REFERENCES workspaces(id),PRIMARY KEY(user_id,workspace_id));
  ALTER TABLE sessions ADD COLUMN workspace_id TEXT;
  ALTER TABLE sessions ADD COLUMN workspace_epoch INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE sessions ADD COLUMN sync_enabled INTEGER NOT NULL DEFAULT 0;`
const columnShapes: Record<string, string[]> = {
  settings: ['key TEXT PK1', 'value TEXT NN'],
  accounts: ['id TEXT PK1', 'username TEXT NN', 'display_name TEXT NN', 'salt TEXT NN', 'hash TEXT NN', 'created TEXT NN'],
  sessions: ['token TEXT PK1', 'user_id TEXT NN', 'expires INTEGER NN'],
  local_events: ['id TEXT PK1', 'actor_id TEXT NN', 'action TEXT NN', 'detail TEXT NN', 'created TEXT NN'],
  records: ['id TEXT PK1', 'kind TEXT NN', 'vehicle_id TEXT', 'vin TEXT', 'data TEXT NN', 'archived INTEGER NN DEFAULT=0', 'version INTEGER NN', 'updated TEXT NN'],
  changes: ['id TEXT PK1', 'record_id TEXT NN', 'vehicle_id TEXT NN', 'payload TEXT NN', 'created TEXT NN'],
  outbox: ['seq INTEGER PK1', 'id TEXT NN', 'record_id TEXT NN', 'payload TEXT NN', 'state TEXT NN DEFAULT=pending'],
  conflicts: ['record_id TEXT PK1', 'payload TEXT NN'],
  vehicle_deletions: ['vehicle_id TEXT PK1', 'request_id TEXT NN', 'payload TEXT NN'],
  quarantined_operations: ['id TEXT PK1', 'payload TEXT NN'],
  workspaces: ['id TEXT PK1', 'name TEXT NN', 'shared_path TEXT NN', 'directory TEXT NN'],
  account_workspaces: ['user_id TEXT NN PK1', 'workspace_id TEXT NN PK2'],
}
const workspaceColumns = ['workspace_id TEXT', 'workspace_epoch INTEGER NN DEFAULT=0', 'sync_enabled INTEGER NN DEFAULT=0']
const uniqueColumns: Record<string, string[][]> = { accounts: [['username']], records: [['vin']], outbox: [['id']], vehicle_deletions: [['request_id']] }
const foreignKeys: Record<string, string[][]> = { sessions: [['user_id', 'accounts', 'id']], records: [['vehicle_id', 'records', 'id']], account_workspaces: [['user_id', 'accounts', 'id'], ['workspace_id', 'workspaces', 'id']] }
const quoted = (name: string) => `"${name.replaceAll('"', '""')}"`
const normalizedDefault = (value: unknown) => value === null ? undefined : String(value).replace(/^\((.*)\)$/, '$1').replace(/^'(.*)'$/, '$1')

/** Both published v3 branches have different shapes; the version number is not a capability flag. */
function inspectSchema(db: DatabaseSync, version: number): { core: boolean; business: boolean; deletion: boolean; workspace: boolean } {
  if (!Number.isSafeInteger(version) || version < 0) throw schemaError()
  const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT GLOB 'sqlite_*'").all().map(row => String(row.name)))
  if ([...tables].some(name => !Object.hasOwn(columnShapes, name))) throw schemaError()
  const completeGroup = (names: string[]) => {
    const count = names.filter(name => tables.has(name)).length
    if (count !== 0 && count !== names.length) throw schemaError()
    return count > 0
  }
  const core = completeGroup(['settings', 'accounts', 'sessions', 'local_events'])
  const business = completeGroup(['records', 'changes', 'outbox', 'conflicts'])
  const deletion = completeGroup(['vehicle_deletions', 'quarantined_operations'])
  const workspace = completeGroup(['workspaces', 'account_workspaces'])
  if (version === 0 ? tables.size !== 0 : !core) throw schemaError()
  if ((version === 1 && (business || deletion || workspace)) || (version >= 2 && !business) || (version === 3 && !deletion && !workspace) || (version === 4 && (!deletion || !workspace))) throw schemaError()
  const sessionColumns = core ? db.prepare('PRAGMA table_info(sessions)').all().map(row => String(row.name)) : []
  const addedColumns = workspaceColumns.filter(definition => sessionColumns.includes(definition.split(' ')[0])).length
  if (addedColumns !== (workspace ? workspaceColumns.length : 0)) throw schemaError()
  for (const table of tables) {
    const expected = [...columnShapes[table], ...(table === 'sessions' && workspace ? workspaceColumns : [])]
    const columns = db.prepare(`PRAGMA table_info(${quoted(table)})`).all()
    if (columns.length !== expected.length) throw schemaError()
    for (let index = 0; index < columns.length; index++) {
      const column = columns[index], [name, type, ...flags] = expected[index].split(' ')
      const primaryKey = Number(flags.find(flag => flag.startsWith('PK'))?.slice(2) || 0)
      const defaultValue = flags.find(flag => flag.startsWith('DEFAULT='))?.slice(8)
      if (column.name !== name || String(column.type).toUpperCase() !== type || Boolean(column.notnull) !== flags.includes('NN') || column.pk !== primaryKey || normalizedDefault(column.dflt_value) !== defaultValue) throw schemaError()
    }
    const indexes = db.prepare(`PRAGMA index_list(${quoted(table)})`).all()
    const unique = indexes.filter(index => index.unique && index.origin !== 'pk').map(index => ({ partial: Boolean(index.partial), columns: db.prepare(`PRAGMA index_info(${quoted(String(index.name))})`).all().map(column => String(column.name)) }))
    const wantedUnique = uniqueColumns[table] || []
    if (unique.length !== wantedUnique.length || wantedUnique.some(wanted => !unique.some(index => !index.partial && JSON.stringify(index.columns) === JSON.stringify(wanted)))) throw schemaError()
    if (table === 'records') {
      const index = indexes.find(row => row.name === 'records_vehicle' && !row.unique && !row.partial)
      if (!index || JSON.stringify(db.prepare('PRAGMA index_info(records_vehicle)').all().map(column => column.name)) !== JSON.stringify(['vehicle_id', 'kind'])) throw schemaError()
    }
    const references = db.prepare(`PRAGMA foreign_key_list(${quoted(table)})`).all()
    const wantedReferences = foreignKeys[table] || []
    if (references.length !== wantedReferences.length || references.some(reference => reference.on_update !== 'NO ACTION' || reference.on_delete !== 'NO ACTION' || !wantedReferences.some(wanted => JSON.stringify([reference.from, reference.table, reference.to]) === JSON.stringify(wanted)))) throw schemaError()
  }
  if (db.prepare('PRAGMA integrity_check').get()!.integrity_check !== 'ok' || db.prepare('PRAGMA foreign_key_check').all().length) throw schemaError()
  return { core, business, deletion, workspace }
}

export class LocalStore {
  private transactionDepth = 0
  readonly db: DatabaseSync
  readonly deviceId: string
  readonly deviceName = hostname()
  constructor(readonly directory: string, deviceId?: string) {
    mkdirSync(directory, { recursive: true })
    this.db = new DatabaseSync(path.join(directory, 'local.sqlite'))
    try {
      this.db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;')
      const version = this.db.prepare('PRAGMA user_version').get()!.user_version as number
      if (version > 4) throw new AppError('LOCAL_VERSION_TOO_NEW', 503)
      const shape = inspectSchema(this.db, version)
      const machine = shape.core ? this.get<string>('machine') : null
      if (machine && machine !== this.deviceName) throw new AppError('COPIED_LOCAL_DATA', 409)
      const selectedDevice = deviceId || (shape.core ? this.get<string>('deviceId') : null) || randomUUID()
      const config = shape.core && !shape.workspace ? this.get<{ teamId: string; sharedPath: string }>('configuration') : null
      if (config && (typeof config.teamId !== 'string' || !config.teamId || typeof config.sharedPath !== 'string' || !config.sharedPath)) throw schemaError()
      if (version < 4) {
        if (version > 0) this.backupBeforeSchema4(version)
        this.transaction(() => {
          if (!shape.core) this.db.exec(coreSql)
          if (!shape.business) this.db.exec(businessSql)
          if (!shape.deletion) this.db.exec(deletionSql)
          if (!shape.workspace) {
            this.db.exec(workspaceSql)
            if (config) {
              const team = this.get<{ name?: string }>('cachedTeam')
              this.db.prepare('INSERT INTO workspaces VALUES(?,?,?,?)').run(config.teamId, typeof team?.name === 'string' && team.name ? team.name : config.teamId, config.sharedPath, '.')
              this.db.prepare('INSERT INTO account_workspaces SELECT id,? FROM accounts').run(config.teamId)
              this.db.prepare('UPDATE sessions SET workspace_id=?').run(config.teamId)
            }
          }
          inspectSchema(this.db, 4)
          this.set('deviceId', selectedDevice); this.set('machine', this.deviceName)
          this.db.exec('PRAGMA user_version=4')
        })
      } else {
        this.set('deviceId', selectedDevice); this.set('machine', this.deviceName)
      }
      this.deviceId = selectedDevice
    } catch (error) { this.db.close(); throw error }
  }
  private backupBeforeSchema4(version: number): void {
    try {
      const backups = path.join(this.directory, 'migration-backups')
      mkdirSync(backups, { recursive: true })
      const destination = path.join(backups, `before-schema4-${randomUUID()}.sqlite`)
      this.db.prepare('VACUUM INTO ?').run(destination)
      const snapshot = new DatabaseSync(destination, { readOnly: true })
      try {
        if (snapshot.prepare('PRAGMA user_version').get()!.user_version !== version) throw schemaError()
        inspectSchema(snapshot, version)
      } finally { snapshot.close() }
    } catch { throw new AppError('LOCAL_BACKUP_FAILED', 503) }
  }
  private readonly writeContext = new AsyncLocalStorage<{ active: boolean; maintenance: boolean }>()
  private readonly writeJobs = new Set<Promise<unknown>>()
  private maintenanceJob: Promise<unknown> | null = null
  private readonly canonicalDeletions = new Map<string, VehicleDeletion>()

  /** Track whole asynchronous workflows, not just their HTTP connections. */
  runWrite<T>(work: () => T | Promise<T>): Promise<T> {
    const current = this.writeContext.getStore()
    if (current?.active && current.maintenance) return Promise.resolve().then(work)
    if (this.maintenanceJob && !current?.active) return Promise.reject(new AppError('MAINTENANCE_IN_PROGRESS', 503))
    const context = { active: true, maintenance: false }
    let job: Promise<T>
    job = Promise.resolve().then(() => this.writeContext.run(context, work)).finally(() => {
      context.active = false; this.writeJobs.delete(job)
    })
    this.writeJobs.add(job)
    return job
  }

  withMaintenance<T>(work: () => T | Promise<T>): Promise<T> {
    const current = this.writeContext.getStore()
    if (current?.active && current.maintenance) return Promise.resolve().then(work)
    if (this.maintenanceJob || current?.active) return Promise.reject(new AppError('MAINTENANCE_IN_PROGRESS', 503))
    const context = { active: true, maintenance: true }
    const job = Promise.resolve().then(async () => {
      while (this.writeJobs.size) await Promise.allSettled([...this.writeJobs])
      return await this.writeContext.run(context, work)
    }).finally(() => { context.active = false; this.maintenanceJob = null })
    this.maintenanceJob = job
    return job
  }

  assertWritable(): void {
    if (this.maintenanceJob && !this.writeContext.getStore()?.active) throw new AppError('MAINTENANCE_IN_PROGRESS', 503)
  }

  async settleWork(): Promise<void> {
    while (this.writeJobs.size || this.maintenanceJob) {
      await Promise.allSettled([...this.writeJobs, ...(this.maintenanceJob ? [this.maintenanceJob] : [])])
    }
  }

  deletionRows(): VehicleDeletion[] {
    const rows = new Map((this.db.prepare('SELECT payload FROM vehicle_deletions ORDER BY vehicle_id').all().map(row => JSON.parse(row.payload as string) as VehicleDeletion)).map(row => [row.vehicleId, row]))
    for (const row of this.canonicalDeletions.values()) rows.set(row.vehicleId, row)
    return [...rows.values()]
  }

  /** Use only for deletions already committed to the canonical shared HEAD. */
  rememberDeletions(rows: VehicleDeletion[]): void {
    for (const row of rows) {
      const previous = this.canonicalDeletions.get(row.vehicleId)
      if (previous && previous.id !== row.id) throw new AppError('SHARE_CORRUPTED', 409)
      this.canonicalDeletions.set(row.vehicleId, row)
    }
  }

  deletionFor(recordId: string, vehicleId?: string | null): VehicleDeletion | null {
    return this.deletionRows().find(row => row.vehicleId === recordId || row.vehicleId === vehicleId || row.recordIds.includes(recordId)) || null
  }

  assertNotDeleted(recordId: string, vehicleId?: string | null): void {
    if (this.deletionFor(recordId, vehicleId)) throw new AppError('VEHICLE_DELETED', 410)
  }

  quarantineRows(): QuarantinedOperation[] {
    return this.db.prepare('SELECT payload FROM quarantined_operations ORDER BY id').all().map(row => JSON.parse(row.payload as string) as QuarantinedOperation)
  }

  importQuarantine(rows: QuarantinedOperation[]): void {
    this.assertWritable()
    for (const row of rows) {
      const previous = this.db.prepare('SELECT payload FROM quarantined_operations WHERE id=?').get(row.id)
      if (previous) {
        const existing = JSON.parse(previous.payload as string) as QuarantinedOperation
        if (JSON.stringify(existing.operation) !== JSON.stringify(row.operation) || existing.vehicleId !== row.vehicleId) throw new AppError('INVALID_BACKUP', 422)
      } else this.db.prepare('INSERT INTO quarantined_operations VALUES(?,?)').run(row.id, JSON.stringify(row))
    }
  }

  quarantineOperation(operation: Operation, vehicleId: string): void {
    this.importQuarantine([{ id: operation.id, vehicleId, reason: 'VEHICLE_DELETED', quarantinedAt: new Date().toISOString(), operation }])
    this.db.prepare("UPDATE outbox SET state='quarantined' WHERE id=? AND state='pending'").run(operation.id)
    this.db.prepare('DELETE FROM conflicts WHERE record_id=?').run(operation.recordId)
  }

  applyDeletions(rows: VehicleDeletion[]): void {
    this.assertWritable()
    this.transaction(() => {
      for (const deletion of rows) {
        const previous = this.db.prepare('SELECT payload FROM vehicle_deletions WHERE vehicle_id=? OR request_id=?').get(deletion.vehicleId, deletion.requestId)
        if (previous && JSON.stringify(JSON.parse(previous.payload as string)) !== JSON.stringify(deletion)) throw new AppError('BACKUP_DELETION_CONFLICT', 409)
        if (!previous) this.db.prepare('INSERT INTO vehicle_deletions VALUES(?,?,?)').run(deletion.vehicleId, deletion.requestId, JSON.stringify(deletion))
        const ids = new Set(deletion.recordIds)
        ids.add(deletion.vehicleId)
        for (const row of this.db.prepare("SELECT payload FROM outbox WHERE state='pending' ORDER BY seq").all()) {
          const operation = JSON.parse(row.payload as string) as Operation
          if (ids.has(operation.recordId) || operation.vehicleId === deletion.vehicleId) this.quarantineOperation(operation, deletion.vehicleId)
        }
        // Include unsynchronized children absent from the shared deletion preview.
        const records = this.db.prepare('SELECT id,vehicle_id FROM records').all()
        for (const record of records) if (record.id !== deletion.vehicleId && (ids.has(String(record.id)) || record.vehicle_id === deletion.vehicleId)) {
          this.db.prepare('DELETE FROM conflicts WHERE record_id=?').run(record.id)
          this.db.prepare('DELETE FROM records WHERE id=?').run(record.id)
        }
        for (const id of ids) this.db.prepare('DELETE FROM conflicts WHERE record_id=?').run(id)
        this.db.prepare('DELETE FROM records WHERE id=?').run(deletion.vehicleId)
      }
    })
  }
  get<T>(key: string): T | null {
    const row = this.db.prepare('SELECT value FROM settings WHERE key=?').get(key)
    return row ? JSON.parse(row.value as string) as T : null
  }
  set(key: string, value: unknown): void { this.db.prepare('INSERT OR REPLACE INTO settings VALUES(?,?)').run(key, JSON.stringify(value)) }
  transaction(work: () => void): void {
    if (this.transactionDepth) { work(); return }
    this.db.exec('BEGIN IMMEDIATE')
    this.transactionDepth = 1
    try { work(); this.db.exec('COMMIT') } catch (error) { this.db.exec('ROLLBACK'); throw error }
    finally { this.transactionDepth = 0 }
  }
  event(actorId: string, action: string, detail: unknown): void {
    this.db.prepare('INSERT INTO local_events VALUES(?,?,?,?,?)').run(randomUUID(), actorId, action, JSON.stringify(detail), new Date().toISOString())
  }
}
