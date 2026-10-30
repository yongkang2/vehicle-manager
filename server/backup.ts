import { ZipArchive } from 'archiver'
import path from 'node:path'
import { Transform } from 'node:stream'
import unzipper from 'unzipper'
import { AppError } from './team.js'
import { Business, checksum, normalizeFields } from './business.js'
import type { Actor, BusinessRecord, Change, Operation, QuarantinedOperation, RestorePreview, RestoreResult, VehicleDeletion } from '../shared/business.js'
import { businessFieldRegistry, validReportAssociation } from '../shared/business.js'
import type { TeamDocument } from '../shared/types.js'
import { inspectVehiclePhoto, parsePhotoAttachmentId } from '../shared/vehicle-photo.js'
import { appVersion } from '../shared/version.js'
import { randomUUID } from 'node:crypto'
import { isProtectedKind, validateComponentTypeRecord, validateConfigurationRecords, validateConfigurationRevisionRecord, validateConfigurationReceiptEntry } from '../shared/configuration-revisions.js'

export type ConfigurationReceiptEntry = { key: string; value: string }
export type PendingConfigurationImport = { id: string; records: BusinessRecord[]; actor: Actor; reason: string; receipts: ConfigurationReceiptEntry[] }
type Manifest = { application: 'stellantis-vehicle-manager'; format: 1 | 2 | 3 | 4; teamId: string; created: string; appVersion?: string; schemaVersion?: number; fieldVersion?: number; recordCounts?: Record<string, number>; records: BusinessRecord[]; changes: Change[]; pendingOperations: Operation[]; deletions?: VehicleDeletion[]; quarantinedOperations?: QuarantinedOperation[]; configurationReceipts?: ConfigurationReceiptEntry[]; team?: TeamDocument }
const maximumFiles = 20000, maximumManifestBytes = 20 * 1024 * 1024, maximumBlobBytes = 10 * 1024 * 1024, maximumTotalBytes = 200 * 1024 * 1024

