import { ZipArchive } from 'archiver'
import unzipper from 'unzipper'
import { AppError } from './team.js'
import { Business, checksum, normalizeFields } from './business.js'
import type { Actor, BusinessRecord, Change, Operation, QuarantinedOperation, RestoreResult, VehicleDeletion } from '../shared/business.js'
import type { TeamDocument } from '../shared/types.js'
import { inspectVehiclePhoto, parsePhotoAttachmentId } from '../shared/vehicle-photo.js'

type Manifest = { application: 'stellantis-vehicle-manager'; format: 1 | 2; teamId: string; created: string; records: BusinessRecord[]; changes: Change[]; pendingOperations: Operation[]; deletions?: VehicleDeletion[]; quarantinedOperations?: QuarantinedOperation[]; team?: TeamDocument }

const identifier = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 120
const uuid = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value)
const hashKey = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
const timestamp = (value: unknown): value is string => typeof value === 'string' && value.length <= 64 && Number.isFinite(Date.parse(value))
const actorValue = (value: unknown): value is Actor => object(value) && identifier(value.id) && identifier(value.deviceId) && identifier(value.name) && ['admin', 'member'].includes(String(value.role))
const kinds = ['vehicle', 'part', 'modification', 'equipment', 'report', 'attachment']
function validDeletion(value: unknown): value is VehicleDeletion {
  if (!object(value) || !uuid(value.id) || !uuid(value.requestId) || !uuid(value.vehicleId) || typeof value.vin !== 'string' || !/^[A-HJ-NPR-Z0-9]{17}$/.test(value.vin) || !actorValue(value.actor) || value.actor.role !== 'admin' || typeof value.reason !== 'string' || !value.reason.trim() || value.reason.length > 500 || !timestamp(value.deletedAt) || !uuid(value.revision) || !Number.isSafeInteger(value.sequence) || Number(value.sequence) < 1) return false
  return Array.isArray(value.recordIds) && value.recordIds.length > 0 && value.recordIds.length <= 20000 && value.recordIds.every(identifier) && value.recordIds.includes(value.vehicleId) && new Set(value.recordIds).size === value.recordIds.length && Array.isArray(value.fileKeys) && value.fileKeys.length <= 20000 && value.fileKeys.every(hashKey) && new Set(value.fileKeys).size === value.fileKeys.length
}
function validQuarantine(value: unknown): value is QuarantinedOperation {
  if (!object(value) || !identifier(value.id) || !identifier(value.vehicleId) || value.reason !== 'VEHICLE_DELETED' || !timestamp(value.quarantinedAt) || !object(value.operation)) return false
  const operation = value.operation
  const state = (candidate: unknown) => object(candidate) && object(candidate.data) && typeof candidate.archived === 'boolean'
  return operation.id === value.id && identifier(operation.recordId) && kinds.includes(String(operation.kind)) && (operation.kind === 'vehicle' ? operation.vehicleId === null && operation.recordId === value.vehicleId : operation.vehicleId === value.vehicleId) && (operation.base === null || state(operation.base)) && state(operation.desired) && actorValue(operation.actor) && timestamp(operation.created) && Array.isArray(operation.files) && operation.files.length <= 20000 && operation.files.every(hashKey) && Array.isArray(operation.changes) && operation.changes.length <= 200000 && operation.changes.every(change => object(change) && identifier(change.id) && identifier(change.recordId) && identifier(change.vehicleId) && kinds.includes(String(change.kind)) && (change.before === null || object(change.before)) && object(change.after) && actorValue(change.actor) && typeof change.reason === 'string' && change.reason.length <= 500 && typeof change.action === 'string' && timestamp(change.created))
}

