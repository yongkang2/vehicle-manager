import { ZipArchive } from 'archiver'
import path from 'node:path'
import { Transform } from 'node:stream'
import unzipper from 'unzipper'
import { AppError } from './team.js'
import { Business, checksum, normalizeFields } from './business.js'
import type { Actor, BusinessRecord, Change, Operation, QuarantinedOperation, RestoredHistoryImport, RestorePreview, RestoreResult, VehicleDeletion } from '../shared/business.js'
import { businessFieldRegistry, validReportAssociation } from '../shared/business.js'
import type { TeamDocument } from '../shared/types.js'
import { inspectVehiclePhoto, parsePhotoAttachmentId } from '../shared/vehicle-photo.js'
import { appVersion } from '../shared/version.js'
import { configurationFeatureFlags } from '../shared/business-features.js'
import { randomUUID } from 'node:crypto'
import { builtinComponentTypes, isProtectedKind, validateComponentTypeRecord, validateConfigurationRecords, validateConfigurationRevisionRecord, validateConfigurationReceiptEntry } from '../shared/configuration-revisions.js'
import { collectChangeFileKeys, collectModificationImportFileKeys, collectRecordFileKeys, hasEnhancedModificationText, modificationFiles, modificationGroupId, modificationView, validateModificationFiles, validateModificationReceiptEntry, validateModificationRecords } from '../shared/modifications.js'
import type { AbandonedModificationImport, ModificationImport, ModificationReceiptEntry } from '../shared/modifications.js'
import { validateModificationFile } from './modification-files.js'

export type ConfigurationReceiptEntry = { key: string; value: string }
export type PendingConfigurationImport = { id: string; records: BusinessRecord[]; actor: Actor; reason: string; receipts: ConfigurationReceiptEntry[] }
type Manifest = { application: 'stellantis-vehicle-manager'; format: 1 | 2 | 3 | 4 | 5; teamId: string; created: string; appVersion?: string; schemaVersion?: number; fieldVersion?: number; recordCounts?: Record<string, number>; records: BusinessRecord[]; changes: Change[]; pendingOperations: Operation[]; source?: { revision: string | null; pending: number; conflicts: number }; deletions?: VehicleDeletion[]; quarantinedOperations?: QuarantinedOperation[]; configurationReceipts?: ConfigurationReceiptEntry[]; modificationReceipts?: ModificationReceiptEntry[]; abandonedModificationImports?: AbandonedModificationImport[]; team?: TeamDocument }
const maximumFiles = 20000, maximumManifestBytes = 20 * 1024 * 1024, maximumBlobBytes = 10 * 1024 * 1024, maximumTotalBytes = 200 * 1024 * 1024