const identifier = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 120
const uuid = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value)
const hashKey = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
const timestamp = (value: unknown): value is string => typeof value === 'string' && value.length <= 64 && Number.isFinite(Date.parse(value))
const actorValue = (value: unknown): value is Actor => object(value) && identifier(value.id) && identifier(value.deviceId) && identifier(value.name) && ['admin', 'member'].includes(String(value.role))
const kinds = ['vehicle', 'part', 'modification', 'equipment', 'report', 'attachment']
const manifestKinds = [...kinds, 'configurationRevision', 'componentType']
const configurationConflict = () => new AppError('BACKUP_CONFIGURATION_CONFLICT', 409)
const sameValue = (left: unknown, right: unknown): boolean => {
  const stable = (value: unknown): unknown => Array.isArray(value) ? value.map(stable) : object(value) ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value
  return JSON.stringify(stable(left)) === JSON.stringify(stable(right))
}
function configurationReceipts(input: unknown): ConfigurationReceiptEntry[] {
  if (!Array.isArray(input) || input.length > 200000) throw new AppError('INVALID_BACKUP', 422)
  const seen = new Set<string>()
  for (const entry of input) {
    if (!object(entry) || typeof entry.key !== 'string' || !entry.key.startsWith('configurationRequest:') || !uuid(entry.key.slice('configurationRequest:'.length)) || seen.has(entry.key) || typeof entry.value !== 'string' || entry.value.length > maximumManifestBytes) throw new AppError('INVALID_BACKUP', 422)
    try { validateConfigurationReceiptEntry(entry as ConfigurationReceiptEntry) } catch { throw new AppError('INVALID_BACKUP', 422) }
    let value: Record<string, unknown>
    try { value = JSON.parse(entry.value) as Record<string, unknown> } catch { throw new AppError('INVALID_BACKUP', 422) }
    if (!object(value) || typeof value.actorKey !== 'string' || !value.actorKey || value.actorKey.length > 500 || !hashKey(value.commandDigest) || !['enable', 'createType', 'updateType', 'publish'].includes(String(value.kind)) || !object(value.receipt)) throw new AppError('INVALID_BACKUP', 422)
    if (value.kind === 'publish') {
      const receipt = value.receipt
      if (receipt.requestId !== entry.key.slice('configurationRequest:'.length) || !identifier(receipt.revisionId) || !uuid(receipt.vehicleId) || !Number.isSafeInteger(receipt.number) || Number(receipt.number) < 1 || receipt.label !== `R${String(receipt.number).padStart(2, '0')}` || !timestamp(receipt.publishedAt)) throw new AppError('INVALID_BACKUP', 422)
    }
    seen.add(entry.key)
  }
  return input as ConfigurationReceiptEntry[]
}
function protectedRecord(record: BusinessRecord): void {
  try {
    if (!Number.isSafeInteger(record.version) || record.version < 1 || !timestamp(record.updated)) throw new Error('invalid record envelope')
    if (record.kind === 'componentType') validateComponentTypeRecord(record)
    else validateConfigurationRevisionRecord(record)
  } catch { throw new AppError('INVALID_BACKUP', 422) }
}
/** Preserve canonical catalog state and immutable history; never use ordinary restore writes. */
function prepareConfigurationImport(current: BusinessRecord[], incoming: BusinessRecord[], deletedIds: Set<string>, deletedVehicles: Set<string>, receipts: ConfigurationReceiptEntry[], knownReceipts: ConfigurationReceiptEntry[]) {
  const union = new Map(current.map(record => [record.id, record])), additions: BusinessRecord[] = []
  for (const record of incoming.filter(record => isProtectedKind(record.kind))) {
    protectedRecord(record)
    if (deletedIds.has(record.id) || (record.vehicleId && deletedVehicles.has(record.vehicleId))) continue
    const existing = union.get(record.id)
    if (existing) {
      if (existing.kind !== record.kind || existing.vehicleId !== record.vehicleId || (record.kind === 'configurationRevision' && !sameValue(existing.data, record.data))) throw configurationConflict()
      // Type IDs retain their canonical definition: old backup labels/disabled flags
      // cannot rename or reactivate a type that administrators changed afterward.
      continue
    }
    union.set(record.id, record); additions.push(record)
  }
  for (const record of incoming.filter(record => !isProtectedKind(record.kind))) {
    if (deletedIds.has(record.id) || (record.vehicleId && deletedVehicles.has(record.vehicleId))) continue
    if (union.get(record.id) && isProtectedKind(union.get(record.id)!.kind)) throw configurationConflict()
    union.set(record.id, record)
  }
  try { validateConfigurationRecords([...union.values()]) } catch { throw configurationConflict() }
  const known = new Map(knownReceipts.map(entry => [entry.key, entry.value])), receiptAdditions: ConfigurationReceiptEntry[] = []
  for (const entry of receipts) {
    if (known.has(entry.key) && known.get(entry.key) !== entry.value) throw configurationConflict()
    const value = JSON.parse(entry.value) as { kind: string; receipt: Record<string, unknown> }
    if (value.kind === 'publish') {
      const receipt = value.receipt, revision = union.get(String(receipt.revisionId))
      if (revision) {
        if (revision.kind !== 'configurationRevision' || revision.vehicleId !== receipt.vehicleId || revision.data.number !== receipt.number || revision.data.label !== receipt.label || revision.data.publishedAt !== receipt.publishedAt) throw configurationConflict()
      } else if (!deletedVehicles.has(String(receipt.vehicleId)) || !deletedIds.has(String(receipt.revisionId))) throw configurationConflict()
    }
    if (!known.has(entry.key)) { known.set(entry.key, entry.value); receiptAdditions.push(entry) }
  }
  return { records: additions, receipts: receiptAdditions }
}
function validDeletion(value: unknown): value is VehicleDeletion {
  if (!object(value) || !uuid(value.id) || !uuid(value.requestId) || !uuid(value.vehicleId) || typeof value.vin !== 'string' || !/^[A-HJ-NPR-Z0-9]{17}$/.test(value.vin) || !actorValue(value.actor) || value.actor.role !== 'admin' || typeof value.reason !== 'string' || !value.reason.trim() || value.reason.length > 500 || !timestamp(value.deletedAt) || !uuid(value.revision) || !Number.isSafeInteger(value.sequence) || Number(value.sequence) < 1) return false
  return Array.isArray(value.recordIds) && value.recordIds.length > 0 && value.recordIds.length <= 20000 && value.recordIds.every(identifier) && value.recordIds.includes(value.vehicleId) && new Set(value.recordIds).size === value.recordIds.length && Array.isArray(value.fileKeys) && value.fileKeys.length <= 20000 && value.fileKeys.every(hashKey) && new Set(value.fileKeys).size === value.fileKeys.length
}
function validQuarantine(value: unknown): value is QuarantinedOperation {
  if (!object(value) || !identifier(value.id) || !identifier(value.vehicleId) || value.reason !== 'VEHICLE_DELETED' || !timestamp(value.quarantinedAt) || !object(value.operation)) return false
  const operation = value.operation
  const state = (candidate: unknown) => object(candidate) && object(candidate.data) && typeof candidate.archived === 'boolean'
  return operation.id === value.id && identifier(operation.recordId) && kinds.includes(String(operation.kind)) && (operation.kind === 'vehicle' ? operation.vehicleId === null && operation.recordId === value.vehicleId : operation.vehicleId === value.vehicleId) && (operation.base === null || state(operation.base)) && state(operation.desired) && actorValue(operation.actor) && timestamp(operation.created) && Array.isArray(operation.files) && operation.files.length <= 20000 && operation.files.every(hashKey) && Array.isArray(operation.changes) && operation.changes.length <= 200000 && operation.changes.every(change => object(change) && identifier(change.id) && identifier(change.recordId) && identifier(change.vehicleId) && manifestKinds.includes(String(change.kind)) && (change.before === null || object(change.before)) && object(change.after) && actorValue(change.actor) && typeof change.reason === 'string' && change.reason.length <= 500 && typeof change.action === 'string' && timestamp(change.created))
}