export async function createBackup(business: Business, teamId: string, team?: TeamDocument): Promise<Buffer> {
  const manifest: Manifest = {
    application: 'stellantis-vehicle-manager', format: 2, teamId, created: new Date().toISOString(), records: business.list(),
    changes: business.store.db.prepare('SELECT payload FROM changes ORDER BY created,id').all().map(row => JSON.parse(row.payload as string)),
    pendingOperations: business.store.db.prepare("SELECT payload FROM outbox WHERE state='pending' ORDER BY seq").all().map(row => JSON.parse(row.payload as string)),
    deletions: business.store.deletionRows(), quarantinedOperations: business.store.quarantineRows(), team,
  }
  const archive = new ZipArchive({ zlib: { level: 6 } }), chunks: Buffer[] = []
  let size = 0
  const completed = new Promise<Buffer>((resolve, reject) => {
    archive.on('data', (chunk: Buffer) => { size += chunk.length; if (size > 200 * 1024 * 1024) { archive.abort(); reject(new AppError('BACKUP_TOO_LARGE', 413)) } else chunks.push(chunk) })
    archive.once('error', reject); archive.once('end', () => resolve(Buffer.concat(chunks)))
  })
  try {
    archive.append(JSON.stringify(manifest), { name: 'manifest.json' })
    const keys = new Set(manifest.records.filter(record => ['report', 'attachment'].includes(record.kind)).map(record => String(record.data.checksum)))
    for (const entry of manifest.quarantinedOperations!) for (const key of entry.operation.files) keys.add(key)
    for (const key of keys) archive.append(await business.readBlob(key), { name: `blobs/${key}` })
    void archive.finalize()
    return await completed
  } catch (error) { archive.abort(); throw error }
}