const identifier = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 120
const uuid = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value)
const hashKey = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
const timestamp = (value: unknown): value is string => typeof value === 'string' && value.length <= 64 && Number.isFinite(Date.parse(value))
const actorValue = (value: unknown): value is Actor => object(value) && identifier(value.id) && identifier(value.deviceId) && identifier(value.name) && ['admin', 'member'].includes(String(value.role))
function validateBackupMetadata(manifest: Manifest): void {
  if (manifest.created !== undefined && !timestamp(manifest.created)) throw new AppError('INVALID_BACKUP', 422)
  const source = manifest.source
  if (source !== undefined && (!object(source) || !(source.revision === null || identifier(source.revision)) || !Number.isSafeInteger(source.pending) || source.pending < 0 || !Number.isSafeInteger(source.conflicts) || source.conflicts < 0)) throw new AppError('INVALID_BACKUP', 422)
}
const kinds = ['vehicle', 'part', 'modification', 'equipment', 'report', 'attachment']
const manifestKinds = [...kinds, 'configurationRevision', 'componentType']
const enhancedManifestKinds = [...manifestKinds, 'modificationGroup']
const allowedKinds = (format: number) => format >= 5 ? enhancedManifestKinds : format >= 4 ? manifestKinds : kinds
const configurationConflict = () => new AppError('BACKUP_CONFIGURATION_CONFLICT', 409)
const modificationConflict = () => new AppError('BACKUP_MODIFICATION_CONFLICT', 409)
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
const managedModification = (record: BusinessRecord): boolean => record.kind === 'modificationGroup' || record.kind === 'modification' && (Object.hasOwn(record.data, 'groupId') || Object.hasOwn(record.data, 'attachments'))
function modificationReceipts(input: unknown): ModificationReceiptEntry[] {
  if (!Array.isArray(input) || input.length > 200000) throw new AppError('INVALID_BACKUP', 422)
  const seen = new Set<string>()
  for (const entry of input) {
    try { validateModificationReceiptEntry(entry as ModificationReceiptEntry) } catch { throw new AppError('INVALID_BACKUP', 422) }
    if (seen.has((entry as ModificationReceiptEntry).key)) throw new AppError('INVALID_BACKUP', 422)
    seen.add((entry as ModificationReceiptEntry).key)
  }
  return input as ModificationReceiptEntry[]
}
function knownModificationReceipts(business: Business): ModificationReceiptEntry[] {
  const byKey = new Map<string, string>()
  for (const entry of [...(business.store.get<ModificationReceiptEntry[]>('modificationReceipts') || []), ...(business.store.get<ModificationReceiptEntry[]>('modificationLocalReceipts') || [])]) {
    if (byKey.has(entry.key) && byKey.get(entry.key) !== entry.value) throw modificationConflict()
    byKey.set(entry.key, entry.value)
  }
  return modificationReceipts([...byKey].map(([key, value]) => ({ key, value })))
}
function normalizedBackupRecord(record: BusinessRecord, format: number, current?: BusinessRecord): BusinessRecord {
  if (format < 5 && managedModification(record)) throw new AppError('INVALID_BACKUP', 422)
  if (format < 5 && current && managedModification(current)) return structuredClone(current)
  if (record.kind === 'modification' && modificationGroupId(record)) return structuredClone(record)
  if (['vehicle', 'part', 'modification', 'equipment'].includes(record.kind)) {
    const data = normalizeFields(record.kind, record.data)
    if (record.kind === 'modification' && Object.hasOwn(record.data, 'attachments')) {
      try { data.attachments = validateModificationFiles(record.data.attachments) } catch { throw new AppError('INVALID_BACKUP', 422) }
    }
    return { ...record, data }
  }
  return structuredClone(record)
}
/** Managed modification rows publish as one graph, never unrelated outbox writes. */
function prepareModificationImport(current: BusinessRecord[], incoming: BusinessRecord[], deletedIds: Set<string>, deletedVehicles: Set<string>, receipts: ModificationReceiptEntry[], knownReceipts: ModificationReceiptEntry[], format: number, archivedIds: ReadonlySet<string> = new Set()) {
  const existing = new Map(current.map(record => [record.id, record])), union = new Map(current.filter(record => !deletedIds.has(record.id) && !(record.vehicleId && deletedVehicles.has(record.vehicleId))).map(record => [record.id, record]))
  const desired = new Map<string, BusinessRecord>(), baseVersions: ModificationImport['baseVersions'] = {}, baseStates: ModificationImport['baseStates'] = {}
  const stage = (record: BusinessRecord, force = false) => {
    const before = existing.get(record.id)
    if (before && (before.kind !== record.kind || before.vehicleId !== record.vehicleId)) throw modificationConflict()
    union.set(record.id, record)
    if (!force && before && sameValue(before.data, record.data) && before.archived === record.archived) return
    baseVersions[record.id] = before?.version ?? null
    baseStates[record.id] = before ? { data: structuredClone(before.data), archived: before.archived } : null
    desired.set(record.id, { ...record, version: (before?.version || 0) + 1 })
  }
  for (const record of incoming) {
    if (deletedIds.has(record.id) || record.vehicleId && deletedVehicles.has(record.vehicleId)) continue
    const before = existing.get(record.id)
    if (format < 5 && before && managedModification(before)) { union.set(before.id, before); continue }
    if (managedModification(record) || before && managedModification(before)) stage(record)
    else union.set(record.id, record)
  }
  // A parent archived by a new-format restore freezes any surviving membership.
  // Older backups may not detach an identity that did not exist in their format.
  for (const record of [...union.values()].filter(record => record.kind === 'modification' && modificationGroupId(record))) {
    const parent = union.get(record.vehicleId!)
    if (!archivedIds.has(record.id) && !archivedIds.has(record.vehicleId!) && !parent?.archived) continue
    if (format < 5) throw modificationConflict()
    const snapshot = modificationView(current.some(row => row.id === record.id) ? current : [...union.values()], record.id)
    const data = { ...snapshot.record.data }; delete data.groupId
    stage({ ...record, data, archived: true })
  }
  // Membership is part of the reviewed shared scope even when its fields do not
  // change. Restoring a membership must invalidate older group edit reviews.
  const affectedGroups = new Set<string>()
  for (const record of desired.values()) if (record.kind === 'modification') {
    const before = existing.get(record.id), previous = before && modificationGroupId(before), next = modificationGroupId(record)
    if (previous !== next || before?.archived !== record.archived) for (const id of [previous, next]) if (id) affectedGroups.add(id)
  }
  for (const id of affectedGroups) if (!desired.has(id)) { const group = union.get(id); if (!group || group.kind !== 'modificationGroup') throw modificationConflict(); stage(group, true) }
  try { validateModificationRecords([...union.values()]) } catch { throw modificationConflict() }
  const known = new Map(knownReceipts.map(entry => [entry.key, entry.value])), receiptAdditions: ModificationReceiptEntry[] = []
  for (const entry of receipts) {
    if (known.has(entry.key) && known.get(entry.key) !== entry.value) throw modificationConflict()
    if (!known.has(entry.key)) { known.set(entry.key, entry.value); receiptAdditions.push(entry) }
  }
  return { records: [...desired.values()], receipts: receiptAdditions, baseVersions, baseStates }
}
/** Preserve canonical catalog state and immutable history; never use ordinary restore writes. */
function prepareConfigurationImport(current: BusinessRecord[], incoming: BusinessRecord[], deletedIds: Set<string>, deletedVehicles: Set<string>, receipts: ConfigurationReceiptEntry[], knownReceipts: ConfigurationReceiptEntry[], preserveBuiltinDefaults = false) {
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
    // No stored override means the canonical built-in is Active. A historical
    // backup cannot replace that current decision with a removed/disabled state.
    if (preserveBuiltinDefaults && record.kind === 'componentType' && builtinComponentTypes.some(type => type.id === record.id)) continue
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

function validateManifestVersion(manifest: Manifest): void {
  if (manifest.format >= 3 && (typeof manifest.appVersion !== 'string' || !/^\d+\.\d+\.\d+$/.test(manifest.appVersion) || !Number.isSafeInteger(manifest.schemaVersion) || Number(manifest.schemaVersion) > (manifest.format >= 5 ? 6 : 5) || !Number.isSafeInteger(manifest.fieldVersion) || Number(manifest.fieldVersion) > (manifest.format >= 5 ? 4 : manifest.format === 4 ? 3 : 2) || !object(manifest.recordCounts))) throw new AppError('INVALID_BACKUP', 422)
  if (manifest.format === 4 && (![4, 5].includes(Number(manifest.schemaVersion)) || ![2, 3].includes(Number(manifest.fieldVersion)) || (manifest.fieldVersion === 3 && manifest.schemaVersion !== 5))) throw new AppError('INVALID_BACKUP', 422)
  if (manifest.format === 5 && (manifest.schemaVersion !== 6 || manifest.fieldVersion !== 4)) throw new AppError('INVALID_BACKUP', 422)
  if (Number(manifest.fieldVersion) < 3 && manifest.records.some(record => object(record) && isProtectedKind(record.kind) && record.data?.schema === 2)) throw new AppError('INVALID_BACKUP', 422)
  if (manifest.format < 5 && manifest.records.some(record => object(record) && object(record.data) && managedModification(record as BusinessRecord))) throw new AppError('INVALID_BACKUP', 422)
}

function abandonedImports(input: unknown): AbandonedModificationImport[] {
  if (input === undefined) return []
  if (!Array.isArray(input) || input.length > 20000) throw new AppError('INVALID_BACKUP', 422)
  const seen = new Set<string>()
  for (const value of input) {
    if (!object(value) || !uuid(value.id) || seen.has(value.id) || !timestamp(value.abandonedAt) || !actorValue(value.actor) || value.actor.role !== 'admin' || typeof value.reason !== 'string' || !value.reason.trim() || value.reason.length > 500 || !object(value.import)) throw new AppError('INVALID_BACKUP', 422)
    seen.add(value.id)
    const entry = value.import
    if (!uuid(entry.id) || entry.restoreRequestId !== undefined && !uuid(entry.restoreRequestId) || !actorValue(entry.actor) || entry.actor.role !== 'admin' || typeof entry.reason !== 'string' || entry.reason.length > 500 || !Array.isArray(entry.records) || entry.records.length > 20000 || !object(entry.baseStates) || !object(entry.baseVersions)) throw new AppError('INVALID_BACKUP', 422)
    modificationReceipts(entry.receipts)
    for (const record of entry.records) if (!object(record) || !identifier(record.id) || !['modification','modificationGroup'].includes(String(record.kind)) || !object(record.data) || typeof record.archived !== 'boolean' || !Number.isSafeInteger(record.version)) throw new AppError('INVALID_BACKUP', 422)
    for (const state of Object.values(entry.baseStates)) if (state !== null && (!object(state) || !object(state.data) || typeof state.archived !== 'boolean')) throw new AppError('INVALID_BACKUP', 422)
    for (const version of Object.values(entry.baseVersions)) if (version !== null && (!Number.isSafeInteger(version) || Number(version) < 1)) throw new AppError('INVALID_BACKUP', 422)
    if (entry.forwardChanges !== undefined && (!Array.isArray(entry.forwardChanges) || entry.forwardChanges.length > 20000 || entry.forwardChanges.some(change => !object(change) || !uuid(change.id) || change.kind !== 'modification' || !identifier(change.recordId) || !identifier(change.vehicleId) || change.action !== 'modification.restored' || !actorValue(change.actor) || !timestamp(change.created) || change.before !== null && !object(change.before) || !object(change.after)))) throw new AppError('INVALID_BACKUP', 422)
    try { collectModificationImportFileKeys(entry as unknown as ModificationImport) } catch { throw new AppError('INVALID_BACKUP', 422) }
  }
  return structuredClone(input as AbandonedModificationImport[])
}

function requireRestoreProtocol(business: Business, records: BusinessRecord[], needsConfiguration: boolean): void {
  const protocol = business.store.get<number>('businessProtocol') || 1
  const flags = configurationFeatureFlags(protocol, business.store.get('configurationEnabled'), business.store.get('configurationPolicyEnabled'))
  if (needsConfiguration && !flags.enabled) throw new AppError('CONFIGURATION_NOT_ENABLED', 409)
  if (records.some(record => isProtectedKind(record.kind) && record.data.schema === 2) && !flags.policyEnabled) throw new AppError('CONFIGURATION_POLICY_NOT_ENABLED', 409)
  if (protocol < 5) {
    const current = new Map(business.list('modification').map(record => [record.id, record]))
    if (records.some(record => managedModification(record) || record.kind === 'modification' && (hasEnhancedModificationText(record.data) || hasEnhancedModificationText(current.get(record.id)?.data || {})))) throw new AppError('MODIFICATION_NOT_ENABLED', 409)
  }
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
  const pendingModifications = business.store.get<ModificationImport[]>('pendingModificationImports') || []
  const deletions = business.store.deletionRows(), deletedIds = new Set(deletions.flatMap(marker => marker.recordIds)), deletedVehicles = new Set(deletions.map(marker => marker.vehicleId))
  const existing = business.list(), staged = pendingImports.flatMap(entry => entry.records)
  const imported = prepareConfigurationImport(existing, staged, deletedIds, deletedVehicles, [], [])
  const recordById = new Map([...existing, ...imported.records].map(record => [record.id, record]))
  for (const entry of pendingModifications) for (const record of entry.records) if (!deletedIds.has(record.id) && !(record.vehicleId && deletedVehicles.has(record.vehicleId))) recordById.set(record.id, record)
  const records = [...recordById.values()]
  try { validateModificationRecords(records, business.store.get<number>('businessProtocol') || 1) } catch { throw modificationConflict() }
  const receiptByKey = new Map<string, string>()
  for (const entry of [...(business.store.get<ConfigurationReceiptEntry[]>('configurationReceipts') || []), ...pendingImports.flatMap(entry => entry.receipts || [])]) {
    if (receiptByKey.has(entry.key) && receiptByKey.get(entry.key) !== entry.value) throw configurationConflict()
    receiptByKey.set(entry.key, entry.value)
  }
  const receipts = configurationReceipts([...receiptByKey].map(([key, value]) => ({ key, value })))
  prepareConfigurationImport(records, [], deletedIds, deletedVehicles, receipts, [])
  const modificationByKey = new Map(knownModificationReceipts(business).map(entry => [entry.key, entry.value]))
  for (const entry of pendingModifications.flatMap(item => item.receipts)) {
    if (modificationByKey.has(entry.key) && modificationByKey.get(entry.key) !== entry.value) throw modificationConflict()
    modificationByKey.set(entry.key, entry.value)
  }
  const modReceipts = modificationReceipts([...modificationByKey].map(([key, value]) => ({ key, value })))
  const changes = business.store.db.prepare('SELECT payload FROM changes ORDER BY created,id').all().map(row => JSON.parse(row.payload as string))
  const pendingOperations = business.store.db.prepare("SELECT payload FROM outbox WHERE state='pending' ORDER BY seq").all().map(row => JSON.parse(row.payload as string))
  if (records.length > 20000 || changes.length > 200000) throw new AppError('BACKUP_TOO_LARGE', 413)
  const recordCounts = Object.fromEntries(enhancedManifestKinds.map(kind => [kind, records.filter(record => record.kind === kind).length]))
  const manifest: Manifest = {
    application: 'stellantis-vehicle-manager', format: 5, teamId, created: new Date().toISOString(), appVersion, schemaVersion: business.store.db.prepare('PRAGMA user_version').get()!.user_version as number, fieldVersion: 4, recordCounts, records, changes, pendingOperations,
    deletions, quarantinedOperations: business.store.quarantineRows(), configurationReceipts: receipts, modificationReceipts: modReceipts, abandonedModificationImports: abandonedImports(business.store.get('abandonedModificationImports') || []), team,
    source: { revision: business.store.get<string>('businessRevision') || null, pending: pendingOperations.length + (business.store.get<unknown[]>('pendingDeletionImports') || []).length + pendingImports.length + pendingModifications.length + (business.store.get<RestoredHistoryImport[]>('pendingHistoryImports') || []).length, conflicts: Number(business.store.db.prepare('SELECT COUNT(*) AS n FROM conflicts').get()!.n) },
  }
  const manifestBytes = Buffer.from(JSON.stringify(manifest))
  if (manifestBytes.length > maximumManifestBytes) throw new AppError('BACKUP_TOO_LARGE', 413)
  const keys = new Set(records.flatMap(collectRecordFileKeys))
  for (const change of changes) for (const key of collectChangeFileKeys(change)) keys.add(key)
  for (const entry of manifest.abandonedModificationImports || []) for (const key of collectModificationImportFileKeys(entry.import)) keys.add(key)
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

export async function previewBackup(business: Business, bytes: Buffer, teamId: string, checkPending = false): Promise<RestorePreview> {
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
  if (!object(manifest) || manifest.application !== 'stellantis-vehicle-manager' || ![1, 2, 3, 4, 5].includes(manifest.format) || manifest.teamId !== teamId || (manifest.team && manifest.team.id !== teamId) || !Array.isArray(manifest.records) || manifest.records.length > 20000 || !Array.isArray(manifest.changes) || manifest.changes.length > 200000) throw new AppError('INVALID_BACKUP', 422)
  validateManifestVersion(manifest)
  validateBackupMetadata(manifest)
  const receipts = manifest.format >= 4 ? configurationReceipts(manifest.configurationReceipts) : []
  const modReceipts = manifest.format >= 5 ? modificationReceipts(manifest.modificationReceipts) : []
  if (manifest.format >= 5) abandonedImports(manifest.abandonedModificationImports)
  const current = business.list(), currentById = new Map(current.map(record => [record.id, record]))
  // An absent built-in override is the canonical Active policy. Restore keeps
  // that decision, so the review must not advertise an ignored override as an add.
  const preservesBuiltinDefault = (record: BusinessRecord) => record.kind === 'componentType' && !currentById.has(record.id) && builtinComponentTypes.some(type => type.id === record.id)
  const preservesManagedModification = (record: BusinessRecord) => manifest.format < 5 && Boolean(currentById.get(record.id) && managedModification(currentById.get(record.id)!))
  const incomingIds = new Set<string>(), conflicts: string[] = [], droppedFields: RestorePreview['droppedFields'] = []
  let additions = 0, changes = 0
  const vins = new Map(current.filter(record => record.kind === 'vehicle').map(record => [String(record.data.vin), record.id]))
  for (const record of manifest.records) {
    if (!object(record) || !identifier(record.id) || incomingIds.has(record.id) || !object(record.data) || !allowedKinds(manifest.format).includes(String(record.kind))) throw new AppError('INVALID_BACKUP', 422)
    if (isProtectedKind(record.kind)) protectedRecord(record)
    incomingIds.add(record.id)
    const existing = currentById.get(record.id)
    if (!existing) { if (!preservesBuiltinDefault(record)) additions++ }
    else if (existing.kind !== record.kind || existing.vehicleId !== record.vehicleId) conflicts.push(record.id)
    else if (!isProtectedKind(record.kind) && !preservesManagedModification(record) && (JSON.stringify(existing.data) !== JSON.stringify(record.data) || existing.archived !== record.archived)) changes++
    if (record.kind === 'vehicle') {
      const vin = String(record.data.vin || '')
      const owner = vins.get(vin)
      if (owner && owner !== record.id) conflicts.push(`VIN:${vin}`)
      vins.set(vin, record.id)
    }
    if (['vehicle', 'part', 'modification', 'equipment'].includes(record.kind)) {
      const registry = record.kind === 'vehicle' ? businessFieldRegistry.vehicle : record.kind === 'part' ? businessFieldRegistry.part : record.kind === 'modification' ? businessFieldRegistry.modification : businessFieldRegistry.entry
      const allowed = new Set<string>([...registry.active, ...registry.legacy, ...(record.kind === 'vehicle' ? ['photoAttachmentId'] : record.kind === 'modification' && manifest.format >= 5 ? ['groupId', 'attachments'] : [])])
      const fields = preservesManagedModification(record) ? [] : Object.keys(record.data).filter(field => !allowed.has(field))
      if (fields.length) droppedFields.push({ recordId: record.id, fields })
    }
  }
  const deletions = manifest.format >= 2 ? manifest.deletions : []
  if (!Array.isArray(deletions) || deletions.length > 20000 || !deletions.every(validDeletion)) throw new AppError('INVALID_BACKUP', 422)
  const liveIds = new Set(current.map(record => record.id)), liveParents = new Set(current.map(record => record.vehicleId))
  for (const deletion of deletions) if (liveIds.has(deletion.vehicleId) || liveParents.has(deletion.vehicleId) || deletion.recordIds.some(id => liveIds.has(id))) conflicts.push(`DELETION:${deletion.vehicleId}`)
  const allDeletions = [...business.store.deletionRows(), ...deletions], deleted = new Set(allDeletions.flatMap(row => row.recordIds))
  try {
    const prepared = prepareConfigurationImport(current, manifest.records, deleted, new Set(allDeletions.map(row => row.vehicleId)), receipts, business.store.get<ConfigurationReceiptEntry[]>('configurationReceipts') || [], true)
    requireRestoreProtocol(business, manifest.records.filter(record => !deleted.has(record.id) && (!record.vehicleId || !allDeletions.some(marker => marker.vehicleId === record.vehicleId))), Boolean(prepared.records.length || prepared.receipts.length || manifest.records.some(record => !deleted.has(record.id) && record.kind === 'part' && record.data.category === 'component')))
  } catch (error) {
    if (error instanceof AppError && error.code === 'BACKUP_CONFIGURATION_CONFLICT') conflicts.push('CONFIGURATION_HISTORY')
    else throw error
  }
  const recordsById = new Map(current.map(record => [record.id, record]))
  const archiveCandidates = current.filter(record => !isProtectedKind(record.kind) && record.kind !== 'modificationGroup' && !(manifest.format < 5 && managedModification(record)) && !record.archived && !incomingIds.has(record.id) && !deleted.has(record.id) && (record.kind === 'vehicle' || Boolean(record.vehicleId && incomingIds.has(record.vehicleId)))).map(record => ({ id: record.id, kind: record.kind, name: String(record.kind === 'modification' ? modificationView(current, record.id).record.data.name : record.data.name || record.id), parentName: record.vehicleId ? String(recordsById.get(record.vehicleId)?.data.name || record.vehicleId) : null, relatedRecords: record.kind === 'vehicle' ? current.filter(child => !isProtectedKind(child.kind) && child.kind !== 'modificationGroup' && !(manifest.format < 5 && managedModification(child)) && child.vehicleId === record.id && !child.archived && !incomingIds.has(child.id) && !deleted.has(child.id)).length : 0 }))
  let managedImport: ReturnType<typeof prepareModificationImport> | null = null
  try {
    const incoming = manifest.records.map(record => normalizedBackupRecord(record, manifest.format, currentById.get(record.id)))
    managedImport = prepareModificationImport(current, incoming, deleted, new Set(allDeletions.map(row => row.vehicleId)), modReceipts, knownModificationReceipts(business), manifest.format, new Set(archiveCandidates.map(record => record.id)))
    if (managedImport.records.length || managedImport.receipts.length) {
      if ((business.store.get<number>('businessProtocol') || 1) < 5) throw new AppError('MODIFICATION_NOT_ENABLED', 409)
    }
  } catch (error) {
    if (error instanceof AppError && error.code === 'BACKUP_MODIFICATION_CONFLICT') conflicts.push('MODIFICATION_GRAPH')
    else throw error
  }
  const pending = business.store.db.prepare("SELECT id,record_id,payload FROM outbox WHERE state='pending' ORDER BY seq").all()
  const fingerprint = checksum(JSON.stringify({ backup: checksum(bytes), current: current.map(record => [record.id, record.kind, record.vehicleId, record.version, record.archived, record.data]), deletions: business.store.deletionRows(), pending }))
  if (!conflicts.length) await restoreBackup(business, bytes, teamId, { id: 'validation', name: 'Validation', role: 'admin', deviceId: business.store.deviceId }, 'Validate backup', archiveCandidates.map(record => record.id), { validateOnly: true, checkPending })
  const incomingById = new Map(manifest.records.map(record => [record.id, record]))
  const managedById = new Map((managedImport?.records || []).map(record => [record.id, record]))
  const effects: RestorePreview['effects'] = manifest.records.map(original => {
    const record = managedById.get(original.id) || normalizedBackupRecord(original, manifest.format, currentById.get(original.id))
    const before = currentById.get(record.id)
    const skipped = deleted.has(record.id) || Boolean(record.vehicleId && allDeletions.some(marker => marker.vehicleId === record.vehicleId))
    const fields = [...new Set([...Object.keys(before?.data || {}), ...Object.keys(record.data), '_archived'])].filter(key => !sameValue(key === '_archived' ? before?.archived : before?.data[key], key === '_archived' ? record.archived : record.data[key])).map(key => ({ key, before: key === '_archived' ? before?.archived ?? null : before?.data[key] ?? null, after: key === '_archived' ? record.archived : record.data[key] ?? null }))
    return { id: record.id, vehicleId: record.vehicleId, vehicleName: record.vehicleId ? String(incomingById.get(record.vehicleId)?.data.name || incomingById.get(record.vehicleId)?.data.vin || record.vehicleId) : String(record.data.vin || record.data.name || record.id), kind: record.kind, name: String(record.data.name || record.data.vin || record.id), action: skipped ? 'skip' : !before && !preservesBuiltinDefault(record) ? 'add' : isProtectedKind(record.kind) || preservesManagedModification(record) || !fields.length ? 'unchanged' : 'change', fields: isProtectedKind(record.kind) || preservesManagedModification(record) || skipped ? [] : fields }
  })
  for (const record of archiveCandidates) effects.push({ ...record, vehicleId: currentById.get(record.id)?.vehicleId || null, action: 'archive', fields: [{ key: '_archived', before: false, after: true }] })
  additions = effects.filter(effect => effect.action === 'add').length
  changes = effects.filter(effect => effect.action === 'change').length
  return { source: manifest.source, format: manifest.format, teamId: manifest.teamId, created: typeof manifest.created === 'string' ? manifest.created : '', effects, appVersion: typeof manifest.appVersion === 'string' ? manifest.appVersion : null, records: manifest.records.length, additions, changes, archiveCandidates, droppedFields, conflicts: [...new Set(conflicts)], fingerprint }
}

export async function restoreBackup(business: Business, bytes: Buffer, teamId: string, actor: Actor, reason: string, archiveRecordIds: string[] = [], options: { validateOnly?: boolean; checkPending?: boolean; committed?: (result: RestoreResult) => void } = {}): Promise<RestoreResult> {
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
  if (!object(manifest) || manifest.application !== 'stellantis-vehicle-manager' || ![1, 2, 3, 4, 5].includes(manifest.format) || manifest.teamId !== teamId || (manifest.team && manifest.team.id !== teamId) || !Array.isArray(manifest.records) || manifest.records.length > 20000 || !Array.isArray(manifest.changes) || manifest.changes.length > 200000) throw new AppError('INVALID_BACKUP', 422)
  validateManifestVersion(manifest)
  validateBackupMetadata(manifest)
  const receipts = manifest.format >= 4 ? configurationReceipts(manifest.configurationReceipts) : []
  const modReceipts = manifest.format >= 5 ? modificationReceipts(manifest.modificationReceipts) : []
  const abandoned = manifest.format >= 5 ? abandonedImports(manifest.abandonedModificationImports) : []
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
    if (entry.operation.kind === 'modification') {
      let keys: string[]
      try { keys = collectRecordFileKeys({ id: entry.operation.recordId, kind: 'modification', vehicleId: entry.operation.vehicleId, data: entry.operation.desired.data, archived: entry.operation.desired.archived, version: 1, updated: entry.operation.created }) } catch { throw new AppError('INVALID_BACKUP', 422) }
      if (keys.some(key => !entry.operation.files.includes(key))) throw new AppError('INVALID_BACKUP', 422)
    }
    if (['report', 'attachment'].includes(entry.operation.kind)) {
      const data = entry.operation.desired.data, key = data.checksum
      if (!hashKey(key) || !entry.operation.files.includes(key) || files.get(`blobs/${key}`)?.length !== data.size) throw new AppError('INVALID_BACKUP', 422)
      if (entry.operation.kind === 'report' && Object.hasOwn(data, 'association') && !validReportAssociation({ id: entry.operation.recordId, kind: 'report', vehicleId: entry.operation.vehicleId, data, archived: entry.operation.desired.archived, version: 1, updated: entry.operation.created })) throw new AppError('INVALID_BACKUP', 422)
    }
  }
  const ids = new Set<string>()
  const currentById = new Map(liveRecords.map(record => [record.id, record]))
  const preservedManagedIds = new Set<string>()
  const validatedFileNames = new Set<string>()
  for (let index = 0; index < manifest.records.length; index++) {
    const original = manifest.records[index]
    if (!object(original) || !identifier(original.id) || ids.has(original.id) || typeof original.archived !== 'boolean' || !object(original.data) || !allowedKinds(manifest.format).includes(String(original.kind))) throw new AppError('INVALID_BACKUP', 422)
    const prior = currentById.get(original.id)
    if (manifest.format < 5 && prior && managedModification(prior)) preservedManagedIds.add(original.id)
    const record = manifest.records[index] = normalizedBackupRecord(original, manifest.format, prior)
    if (record.kind === 'modificationGroup' && (!Number.isSafeInteger(record.version) || record.version < 1 || !timestamp(record.updated))) throw new AppError('INVALID_BACKUP', 422)
    const marker = markerByRecord.get(record.id)
    if (marker && marker.vehicleId !== (record.kind === 'vehicle' ? record.id : record.vehicleId)) throw new AppError('INVALID_BACKUP', 422)
    ids.add(record.id)
    if (['vehicle', 'part', 'modification', 'equipment', 'modificationGroup'].includes(record.kind)) {
      if ((record.kind === 'modification' || record.kind === 'modificationGroup') && !preservedManagedIds.has(record.id)) {
        let entries
        try { entries = modificationFiles(record) } catch { throw new AppError('INVALID_BACKUP', 422) }
        for (const entry of entries) {
          const file = files.get(`blobs/${entry.checksum}`)
          if (!file || checksum(file) !== entry.checksum || file.length !== entry.size) throw new AppError('INVALID_BACKUP', 422)
          const identity = `${entry.checksum}:${entry.name}`
          if (!validatedFileNames.has(identity)) {
            try { await validateModificationFile(entry.name, file) } catch { throw new AppError('INVALID_BACKUP', 422) }
            validatedFileNames.add(identity)
          }
        }
      }
    } else if (record.kind === 'report' || record.kind === 'attachment') {
      const file = files.get(`blobs/${record.data.checksum}`)
      if (!file || checksum(file) !== record.data.checksum || file.length !== record.data.size || (record.kind === 'report' && (!record.data.parsed || !Array.isArray((record.data.parsed as { controllers?: unknown }).controllers) || !Array.isArray((record.data.parsed as { faults?: unknown }).faults)))) throw new AppError('INVALID_BACKUP', 422)
      if (record.kind === 'report' && Object.hasOwn(record.data, 'association') && !validReportAssociation(record)) throw new AppError('INVALID_BACKUP', 422)
    } else if (isProtectedKind(record.kind)) protectedRecord(record)
    else throw new AppError('INVALID_BACKUP', 422)
  }
  for (const record of manifest.records) if ((!['vehicle', 'componentType', 'modificationGroup'].includes(record.kind) && (!record.vehicleId || !ids.has(record.vehicleId))) || (['vehicle', 'componentType', 'modificationGroup'].includes(record.kind) && record.vehicleId)) throw new AppError('INVALID_BACKUP', 422)
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
  if (options.checkPending !== false && (business.store.db.prepare("SELECT id FROM outbox WHERE state='pending' LIMIT 1").get() || (business.store.get<PendingConfigurationImport[]>('pendingConfigurationImports') || []).length || (business.store.get<ModificationImport[]>('pendingModificationImports') || []).length || (business.store.get<RestoredHistoryImport[]>('pendingHistoryImports') || []).length || (business.store.get<unknown[]>('pendingDeletionImports') || []).length)) throw new AppError('PENDING_BEFORE_RESTORE', 409)
  const skipped = manifest.records.filter(record => deletedIds.has(record.id) || (record.vehicleId !== null && deletedVehicles.has(record.vehicleId)))
  const skippedVehicleIds = [...new Set(skipped.map(record => record.kind === 'vehicle' ? record.id : record.vehicleId!))]
  const currentRecords = business.list()
  const protectedImport = prepareConfigurationImport(currentRecords, manifest.records, deletedIds, deletedVehicles, receipts, configurationReceipts(business.store.get<ConfigurationReceiptEntry[]>('configurationReceipts') || []), true)
  const needsConfiguration = protectedImport.records.length || protectedImport.receipts.length || manifest.records.some(record => !deletedIds.has(record.id) && record.kind === 'part' && record.data.category === 'component')
  requireRestoreProtocol(business, manifest.records.filter(record => !deletedIds.has(record.id) && (!record.vehicleId || !deletedVehicles.has(record.vehicleId))), Boolean(needsConfiguration))
  const archiveCandidates = currentRecords.filter(record => !isProtectedKind(record.kind) && record.kind !== 'modificationGroup' && !(manifest.format < 5 && managedModification(record)) && !record.archived && !ids.has(record.id) && !deletedIds.has(record.id) && (record.kind === 'vehicle' || Boolean(record.vehicleId && ids.has(record.vehicleId))))
  if (!Array.isArray(archiveRecordIds) || archiveRecordIds.some(id => typeof id !== 'string') || new Set(archiveRecordIds).size !== archiveRecordIds.length || archiveRecordIds.some(id => !archiveCandidates.some(record => record.id === id))) throw new AppError('RESTORE_PREVIEW_CHANGED', 409)
  if (archiveCandidates.some(record => !archiveRecordIds.includes(record.id))) throw new AppError('RESTORE_ARCHIVE_CONFIRMATION_REQUIRED', 409)
  const archivedIds = new Set(archiveRecordIds)
  for (const record of currentRecords) if (!isProtectedKind(record.kind) && record.kind !== 'modificationGroup' && !(manifest.format < 5 && managedModification(record)) && record.vehicleId && archivedIds.has(record.vehicleId)) archivedIds.add(record.id)
  requireRestoreProtocol(business, currentRecords.filter(record => !record.archived && archivedIds.has(record.id)), false)
  const skippedIds = new Set(skipped.map(record => record.id))
  const modificationImport = prepareModificationImport(currentRecords, manifest.records, deletedIds, deletedVehicles, modReceipts, knownModificationReceipts(business), manifest.format, new Set(archiveRecordIds))
  if ((modificationImport.records.length || modificationImport.receipts.length) && (business.store.get<number>('businessProtocol') || 1) < 5) throw new AppError('MODIFICATION_NOT_ENABLED', 409)
  const managedIds = new Set([...preservedManagedIds, ...modificationImport.records.map(record => record.id)])
  const ordered = manifest.records.filter(record => !skippedIds.has(record.id) && !isProtectedKind(record.kind) && !managedModification(record) && !managedIds.has(record.id)).toSorted((left, right) => Number(right.kind === 'vehicle') - Number(left.kind === 'vehicle'))
  const summary: RestoreResult = { changed: 0, skippedVehicles: skippedVehicleIds.length, skippedRecords: skipped.length, skippedVehicleIds }
  // Blobs are immutable; retain quarantined originals but never replay their operations.
  const blobKeys = new Set([...ordered, ...modificationImport.records].flatMap(collectRecordFileKeys))
  for (const entry of abandoned) for (const key of collectModificationImportFileKeys(entry.import)) { if (!files.has('blobs/' + key)) throw new AppError('INVALID_BACKUP', 422); blobKeys.add(key) }
  // Frozen snapshots of current shared data may retain local blobs absent from
  // the old backup; imported blobs must still verify before any transaction.
  for (const change of manifest.changes) {
    let keys: string[]
    try { keys = collectChangeFileKeys(change) } catch { throw new AppError('INVALID_BACKUP', 422) }
    for (const key of keys) {
      if (manifest.format >= 5 && !files.has(`blobs/${key}`)) throw new AppError('INVALID_BACKUP', 422)
      if (files.has(`blobs/${key}`)) blobKeys.add(key)
    }
  }
  for (const entry of quarantine) for (const key of entry.operation.files) blobKeys.add(key)
  for (const key of blobKeys) {
    const file = files.get(`blobs/${key}`)
    if (file) { if (checksum(file) !== key) throw new AppError('INVALID_BACKUP', 422) }
    else { try { await business.readBlob(key) } catch { throw new AppError('INVALID_BACKUP', 422) } }
  }
  if (options.validateOnly) return summary
  for (const key of blobKeys) {
    const file = files.get(`blobs/${key}`)
    if (file) await business.blob(file)
  }
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
    const retained = abandonedImports(business.store.get('abandonedModificationImports') || [])
    for (const entry of abandoned) { const existing = retained.find(saved => saved.id === entry.id); if (existing && !sameValue(existing, entry)) throw new AppError('INVALID_BACKUP', 422); if (!existing) retained.push(entry) }
    if (retained.length) business.store.set('abandonedModificationImports', retained)
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
    // Ordinary vehicle parents must exist before raw group memberships are
    // inserted. Their entire managed overlay and durable import remain atomic.
    if (modificationImport.records.length || modificationImport.receipts.length) {
      for (const record of modificationImport.records.toSorted((left, right) => Number(right.kind === 'modificationGroup') - Number(left.kind === 'modificationGroup'))) {
        business.store.db.prepare('INSERT INTO records(id,kind,vehicle_id,vin,data,archived,version,updated) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data,archived=excluded.archived,version=excluded.version,updated=excluded.updated').run(record.id, record.kind, record.vehicleId, null, JSON.stringify(record.data), Number(record.archived), record.version, record.updated)
      }
      business.store.set('pendingModificationImports', [{ id: randomUUID(), records: modificationImport.records, receipts: modificationImport.receipts, baseVersions: modificationImport.baseVersions, baseStates: modificationImport.baseStates, actor, reason } satisfies ModificationImport])
    }
    const extras = business.list().filter(record => !isProtectedKind(record.kind) && record.kind !== 'modificationGroup' && !managedIds.has(record.id) && !(manifest.format < 5 && managedModification(record)) && !ids.has(record.id) && !record.archived && archivedIds.has(record.id)).sort((left, right) => Number(left.kind === 'vehicle') - Number(right.kind === 'vehicle'))
    for (const record of extras) { business.write({ id: record.id, kind: record.kind, vehicleId: record.vehicleId, data: record.data, version: record.version, archived: true, actor, reason: `Restore archive: ${reason}`, internal: ['report', 'attachment'].includes(record.kind), maintenance: 'restore' }); changed++ }
    for (const record of ordered.filter(record => record.kind === 'vehicle' && record.archived)) {
      const current = business.get(record.id)
      business.write({ id: current.id, kind: 'vehicle', data: current.data, version: current.version, archived: true, actor, reason: `Restore archive state: ${reason}`, maintenance: 'restore' }); changed++
    }
    const afterRecords = business.list(), changedGroups = new Set(modificationImport.records.filter(record => record.kind === 'modificationGroup').map(record => record.id))
    const changedMembers = new Set(modificationImport.records.filter(record => record.kind === 'modification').map(record => record.id))
    const forwardAudits: Change[] = []
    for (const record of afterRecords.filter(record => record.kind === 'modification')) {
      const before = currentRecords.find(row => row.id === record.id)
      if (!changedMembers.has(record.id) && !changedGroups.has(String(record.data.groupId)) && !changedGroups.has(String(before?.data.groupId))) continue
      const previous = before ? modificationView(currentRecords, record.id).record : null, next = modificationView(afterRecords, record.id).record
      if (previous && sameValue(previous.data, next.data) && previous.archived === next.archived) continue
      forwardAudits.push({ id: randomUUID(), recordId: record.id, vehicleId: record.vehicleId!, kind: 'modification', before: previous?.data || null, after: next.data, archivedBefore: previous?.archived ?? null, archivedAfter: next.archived, actor, reason: `Restore: ${reason}`, action: 'modification.restored', sourceId: null, created: new Date().toISOString() })
    }
    if (forwardAudits.length) business.store.set('pendingModificationImports', (business.store.get<ModificationImport[]>('pendingModificationImports') || []).map(entry => ({ ...entry, forwardChanges: forwardAudits })))
    const historical = [...manifest.changes.filter(change => object(change) && identifier(change.id) && identifier(change.recordId) && (ids.has(change.recordId) || deletedIds.has(change.recordId) || deletedVehicles.has(change.vehicleId)) && identifier(change.vehicleId) && timestamp(change.created)), ...forwardAudits]
    for (const change of historical) business.store.db.prepare('INSERT OR IGNORE INTO changes VALUES(?,?,?,?,?)').run(change.id, change.recordId, change.vehicleId, JSON.stringify(change), change.created)
    // History must also publish when working records already match the backup.
    if (historical.length) business.store.set('pendingHistoryImports', [...(business.store.get<RestoredHistoryImport[]>('pendingHistoryImports') || []), { id: randomUUID(), actor, changes: historical } satisfies RestoredHistoryImport])
    summary.changed = changed + protectedImport.records.length + modificationImport.records.length
    business.store.event(actor.id, 'backup.restored', { reason, ...summary, teamId })
    options.committed?.(summary)
  })
  return summary
}