export async function createBackupStream(business: Business, teamId: string, team?: TeamDocument): Promise<Transform> {
  const pendingImports = business.store.get<PendingConfigurationImport[]>('pendingConfigurationImports') || []
  const deletions = business.store.deletionRows(), deletedIds = new Set(deletions.flatMap(marker => marker.recordIds)), deletedVehicles = new Set(deletions.map(marker => marker.vehicleId))
  const existing = business.list(), staged = pendingImports.flatMap(entry => entry.records)
  const imported = prepareConfigurationImport(existing, staged, deletedIds, deletedVehicles, [], [])
  const records = [...existing, ...imported.records]
  const receiptByKey = new Map<string, string>()
  for (const entry of [...(business.store.get<ConfigurationReceiptEntry[]>('configurationReceipts') || []), ...pendingImports.flatMap(entry => entry.receipts || [])]) {
    if (receiptByKey.has(entry.key) && receiptByKey.get(entry.key) !== entry.value) throw configurationConflict()
    receiptByKey.set(entry.key, entry.value)
  }
  const receipts = configurationReceipts([...receiptByKey].map(([key, value]) => ({ key, value })))
  prepareConfigurationImport(records, [], deletedIds, deletedVehicles, receipts, [])
  const changes = business.store.db.prepare('SELECT payload FROM changes ORDER BY created,id').all().map(row => JSON.parse(row.payload as string))
  const pendingOperations = business.store.db.prepare("SELECT payload FROM outbox WHERE state='pending' ORDER BY seq").all().map(row => JSON.parse(row.payload as string))
  if (records.length > 20000 || changes.length > 200000) throw new AppError('BACKUP_TOO_LARGE', 413)
  const recordCounts = Object.fromEntries(manifestKinds.map(kind => [kind, records.filter(record => record.kind === kind).length]))
  const manifest: Manifest = {
    application: 'stellantis-vehicle-manager', format: 4, teamId, created: new Date().toISOString(), appVersion, schemaVersion: business.store.db.prepare('PRAGMA user_version').get()!.user_version as number, fieldVersion: 2, recordCounts, records, changes, pendingOperations,
    deletions, quarantinedOperations: business.store.quarantineRows(), configurationReceipts: receipts, team,
  }
  const manifestBytes = Buffer.from(JSON.stringify(manifest))
  if (manifestBytes.length > maximumManifestBytes) throw new AppError('BACKUP_TOO_LARGE', 413)
  const keys = new Set(records.filter(record => ['report', 'attachment'].includes(record.kind)).map(record => String(record.data.checksum)))
  for (const entry of manifest.quarantinedOperations!) for (const key of entry.operation.files) keys.add(key)
  if (keys.size + 1 > maximumFiles) throw new AppError('BACKUP_TOO_LARGE', 413)
  let uncompressedBytes = manifestBytes.length
  for (const key of keys) {
    const bytes = await business.readBlob(key)
    if (bytes.length > maximumBlobBytes || (uncompressedBytes += bytes.length) > maximumTotalBytes) throw new AppError('BACKUP_TOO_LARGE', 413)
  }
  const archive = new ZipArchive({ zlib: { level: 6 } })
  let compressedBytes = 0
  const output = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      compressedBytes += chunk.length
      callback(compressedBytes > maximumTotalBytes ? new AppError('BACKUP_TOO_LARGE', 413) : null, chunk)
    },
  })
  archive.on('error', error => output.destroy(error))
  output.on('error', () => archive.abort())
  archive.pipe(output)
  archive.append(manifestBytes, { name: 'manifest.json' })
  for (const key of keys) archive.file(path.join(business.store.directory, 'blobs', key), { name: `blobs/${key}` })
  void archive.finalize().catch(error => output.destroy(error))
  return output
}