export async function restoreBackup(business: Business, bytes: Buffer, teamId: string, actor: Actor, reason: string): Promise<RestoreResult> {
  if (actor.role !== 'admin') throw new AppError('ADMIN_REQUIRED', 403)
  const zip = await unzipper.Open.buffer(bytes).catch(() => { throw new AppError('INVALID_BACKUP', 422) })
  if (zip.files.length > 20000 || zip.files.reduce((sum, entry) => sum + entry.uncompressedSize, 0) > 200 * 1024 * 1024) throw new AppError('BACKUP_TOO_LARGE', 413)
  const files = new Map<string, Buffer>()
  let totalLength = 0
  for (const file of zip.files) {
    if (file.type === 'Directory') continue
    if (files.has(file.path) || (file.path !== 'manifest.json' && !/^blobs\/[a-f0-9]{64}$/.test(file.path))) throw new AppError('INVALID_BACKUP', 422)
    const chunks: Buffer[] = []; let length = 0
    const limit = file.path === 'manifest.json' ? 20 * 1024 * 1024 : 10 * 1024 * 1024
    for await (const chunk of file.stream()) {
      length += chunk.length
      totalLength += chunk.length
      if (length > limit || totalLength > 200 * 1024 * 1024) throw new AppError('BACKUP_TOO_LARGE', 413)
      chunks.push(Buffer.from(chunk))
    }
    files.set(file.path, Buffer.concat(chunks))
  }
  let manifest: Manifest
  try { manifest = JSON.parse(files.get('manifest.json')!.toString()) as Manifest } catch { throw new AppError('INVALID_BACKUP', 422) }
  if (!object(manifest) || manifest.application !== 'stellantis-vehicle-manager' || ![1, 2].includes(manifest.format) || manifest.teamId !== teamId || (manifest.team && manifest.team.id !== teamId) || !Array.isArray(manifest.records) || manifest.records.length > 20000 || !Array.isArray(manifest.changes) || manifest.changes.length > 200000) throw new AppError('INVALID_BACKUP', 422)
  const deletions = manifest.format === 2 ? manifest.deletions : []
  const quarantine = manifest.format === 2 ? manifest.quarantinedOperations : []
  if (!Array.isArray(deletions) || deletions.length > 20000 || !deletions.every(validDeletion) || new Set(deletions.map(row => row.id)).size !== deletions.length || new Set(deletions.map(row => row.vehicleId)).size !== deletions.length || !Array.isArray(quarantine) || quarantine.length > 200000 || !quarantine.every(validQuarantine) || new Set(quarantine.map(row => row.id)).size !== quarantine.length) throw new AppError('INVALID_BACKUP', 422)
  const canonicalDeletions = business.store.deletionRows()
  const markerByRecord = new Map(canonicalDeletions.flatMap(row => row.recordIds.map(id => [id, row] as const)))
  const deletedIds = new Set([...canonicalDeletions, ...deletions].flatMap(row => row.recordIds))
  const deletedVehicles = new Set([...canonicalDeletions, ...deletions].map(row => row.vehicleId))
  const importedDeletions = deletions.filter(deletion => !markerByRecord.has(deletion.vehicleId))
  const liveRecords = business.list(), liveIds = new Set(liveRecords.map(record => record.id)), liveParentIds = new Set(liveRecords.map(record => record.vehicleId))
  for (const deletion of deletions) {
    // A backup may preserve an absent vehicle's marker, never delete a live row.
    if (liveIds.has(deletion.vehicleId) || liveParentIds.has(deletion.vehicleId) || deletion.recordIds.some(id => liveIds.has(id))) throw new AppError('BACKUP_DELETION_CONFLICT', 409)
    const existing = markerByRecord.get(deletion.vehicleId)
    if (existing && JSON.stringify(existing) !== JSON.stringify(deletion)) throw new AppError('INVALID_BACKUP', 422)
    for (const id of deletion.recordIds) {
      const owner = markerByRecord.get(id)
      if (owner && owner.id !== deletion.id) throw new AppError('INVALID_BACKUP', 422)
      markerByRecord.set(id, deletion)
    }
  }
  for (const entry of quarantine) {
    if (!deletedVehicles.has(entry.vehicleId)) throw new AppError('INVALID_BACKUP', 422)
    for (const key of entry.operation.files) {
      const bytes = files.get(`blobs/${key}`)
      if (!bytes || checksum(bytes) !== key) throw new AppError('INVALID_BACKUP', 422)
    }
    if (['report', 'attachment'].includes(entry.operation.kind)) {
      const data = entry.operation.desired.data, key = data.checksum
      if (!hashKey(key) || !entry.operation.files.includes(key) || files.get(`blobs/${key}`)?.length !== data.size) throw new AppError('INVALID_BACKUP', 422)
    }
  }
  const ids = new Set<string>()
  for (const record of manifest.records) {
    if (!object(record) || !identifier(record.id) || ids.has(record.id) || typeof record.archived !== 'boolean' || !object(record.data)) throw new AppError('INVALID_BACKUP', 422)
    const marker = markerByRecord.get(record.id)
    if (marker && marker.vehicleId !== (record.kind === 'vehicle' ? record.id : record.vehicleId)) throw new AppError('INVALID_BACKUP', 422)
    ids.add(record.id)
    if (['vehicle', 'part', 'modification', 'equipment'].includes(record.kind)) record.data = normalizeFields(record.kind, record.data)
    else if (record.kind === 'report' || record.kind === 'attachment') {
      const file = files.get(`blobs/${record.data.checksum}`)
      if (!file || checksum(file) !== record.data.checksum || file.length !== record.data.size || (record.kind === 'report' && (!record.data.parsed || !Array.isArray((record.data.parsed as { controllers?: unknown }).controllers) || !Array.isArray((record.data.parsed as { faults?: unknown }).faults)))) throw new AppError('INVALID_BACKUP', 422)
    } else throw new AppError('INVALID_BACKUP', 422)
  }
  for (const record of manifest.records) if ((record.kind !== 'vehicle' && (!record.vehicleId || !ids.has(record.vehicleId))) || (record.kind === 'vehicle' && record.vehicleId)) throw new AppError('INVALID_BACKUP', 422)
  // Vehicle rows are restored before children. Validate managed references against
  // the complete manifest first, rather than the old/current working database.
  const recordsById = new Map(manifest.records.map(record => [record.id, record]))
  for (const vehicle of manifest.records.filter(record => record.kind === 'vehicle')) {
    const reference = parsePhotoAttachmentId(vehicle.data.photoAttachmentId)
    if (reference === null) throw new AppError('INVALID_BACKUP', 422)
    if (!reference) continue
    const attachment = recordsById.get(reference)
    if (!attachment || attachment.kind !== 'attachment' || attachment.vehicleId !== vehicle.id || attachment.data.purpose !== 'vehiclePhoto') throw new AppError('INVALID_BACKUP', 422)
    const bytes = files.get(`blobs/${attachment.data.checksum}`)
    const image = bytes && inspectVehiclePhoto(bytes)
    if (!image || attachment.data.mime !== image.mime || attachment.data.width !== image.width || attachment.data.height !== image.height || !(image.mime === 'image/png' ? /\.png$/i : /\.jpe?g$/i).test(String(attachment.data.name))) throw new AppError('INVALID_BACKUP', 422)
  }
  if (business.store.db.prepare("SELECT id FROM outbox WHERE state='pending' LIMIT 1").get()) throw new AppError('PENDING_BEFORE_RESTORE', 409)
  const skipped = manifest.records.filter(record => deletedIds.has(record.id) || (record.vehicleId !== null && deletedVehicles.has(record.vehicleId)))
  const skippedVehicleIds = [...new Set(skipped.map(record => record.kind === 'vehicle' ? record.id : record.vehicleId!))]
  const skippedIds = new Set(skipped.map(record => record.id))
  const ordered = manifest.records.filter(record => !skippedIds.has(record.id)).toSorted((left, right) => Number(right.kind === 'vehicle') - Number(left.kind === 'vehicle'))
  const summary: RestoreResult = { changed: 0, skippedVehicles: skippedVehicleIds.length, skippedRecords: skipped.length, skippedVehicleIds }
  // Blobs are immutable; retain quarantined originals but never replay their operations.
  const blobKeys = new Set(ordered.filter(record => ['report', 'attachment'].includes(record.kind)).map(record => String(record.data.checksum)))
  for (const entry of quarantine) for (const key of entry.operation.files) blobKeys.add(key)
  for (const key of blobKeys) await business.blob(files.get(`blobs/${key}`)!)
  let changed = 0
  business.store.transaction(() => {
    const pendingImports = business.store.get<Array<{ deletion: VehicleDeletion; actor: Actor }>>('pendingDeletionImports') || []
    for (const deletion of importedDeletions) {
      const existing = pendingImports.find(entry => entry.deletion.vehicleId === deletion.vehicleId || entry.deletion.id === deletion.id)
      if (existing && JSON.stringify(existing.deletion) !== JSON.stringify(deletion)) throw new AppError('INVALID_BACKUP', 422)
      if (!existing) pendingImports.push({ deletion, actor })
    }
    if (importedDeletions.length) business.store.set('pendingDeletionImports', pendingImports)
    business.store.applyDeletions(deletions)
    business.store.importQuarantine(quarantine)
    const previousSequence = business.store.db.prepare('SELECT COALESCE(MAX(seq),0) AS seq FROM outbox').get()!.seq as number
    for (const record of ordered) {
      const exists = business.store.db.prepare('SELECT id FROM records WHERE id=?').get(record.id)
      const current = exists ? business.get(record.id) : null
      const targetArchived = record.kind === 'vehicle' ? false : record.archived
      if (current && JSON.stringify(current.data) === JSON.stringify(record.data) && current.archived === targetArchived) continue
      if (record.kind !== 'vehicle') {
        const parent = business.get(record.vehicleId!)
        if (parent.archived && !record.archived) throw new AppError('INVALID_BACKUP', 422)
      }
      business.write({ id: record.id, kind: record.kind, vehicleId: record.vehicleId, data: record.data, version: current?.version, archived: targetArchived, actor, reason: `Restore: ${reason}`, internal: ['report', 'attachment'].includes(record.kind), maintenance: 'restore' })
      changed++
    }
    const extras = business.list().filter(record => !ids.has(record.id) && !record.archived).sort((left, right) => Number(left.kind === 'vehicle') - Number(right.kind === 'vehicle'))
    for (const record of extras) { business.write({ id: record.id, kind: record.kind, vehicleId: record.vehicleId, data: record.data, version: record.version, archived: true, actor, reason: `Restore archive: ${reason}`, internal: ['report', 'attachment'].includes(record.kind), maintenance: 'restore' }); changed++ }
    for (const record of ordered.filter(record => record.kind === 'vehicle' && record.archived)) {
      const current = business.get(record.id)
      business.write({ id: current.id, kind: 'vehicle', data: current.data, version: current.version, archived: true, actor, reason: `Restore archive state: ${reason}`, maintenance: 'restore' }); changed++
    }
    const historical = manifest.changes.filter(change => object(change) && identifier(change.id) && identifier(change.recordId) && (ids.has(change.recordId) || deletedIds.has(change.recordId) || deletedVehicles.has(change.vehicleId)) && identifier(change.vehicleId) && timestamp(change.created))
    for (const change of historical) business.store.db.prepare('INSERT OR IGNORE INTO changes VALUES(?,?,?,?,?)').run(change.id, change.recordId, change.vehicleId, JSON.stringify(change), change.created)
    const first = business.store.db.prepare('SELECT id,payload FROM outbox WHERE seq>? ORDER BY seq LIMIT 1').get(previousSequence)
    if (first) {
      const operation = JSON.parse(first.payload as string) as Operation
      operation.changes.push(...historical.filter(change => !operation.changes.some(existing => existing.id === change.id)))
      business.store.db.prepare('UPDATE outbox SET payload=? WHERE id=?').run(JSON.stringify(operation), first.id)
    }
    summary.changed = changed
    business.store.event(actor.id, 'backup.restored', { reason, ...summary, teamId })
  })
  return summary
}
