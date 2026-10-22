import { randomUUID, createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { AppError } from './team.js'
import { LocalStore } from './store.js'
import { entryFields, keyControllerName, partFields, vehicleFields } from '../shared/business.js'
import type { Actor, BusinessRecord, Change, Fields, Operation, RecordKind } from '../shared/business.js'

export const now = () => new Date().toISOString()
export const checksum = (value: Uint8Array | string) => createHash('sha256').update(value).digest('hex')
export function reason(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 500) throw new AppError('REASON_REQUIRED')
  return value.trim()
}
export function normalizeVin(value: string): string { return value.toUpperCase().replace(/[\s-]/g, '') }
export function normalizeFields(kind: RecordKind, input: unknown): Fields {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new AppError('INVALID_INPUT')
  const source = input as Fields
  const names = kind === 'vehicle' ? vehicleFields : kind === 'part' ? partFields : kind === 'modification' || kind === 'equipment' ? entryFields : null
  if (!names) throw new AppError('INVALID_INPUT')
  const data: Fields = {}
  for (const field of names) {
    const value = source[field] ?? ''
    if (typeof value !== 'string' || value.length > 4000) throw new AppError('INVALID_INPUT')
    data[field] = value.trim()
  }
  if ((kind !== 'vehicle' && !data.name) || String(data.name).length > 120) throw new AppError('INVALID_INPUT')
  for (const field of ['plateExpiry', 'installedAt', 'removedAt']) {
    const value = data[field]
    if (value && (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value)) throw new AppError('INVALID_DATE')
  }
  if (data.installedAt && data.removedAt && String(data.removedAt) < String(data.installedAt)) throw new AppError('INVALID_DATE')
  if (kind === 'vehicle') {
    data.vin = normalizeVin(String(data.vin))
    if (!/^[A-HJ-NPR-Z0-9]{17}$/.test(String(data.vin))) throw new AppError('INVALID_VIN')
    if (!['available', 'testing', 'maintenance', 'inactive'].includes(String(data.status))) throw new AppError('INVALID_INPUT')
  }
  if (kind === 'part' && !['motor', 'battery', 'controller'].includes(String(data.category))) throw new AppError('INVALID_INPUT')
  if (kind === 'part' && data.category === 'controller') data.name = keyControllerName(data.name) || data.name
  return data
}
export type RecordRow = { id: string; kind: RecordKind; vehicle_id: string | null; data: string; archived: number; version: number; updated: string }
export function fromRow(row: RecordRow): BusinessRecord { return { id: row.id, kind: row.kind, vehicleId: row.vehicle_id, data: JSON.parse(row.data), archived: Boolean(row.archived), version: row.version, updated: row.updated } }