export async function createBackup(business: Business, teamId: string, team?: TeamDocument): Promise<Buffer> {
  const stream = await createBackupStream(business, teamId, team), chunks: Buffer[] = []
  for await (const chunk of stream) chunks.push(Buffer.from(chunk))
  return Buffer.concat(chunks)
}

export async function previewBackup(business: Business, bytes: Buffer, teamId: string): Promise<RestorePreview> {
  if (bytes.length > maximumTotalBytes) throw new AppError('BACKUP_TOO_LARGE', 413)
  const zip = await unzipper.Open.buffer(bytes).catch(() => { throw new AppError('INVALID_BACKUP', 422) })
  if (zip.files.length > maximumFiles || zip.files.reduce((sum, entry) => sum + entry.uncompressedSize, 0) > maximumTotalBytes) throw new AppError('BACKUP_TOO_LARGE', 413)
  const entry = zip.files.find(file => file.path === 'manifest.json')
  if (!entry || entry.uncompressedSize > maximumManifestBytes) throw new AppError('INVALID_BACKUP', 422)
  const chunks: Buffer[] = []
  let manifestLength = 0
  try {
    for await (const chunk of entry.stream()) {
      manifestLength += chunk.length
      if (manifestLength > maximumManifestBytes) throw new AppError('BACKUP_TOO_LARGE', 413)
      chunks.push(Buffer.from(chunk))
    }
  } catch (error) {
    if (error instanceof AppError) throw error
    throw new AppError('INVALID_BACKUP', 422)
  }
  let manifest: Manifest
  try { manifest = JSON.parse(Buffer.concat(chunks).toString()) as Manifest } catch { throw new AppError('INVALID_BACKUP', 422) }
  if (!object(manifest) || manifest.application !== 'stellantis-vehicle-manager' || ![1, 2, 3, 4].includes(manifest.format) || manifest.teamId !== teamId || (manifest.team && manifest.team.id !== teamId) || !Array.isArray(manifest.records) || manifest.records.length > 20000 || !Array.isArray(manifest.changes) || manifest.changes.length > 200000) throw new AppError('INVALID_BACKUP', 422)
  if (manifest.format >= 3 && (typeof manifest.appVersion !== 'string' || !/^\d+\.\d+\.\d+$/.test(manifest.appVersion) || !Number.isSafeInteger(manifest.schemaVersion) || Number(manifest.schemaVersion) > 5 || !Number.isSafeInteger(manifest.fieldVersion) || Number(manifest.fieldVersion) > 2 || !object(manifest.recordCounts))) throw new AppError('INVALID_BACKUP', 422)
  if (manifest.format === 4 && (manifest.schemaVersion !== 5 || manifest.fieldVersion !== 2)) throw new AppError('INVALID_BACKUP', 422)
  const receipts = manifest.format === 4 ? configurationReceipts(manifest.configurationReceipts) : []
  const current = business.list(), currentById = new Map(current.map(record => [record.id, record]))
  const incomingIds = new Set<string>(), conflicts: string[] = [], droppedFields: RestorePreview['droppedFields'] = []
  let additions = 0, changes = 0
  const vins = new Map(current.filter(record => record.kind === 'vehicle').map(record => [String(record.data.vin), record.id]))
  for (const record of manifest.records) {
    if (!object(record) || !identifier(record.id) || incomingIds.has(record.id) || !object(record.data) || !(manifest.format === 4 ? manifestKinds : kinds).includes(String(record.kind))) throw new AppError('INVALID_BACKUP', 422)
    if (isProtectedKind(record.kind)) protectedRecord(record)
    incomingIds.add(record.id)
    const existing = currentById.get(record.id)
    if (!existing) additions++
    else if (existing.kind !== record.kind || existing.vehicleId !== record.vehicleId) conflicts.push(record.id)
    else if (!isProtectedKind(record.kind) && (JSON.stringify(existing.data) !== JSON.stringify(record.data) || existing.archived !== record.archived)) changes++
    if (record.kind === 'vehicle') {
      const vin = String(record.data.vin || '')
      const owner = vins.get(vin)
      if (owner && owner !== record.id) conflicts.push(`VIN:${vin}`)
      vins.set(vin, record.id)
    }
    if (['vehicle', 'part', 'modification', 'equipment'].includes(record.kind)) {
      const registry = record.kind === 'vehicle' ? businessFieldRegistry.vehicle : record.kind === 'part' ? businessFieldRegistry.part : businessFieldRegistry.entry
      const allowed = new Set([...registry.active, ...registry.legacy, ...(record.kind === 'vehicle' ? ['photoAttachmentId'] : [])])
      const fields = Object.keys(record.data).filter(field => !allowed.has(field))
      if (fields.length) droppedFields.push({ recordId: record.id, fields })
    }
  }
  const deletions = manifest.format >= 2 ? manifest.deletions : []
  if (!Array.isArray(deletions) || deletions.length > 20000 || !deletions.every(validDeletion)) throw new AppError('INVALID_BACKUP', 422)
  const liveIds = new Set(current.map(record => record.id)), liveParents = new Set(current.map(record => record.vehicleId))
  for (const deletion of deletions) if (liveIds.has(deletion.vehicleId) || liveParents.has(deletion.vehicleId) || deletion.recordIds.some(id => liveIds.has(id))) conflicts.push(`DELETION:${deletion.vehicleId}`)
  const allDeletions = [...business.store.deletionRows(), ...deletions], deleted = new Set(allDeletions.flatMap(row => row.recordIds))
  try {
    const prepared = prepareConfigurationImport(current, manifest.records, deleted, new Set(allDeletions.map(row => row.vehicleId)), receipts, business.store.get<ConfigurationReceiptEntry[]>('configurationReceipts') || [])
    if ((prepared.records.length || prepared.receipts.length || manifest.records.some(record => !deleted.has(record.id) && record.kind === 'part' && record.data.category === 'component')) && business.store.get<number>('businessProtocol') !== 3) throw new AppError('CONFIGURATION_NOT_ENABLED', 409)
  } catch (error) {
    if (error instanceof AppError && error.code === 'BACKUP_CONFIGURATION_CONFLICT') conflicts.push('CONFIGURATION_HISTORY')
    else throw error
  }
  const recordsById = new Map(current.map(record => [record.id, record]))
  const archiveCandidates = current.filter(record => !isProtectedKind(record.kind) && !record.archived && !incomingIds.has(record.id) && !deleted.has(record.id) && (record.kind === 'vehicle' || Boolean(record.vehicleId && incomingIds.has(record.vehicleId)))).map(record => ({ id: record.id, kind: record.kind, name: String(record.data.name || record.id), parentName: record.vehicleId ? String(recordsById.get(record.vehicleId)?.data.name || record.vehicleId) : null, relatedRecords: record.kind === 'vehicle' ? current.filter(child => !isProtectedKind(child.kind) && child.vehicleId === record.id && !child.archived && !incomingIds.has(child.id) && !deleted.has(child.id)).length : 0 }))
  const pending = business.store.db.prepare("SELECT id,record_id,payload FROM outbox WHERE state='pending' ORDER BY seq").all()
  const fingerprint = checksum(JSON.stringify({ backup: checksum(bytes), current: current.map(record => [record.id, record.kind, record.vehicleId, record.version, record.archived, record.data]), deletions: business.store.deletionRows(), pending }))
  return { appVersion: typeof manifest.appVersion === 'string' ? manifest.appVersion : null, records: manifest.records.length, additions, changes, archiveCandidates, droppedFields, conflicts: [...new Set(conflicts)], fingerprint }
}

