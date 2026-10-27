import { randomUUID, createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { AppError } from './team.js'
import { LocalStore } from './store.js'
import { batteryLifeStatuses, businessFieldRegistry, complianceLevels, controllerTypes, entryFields, keyControllerName, partFields, vehicleFields } from '../shared/business.js'
import type { Actor, BusinessRecord, Change, Fields, Operation, RecordKind } from '../shared/business.js'
import { parsePhotoAttachmentId, PHOTO_MAX_BYTES, PHOTO_MAX_DIMENSION, PHOTO_MAX_PIXELS } from '../shared/vehicle-photo.js'

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
  const legacyNames = kind === 'vehicle' ? businessFieldRegistry.vehicle.legacy : kind === 'part' ? businessFieldRegistry.part.legacy : businessFieldRegistry.entry.legacy
  if (!names) throw new AppError('INVALID_INPUT')
  const data: Fields = {}
  for (const field of names) {
    const value = source[field] ?? ''
    if (typeof value !== 'string' || value.length > 4000) throw new AppError('INVALID_INPUT')
    data[field] = value.trim()
  }
  for (const field of legacyNames) {
    if (!Object.hasOwn(source, field)) continue
    const value = source[field]
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
    if (Object.hasOwn(source, 'photoAttachmentId')) {
      const photoId = parsePhotoAttachmentId(source.photoAttachmentId)
      if (photoId === null) throw new AppError('INVALID_INPUT')
      data.photoAttachmentId = photoId
    }
    data.vin = normalizeVin(String(data.vin))
    if (!/^[A-HJ-NPR-Z0-9]{17}$/.test(String(data.vin))) throw new AppError('INVALID_VIN')
    if (!['available', 'testing', 'maintenance', 'inactive'].includes(String(data.status))) throw new AppError('INVALID_INPUT')
    if (data.complianceLevel && !complianceLevels.some(value => value === data.complianceLevel)) throw new AppError('INVALID_INPUT')
  }
  if (kind === 'part' && !['motor', 'battery', 'controller'].includes(String(data.category))) throw new AppError('INVALID_INPUT')
  if (kind === 'part') {
    for (const [field, options] of [['controllerType', controllerTypes], ['lifeStatus', batteryLifeStatuses]] as const) {
      if (data[field] && !options.some(value => value === data[field])) throw new AppError('INVALID_INPUT')
    }
  }
  if (kind === 'part' && data.category === 'controller') data.name = keyControllerName(data.name) || data.name
  return data
}

/** Required only for manual record APIs; imports and legacy restoration may remain unclassified. */
export function validateManualPartFields(kind: RecordKind, input: unknown, current?: BusinessRecord): void {
  if (kind !== 'part') return
  const data = normalizeFields(kind, input)
  if (data.category === 'controller' && !data.controllerType) throw new AppError('CONTROLLER_TYPE_REQUIRED')
  if (data.category !== 'battery' || data.lifeStatus) return
  // Existing removal actions share PUT with the editor. Recognize only a real
  // blank-to-date removal, never a caller-supplied bypass or a simultaneous edit.
  if (current?.kind === 'part' && current.data.category === 'battery' && !String(current.data.removedAt ?? '').trim() && data.removedAt) {
    const before = normalizeFields('part', current.data)
    if (partFields.every(field => field === 'removedAt' || before[field] === data[field])) return
  }
  throw new AppError('BATTERY_LIFE_STATUS_REQUIRED')
}

export function validateManualRecordFields(kind: RecordKind, input: unknown, current?: BusinessRecord): void {
  if (kind !== 'vehicle') return validateManualPartFields(kind, input, current)
  // Ordinary vehicle edits ignore this server-managed reference, just as write()
  // does. Classification validation must not give callers a new photo-write path.
  const fields = input && typeof input === 'object' && !Array.isArray(input) ? Object.fromEntries(Object.entries(input).filter(([key]) => key !== 'photoAttachmentId')) : input
  const data = normalizeFields(kind, fields)
  if (!data.complianceLevel) throw new AppError('COMPLIANCE_LEVEL_REQUIRED')
}
export type RecordRow = { id: string; kind: RecordKind; vehicle_id: string | null; data: string; archived: number; version: number; updated: string }
export function fromRow(row: RecordRow): BusinessRecord { return { id: row.id, kind: row.kind, vehicleId: row.vehicle_id, data: JSON.parse(row.data), archived: Boolean(row.archived), version: row.version, updated: row.updated } }

