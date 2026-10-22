import { DatabaseSync } from 'node:sqlite'
import { AsyncLocalStorage } from 'node:async_hooks'
import { mkdirSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { hostname } from 'node:os'
import path from 'node:path'
import { AppError } from './team.js'
import type { Operation, QuarantinedOperation, VehicleDeletion } from '../shared/business.js'

export class LocalStore {
  private transactionDepth = 0
  readonly db: DatabaseSync
  readonly deviceId: string
  readonly deviceName = hostname()
  constructor(readonly directory: string) {
    mkdirSync(directory, { recursive: true })
    this.db = new DatabaseSync(path.join(directory, 'local.sqlite'))
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;')
    const version = this.db.prepare('PRAGMA user_version').get()!.user_version as number
    if (version > 3) { this.db.close(); throw new AppError('LOCAL_VERSION_TOO_NEW', 503) }
    if (version === 0) {
      this.db.exec(`BEGIN IMMEDIATE;
        CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);
        CREATE TABLE accounts(id TEXT PRIMARY KEY,username TEXT NOT NULL UNIQUE,display_name TEXT NOT NULL,salt TEXT NOT NULL,hash TEXT NOT NULL,created TEXT NOT NULL);
        CREATE TABLE sessions(token TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES accounts(id),expires INTEGER NOT NULL);
        CREATE TABLE local_events(id TEXT PRIMARY KEY,actor_id TEXT NOT NULL,action TEXT NOT NULL,detail TEXT NOT NULL,created TEXT NOT NULL);
        PRAGMA user_version=1;
        COMMIT;`)
    }
    if (version < 2) {
      this.db.exec(`BEGIN IMMEDIATE;
        CREATE TABLE records(id TEXT PRIMARY KEY,kind TEXT NOT NULL,vehicle_id TEXT REFERENCES records(id),vin TEXT UNIQUE,data TEXT NOT NULL,archived INTEGER NOT NULL DEFAULT 0,version INTEGER NOT NULL,updated TEXT NOT NULL);
        CREATE INDEX records_vehicle ON records(vehicle_id,kind);
        CREATE TABLE changes(id TEXT PRIMARY KEY,record_id TEXT NOT NULL,vehicle_id TEXT NOT NULL,payload TEXT NOT NULL,created TEXT NOT NULL);
        CREATE TABLE outbox(seq INTEGER PRIMARY KEY,id TEXT UNIQUE NOT NULL,record_id TEXT NOT NULL,payload TEXT NOT NULL,state TEXT NOT NULL DEFAULT 'pending');
        CREATE TABLE conflicts(record_id TEXT PRIMARY KEY,payload TEXT NOT NULL);
        PRAGMA user_version=2;
        COMMIT;`)
    }
    if (version < 3) {
      this.db.exec(`BEGIN IMMEDIATE;
        CREATE TABLE vehicle_deletions(vehicle_id TEXT PRIMARY KEY,request_id TEXT UNIQUE NOT NULL,payload TEXT NOT NULL);
        CREATE TABLE quarantined_operations(id TEXT PRIMARY KEY,payload TEXT NOT NULL);
        PRAGMA user_version=3;
        COMMIT;`)
    }
    const machine = this.get<string>('machine')
    if (machine && machine !== this.deviceName) { this.db.close(); throw new AppError('COPIED_LOCAL_DATA', 409) }
    this.deviceId = this.get<string>('deviceId') || randomUUID()
    this.set('deviceId', this.deviceId); this.set('machine', this.deviceName)
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