export async function restoreBackup(business: Business, bytes: Buffer, teamId: string, actor: Actor, reason: string, archiveRecordIds: string[] = []): Promise<RestoreResult> {
  if (actor.role !== 'admin') throw new AppError('ADMIN_REQUIRED', 403)
  const zip = await unzipper.Open.buffer(bytes).catch(() => { throw new AppError('INVALID_BACKUP', 422) })
  if (zip.files.length > maximumFiles || zip.files.reduce((sum, entry) => sum + entry.uncompressedSize, 0) > maximumTotalBytes) throw new AppError('BACKUP_TOO_LARGE', 413)
  const files = new Map<string, Buffer>()
  let totalLength = 0
  for (const file of zip.files) {
    if (file.type === 'Directory') continue
    if (files.has(file.path) || (file.path !== 'manifest.json' && !/^blobs\/[a-f0-9]{64}$/.test(file.path))) throw new AppError('INVALID_BACKUP', 422)
    const chunks: Buffer[] = []; let length = 0
    const limit = file.path === 'manifest.json' ? maximumManifestBytes : maximumBlobBytes
    for await (const chunk of file.stream()) {
      length += chunk.length
      totalLength += chunk.length
      if (length > limit || totalLength > maximumTotalBytes) throw new AppError('BACKUP_TOO_LARGE', 413)
      chunks.push(Buffer.from(chunk))
    }
    files.set(file.path, Buffer.concat(chunks))
  }
  let manifest: Manifest
  try { manifest = JSON.parse(files.get('manifest.json')!.toString()) as Manifest } catch { throw new AppError('INVALID_BACKUP', 422) }
  if (!object(manifest) || manifest.application !== 'stellantis-vehicle-manager' || ![1, 2, 3, 4].includes(manifest.format) || manifest.teamId !== teamId || (manifest.team && manifest.team.id !== teamId) || !Array.isArray(manifest.records) || manifest.records.length > 20000 || !Array.isArray(manifest.changes) || manifest.changes.length > 200000) throw new AppError('INVALID_BACKUP', 422)
  if (manifest.format >= 3 && (typeof manifest.appVersion !== 'string' || !/^\d+\.\d+\.\d+$/.test(manifest.appVersion) || !Number.isSafeInteger(manifest.schemaVersion) || Number(manifest.schemaVersion) > 5 || !Number.isSafeInteger(manifest.fieldVersion) || Number(manifest.fieldVersion) > 2 || !object(manifest.recordCounts))) throw new AppError('INVALID_BACKUP', 422)
  if (manifest.format === 4 && (manifest.schemaVersion !== 5 || manifest.fieldVersion !== 2)) throw new AppError('INVALID_BACKUP', 422)
  const receipts = manifest.format === 4 ? configurationReceipts(manifest.configurationReceipts) : []
  const deletions = manifest.format >= 2 ? manifest.deletions : []
  const quarantine = manifest.format >= 2 ? manifest.quarantinedOperations : []
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
      if (entry.operation.kind === 'report' && Object.hasOwn(data, 'association') && !validReportAssociation({ id: entry.operation.recordId, kind: 'report', vehicleId: entry.operation.vehicleId, data, archived: entry.operation.desired.archived, version: 1, updated: entry.operation.created })) throw new AppError('INVALID_BACKUP', 422)
    }
  }
  const ids = new Set<string>()
  for (const record of manifest.records) {
    if (!object(record) || !identifier(record.id) || ids.has(record.id) || typeof record.archived !== 'boolean' || !object(record.data) || !(manifest.format === 4 ? manifestKinds : kinds).includes(String(record.kind))) throw new AppError('INVALID_BACKUP', 422)
    const marker = markerByRecord.get(record.id)
    if (marker && marker.vehicleId !== (record.kind === 'vehicle' ? record.id : record.vehicleId)) throw new AppError('INVALID_BACKUP', 422)
    ids.add(record.id)
    if (['vehicle', 'part', 'modification', 'equipment'].includes(record.kind)) record.data = normalizeFields(record.kind, record.data)
    else if (record.kind === 'report' || record.kind === 'attachment') {
      const file = files.get(`blobs/${record.data.checksum}`)
      if (!file || checksum(file) !== record.data.checksum || file.length !== record.data.size || (record.kind === 'report' && (!record.data.parsed || !Array.isArray((record.data.parsed as { controllers?: unknown }).controllers) || !Array.isArray((record.data.parsed as { faults?: unknown }).faults)))) throw new AppError('INVALID_BACKUP', 422)
      if (record.kind === 'report' && Object.hasOwn(record.data, 'association') && !validReportAssociation(record)) throw new AppError('INVALID_BACKUP', 422)
    } else if (isProtectedKind(record.kind)) protectedRecord(record)
    else throw new AppError('INVALID_BACKUP', 422)
  }
  for (const record of manifest.records) if ((record.kind !== 'vehicle' && record.kind !== 'componentType' && (!record.vehicleId || !ids.has(record.vehicleId))) || ((record.kind === 'vehicle' || record.kind === 'componentType') && record.vehicleId)) throw new AppError('INVALID_BACKUP', 422)
  // Vehicle rows are restored before children. Validate managed references against
  // the complete manifest first, rather than the old/current working database.
  const recordsById = new Map(manifest.records.map(record => [record.id, record]))
  for (const report of manifest.records.filter(record => record.kind === 'report' && Object.hasOwn(record.data, 'association'))) {
    if (recordsById.get(report.vehicleId!)?.kind !== 'vehicle') throw new AppError('INVALID_BACKUP', 422)
  }
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
  if (business.store.db.prepare("SELECT id FROM outbox WHERE state='pending' LIMIT 1").get() || (business.store.get<PendingConfigurationImport[]>('pendingConfigurationImports') || []).length) throw new AppError('PENDING_BEFORE_RESTORE', 409)
  const skipped = manifest.records.filter(record => deletedIds.has(record.id) || (record.vehicleId !== null && deletedVehicles.has(record.vehicleId)))
  const skippedVehicleIds = [...new Set(skipped.map(record => record.kind === 'vehicle' ? record.id : record.vehicleId!))]
  const currentRecords = business.list()
  const protectedImport = prepareConfigurationImport(currentRecords, manifest.records, deletedIds, deletedVehicles, receipts, configurationReceipts(business.store.get<ConfigurationReceiptEntry[]>('configurationReceipts') || []))
  const needsConfiguration = protectedImport.records.length || protectedImport.receipts.length || manifest.records.some(record => !deletedIds.has(record.id) && record.kind === 'part' && record.data.category === 'component')
  if (needsConfiguration && business.store.get<number>('businessProtocol') !== 3) throw new AppError('CONFIGURATION_NOT_ENABLED', 409)
  const archiveCandidates = currentRecords.filter(record => !isProtectedKind(record.kind) && !record.archived && !ids.has(record.id) && !deletedIds.has(record.id) && (record.kind === 'vehicle' || Boolean(record.vehicleId && ids.has(record.vehicleId))))
  if (!Array.isArray(archiveRecordIds) || archiveRecordIds.some(id => typeof id !== 'string') || new Set(archiveRecordIds).size !== archiveRecordIds.length || archiveRecordIds.some(id => !archiveCandidates.some(record => record.id === id))) throw new AppError('RESTORE_PREVIEW_CHANGED', 409)
  if (archiveCandidates.some(record => !archiveRecordIds.includes(record.id))) throw new AppError('RESTORE_ARCHIVE_CONFIRMATION_REQUIRED', 409)
  const skippedIds = new Set(skipped.map(record => record.id))
  const ordered = manifest.records.filter(record => !skippedIds.has(record.id) && !isProtectedKind(record.kind)).toSorted((left, right) => Number(right.kind === 'vehicle') - Number(left.kind === 'vehicle'))
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
    if (protectedImport.records.length || protectedImport.receipts.length) business.store.set('pendingConfigurationImports', [{ id: randomUUID(), records: protectedImport.records, receipts: protectedImport.receipts, actor, reason } satisfies PendingConfigurationImport])
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
    const archivedIds = new Set(archiveRecordIds)
    for (const record of currentRecords) if (!isProtectedKind(record.kind) && record.vehicleId && archivedIds.has(record.vehicleId)) archivedIds.add(record.id)
    const extras = business.list().filter(record => !isProtectedKind(record.kind) && !ids.has(record.id) && !record.archived && archivedIds.has(record.id)).sort((left, right) => Number(left.kind === 'vehicle') - Number(right.kind === 'vehicle'))
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
    summary.changed = changed + protectedImport.records.length
    business.store.event(actor.id, 'backup.restored', { reason, ...summary, teamId })
  })
  return summary
}