export class Business {
  constructor(readonly store: LocalStore) {}
  get(id: string): BusinessRecord {
    this.store.assertNotDeleted(id)
    const row = this.store.db.prepare('SELECT * FROM records WHERE id=?').get(id) as RecordRow | undefined
    if (!row) throw new AppError('RECORD_NOT_FOUND', 404)
    this.store.assertNotDeleted(row.id, row.vehicle_id)
    return fromRow(row)
  }
  list(kind?: RecordKind, vehicleId?: string): BusinessRecord[] {
    return (this.store.db.prepare('SELECT * FROM records ORDER BY updated DESC,id').all() as RecordRow[]).filter(row => (!kind || row.kind === kind) && (!vehicleId || row.vehicle_id === vehicleId) && !this.store.deletionFor(row.id, row.vehicle_id)).map(fromRow)
  }
  history(vehicleId?: string): Change[] {
    return this.store.db.prepare('SELECT payload FROM changes WHERE (? IS NULL OR vehicle_id=?) ORDER BY created DESC,rowid DESC LIMIT 1000').all(vehicleId || null, vehicleId || null).map(row => JSON.parse(row.payload as string) as Change)
  }
  write({ id = randomUUID(), kind, vehicleId = null, data, actor, reason: explanation, version, archived, sourceId = null, internal = false, maintenance, photoAttachmentId }: {
    id?: string; kind: RecordKind; vehicleId?: string | null; data: Fields; actor: Actor; reason: unknown; version?: number; archived?: boolean; sourceId?: string | null; internal?: boolean; maintenance?: 'restore'; photoAttachmentId?: string
  }): BusinessRecord {
    this.store.assertWritable()
    this.store.assertNotDeleted(id, vehicleId)
    const why = reason(explanation)
    if (photoAttachmentId !== undefined && (kind !== 'vehicle' || parsePhotoAttachmentId(photoAttachmentId) === null)) throw new AppError('INVALID_INPUT')
    // Only trusted photo/restore workflows can change the hidden reference.
    const input = kind === 'vehicle' && !maintenance && data && typeof data === 'object' && !Array.isArray(data) ? Object.fromEntries(Object.entries(data).filter(([key]) => key !== 'photoAttachmentId')) : data
    const normalized = internal ? { ...input } : normalizeFields(kind, input)
    this.store.transaction(() => {
      this.store.assertWritable()
      this.store.assertNotDeleted(id, vehicleId)
      const row = this.store.db.prepare('SELECT * FROM records WHERE id=?').get(id) as RecordRow | undefined
      const before = row ? fromRow(row) : null
      if (before && (before.kind !== kind || before.vehicleId !== vehicleId || before.version !== version)) throw new AppError('VERSION_CONFLICT', 409)
      if (before) {
        const legacyNames = kind === 'vehicle' ? businessFieldRegistry.vehicle.legacy : kind === 'part' ? businessFieldRegistry.part.legacy : businessFieldRegistry.entry.legacy
        if (!internal && maintenance !== 'restore') for (const field of legacyNames) {
          if (Object.hasOwn(before.data, field)) normalized[field] = before.data[field]
          else delete normalized[field]
        }
      }
      if (kind === 'vehicle') {
        if (photoAttachmentId !== undefined) {
          if (photoAttachmentId) {
            const target = this.get(photoAttachmentId), width = Number(target.data.width), height = Number(target.data.height)
            const mime = target.data.mime, filename = String(target.data.name || '').toLowerCase()
            const imageName = mime === 'image/png' ? filename.endsWith('.png') : mime === 'image/jpeg' && /\.jpe?g$/.test(filename)
            if (target.kind !== 'attachment' || target.vehicleId !== id || target.archived || target.data.purpose !== 'vehiclePhoto' || !imageName || !/^[a-f0-9]{64}$/.test(String(target.data.checksum)) || !Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0 || width > PHOTO_MAX_DIMENSION || height > PHOTO_MAX_DIMENSION || width * height > PHOTO_MAX_PIXELS || !Number.isSafeInteger(target.data.size) || Number(target.data.size) <= 0 || Number(target.data.size) > PHOTO_MAX_BYTES) throw new AppError('INVALID_INPUT')
          }
          normalized.photoAttachmentId = photoAttachmentId
        } else if (maintenance === 'restore') {
          const restoredPhotoId = parsePhotoAttachmentId(data.photoAttachmentId)
          if (restoredPhotoId === null) throw new AppError('INVALID_INPUT')
          normalized.photoAttachmentId = restoredPhotoId
        }
        else if (before && Object.hasOwn(before.data, 'photoAttachmentId')) normalized.photoAttachmentId = before.data.photoAttachmentId
        else delete normalized.photoAttachmentId
      }
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
