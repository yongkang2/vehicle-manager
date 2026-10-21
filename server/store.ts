import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { hostname } from 'node:os'
import path from 'node:path'
import { AppError } from './team.js'

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
    if (version > 2) { this.db.close(); throw new AppError('LOCAL_VERSION_TOO_NEW', 503) }
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
    const machine = this.get<string>('machine')
    if (machine && machine !== this.deviceName) { this.db.close(); throw new AppError('COPIED_LOCAL_DATA', 409) }
    this.deviceId = this.get<string>('deviceId') || randomUUID()
    this.set('deviceId', this.deviceId); this.set('machine', this.deviceName)
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