export class Business {
  constructor(readonly store: LocalStore) {}
  get(id: string): BusinessRecord {
    const row = this.store.db.prepare('SELECT * FROM records WHERE id=?').get(id) as RecordRow | undefined
    if (!row) throw new AppError('RECORD_NOT_FOUND', 404)
    return fromRow(row)
  }
  list(kind?: RecordKind, vehicleId?: string): BusinessRecord[] {
    return (this.store.db.prepare('SELECT * FROM records ORDER BY updated DESC,id').all() as RecordRow[]).filter(row => (!kind || row.kind === kind) && (!vehicleId || row.vehicle_id === vehicleId)).map(fromRow)
  }
  history(vehicleId?: string): Change[] {
    return this.store.db.prepare('SELECT payload FROM changes WHERE (? IS NULL OR vehicle_id=?) ORDER BY created DESC,rowid DESC LIMIT 1000').all(vehicleId || null, vehicleId || null).map(row => JSON.parse(row.payload as string) as Change)
  }
  write({ id = randomUUID(), kind, vehicleId = null, data, actor, reason: explanation, version, archived, sourceId = null, internal = false, maintenance }: {
    id?: string; kind: RecordKind; vehicleId?: string | null; data: Fields; actor: Actor; reason: unknown; version?: number; archived?: boolean; sourceId?: string | null; internal?: boolean; maintenance?: 'restore'
  }): BusinessRecord {
    const why = reason(explanation)
    const normalized = internal ? data : normalizeFields(kind, data)
    this.store.transaction(() => {
      const row = this.store.db.prepare('SELECT * FROM records WHERE id=?').get(id) as RecordRow | undefined
      const before = row ? fromRow(row) : null
      if (before && (before.kind !== kind || before.vehicleId !== vehicleId || before.version !== version)) throw new AppError('VERSION_CONFLICT', 409)
      const targetArchived = archived ?? before?.archived ?? false
      if (before?.archived && archived !== false) throw new AppError('RECORD_ARCHIVED', 409)
      if (before && targetArchived !== before.archived && actor.role !== 'admin') throw new AppError('ADMIN_REQUIRED', 403)
      if (kind !== 'vehicle') {
        if (!vehicleId) throw new AppError('INVALID_INPUT')
        const parent = this.get(vehicleId)
        if (parent.kind !== 'vehicle' || (parent.archived && !targetArchived)) throw new AppError('PARENT_ARCHIVED', 409)
      }
      const vin = kind === 'vehicle' ? String(normalized.vin) : null
      const controllerName = kind === 'part' && normalized.category === 'controller' ? keyControllerName(normalized.name) : null
      if (controllerName && !targetArchived && this.list('part', vehicleId!).some(record => record.id !== id && !record.archived && record.data.category === 'controller' && keyControllerName(record.data.name) === controllerName)) throw new AppError('CONTROLLER_EXISTS', 409)
      if (vin && this.store.db.prepare('SELECT id FROM records WHERE vin=? AND id<>?').get(vin, id)) throw new AppError('VIN_EXISTS', 409)
      const timestamp = now()
      if (!before) this.store.db.prepare('INSERT INTO records VALUES(?,?,?,?,?,?,?,?)').run(id, kind, vehicleId, vin, JSON.stringify(normalized), targetArchived ? 1 : 0, 1, timestamp)
      else this.store.db.prepare('UPDATE records SET data=?,vin=?,archived=?,version=version+1,updated=? WHERE id=?').run(JSON.stringify(normalized), vin, targetArchived ? 1 : 0, timestamp, id)
      const change: Change = { id: randomUUID(), recordId: id, vehicleId: vehicleId || id, kind, before: before?.data || null, after: normalized, archivedBefore: before?.archived ?? null, archivedAfter: targetArchived, actor, reason: why, action: !before ? 'created' : before.archived !== targetArchived ? targetArchived ? 'archived' : 'restored' : 'updated', sourceId, created: timestamp }
      this.store.db.prepare('INSERT INTO changes VALUES(?,?,?,?,?)').run(change.id, id, vehicleId || id, JSON.stringify(change), timestamp)
      const operation: Operation = { id: change.id, recordId: id, kind, vehicleId, base: before ? { data: before.data, archived: before.archived } : null, desired: { data: normalized, archived: targetArchived }, changes: [change], actor, files: ['attachment', 'report'].includes(kind) ? [String(normalized.checksum)] : [], created: timestamp, ...(maintenance ? { maintenance } : {}) }
      this.store.db.prepare('INSERT INTO outbox(id,record_id,payload) VALUES(?,?,?)').run(operation.id, id, JSON.stringify(operation))
    })
    return this.get(id)
  }
  async blob(bytes: Buffer): Promise<string> {
    const key = checksum(bytes), directory = path.join(this.store.directory, 'blobs')
    await fs.mkdir(directory, { recursive: true })
    const destination = path.join(directory, key), temporary = `${destination}.${randomUUID()}.tmp`
    try {
      const existing = await fs.readFile(destination).catch(error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error })
      if (existing) { if (checksum(existing) !== key) throw new AppError('FILE_CORRUPTED', 409); return key }
      const handle = await fs.open(temporary, 'wx')
      try { await handle.writeFile(bytes); await handle.sync() } finally { await handle.close() }
      await fs.rename(temporary, destination)
      return key
    } finally { await fs.rm(temporary, { force: true }).catch(() => {}) }
  }
  async readBlob(key: string): Promise<Buffer> {
    if (!/^[a-f0-9]{64}$/.test(key)) throw new AppError('INVALID_INPUT')
    const bytes = await fs.readFile(path.join(this.store.directory, 'blobs', key)).catch(() => { throw new AppError('FILE_MISSING', 404) })
    if (checksum(bytes) !== key) throw new AppError('FILE_CORRUPTED', 409)
    return bytes
  }
}
