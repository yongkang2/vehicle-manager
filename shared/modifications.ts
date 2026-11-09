import { modificationFields } from './business.js'
import type { Actor, BusinessRecord, Change, Fields } from './business.js'

export const MODIFICATION_BATCH_LIMIT = 8
export const MODIFICATION_MAX_FILE_BYTES = 10 * 1024 * 1024
export const MODIFICATION_MAX_TARGETS = 100
export const MODIFICATION_EXTENSIONS = ['.doc', '.docx', '.txt', '.xls', '.xlsx', '.pdf', '.eml', '.msg', '.7z', '.zip'] as const
export type ModificationFile = { id: string; name: string; checksum: string; size: number; savedAt: string; archived: boolean }
export type ModificationVehicle = { id: string; vin: string; name: string; plate: string }
export type ModificationView = { record: BusinessRecord; mode: 'independent' | 'linked'; groupId: string | null; groupVersion: number | null; linkedVehicles: ModificationVehicle[]; files: ModificationFile[] }
export type ModificationMutation = { version: number; groupVersion?: number | null; reason: string; requestId: string }
export type ModificationPopulateRequest = ModificationMutation & { mode: 'oneTime' | 'linked'; targets: { vehicleId: string; expectedVin: string }[] }
export type ModificationReceipt = { requestId: string; action: string; recordIds: string[]; groupId: string | null; localSynced: boolean }
export type ModificationReceiptEntry = { key: string; value: string }
export type ModificationImport = { id: string; restoreRequestId?: string; records: BusinessRecord[]; receipts: ModificationReceiptEntry[]; baseVersions: Record<string, number | null>; baseStates: Record<string, { data: Fields; archived: boolean } | null>; forwardChanges?: Change[]; actor: Actor; reason: string }
export type AbandonedModificationImport = { id: string; abandonedAt: string; actor: Actor; reason: string; import: ModificationImport }
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
const uuid = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value)
const fail = (): never => { throw Object.assign(new Error('MODIFICATION_CORRUPTED'), { code: 'MODIFICATION_CORRUPTED' }) }
export function hasEnhancedModificationText(data: Fields): boolean {
  return ['requestor', 'lead'].some(field => String(data[field] ?? '').trim().length > 0)
}
export function modificationGroupId(record: BusinessRecord): string | null {
  if (record.kind !== 'modification' || record.data.groupId === undefined || record.data.groupId === '') return null
  if (!uuid(record.data.groupId)) return fail()
  return record.data.groupId
}
export function modificationFiles(record: BusinessRecord): ModificationFile[] {
  if (!['modification', 'modificationGroup'].includes(record.kind) || record.data.attachments === undefined) return []
  return validateModificationFiles(record.data.attachments)
}
export function validateModificationFiles(value: unknown): ModificationFile[] {
  if (!Array.isArray(value) || value.length > 20000) return fail()
  const seen = new Set<string>()
  for (const entry of value) {
    if (!object(entry) || !uuid(entry.id) || seen.has(entry.id) || typeof entry.name !== 'string' || !entry.name.trim() || entry.name.length > 240 || /[\\/]/.test(entry.name) || [...entry.name].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127) || typeof entry.checksum !== 'string' || !/^[a-f0-9]{64}$/.test(entry.checksum) || !Number.isSafeInteger(entry.size) || Number(entry.size) < 0 || Number(entry.size) > MODIFICATION_MAX_FILE_BYTES || typeof entry.savedAt !== 'string' || !Number.isFinite(Date.parse(entry.savedAt)) || typeof entry.archived !== 'boolean' || Object.keys(entry).some(key => !['id', 'name', 'checksum', 'size', 'savedAt', 'archived'].includes(key))) return fail()
    const extension = entry.name.slice(entry.name.lastIndexOf('.')).toLowerCase()
    if (!(MODIFICATION_EXTENSIONS as readonly string[]).includes(extension)) return fail()
    seen.add(entry.id)
  }
  return structuredClone(value as ModificationFile[])
}
export function collectRecordFileKeys(record: BusinessRecord): string[] {
  const keys = ['report', 'attachment'].includes(record.kind) ? [String(record.data.checksum)] : modificationFiles(record).map(file => file.checksum)
  return [...new Set(keys)]
}
export function collectChangeFileKeys(change: Change): string[] {
  if (!['modification', 'modificationGroup'].includes(change.kind)) return []
  return [...new Set([change.before, change.after].filter(object).flatMap(data => modificationFiles({ kind: change.kind, data } as BusinessRecord).map(file => file.checksum)))]
}
export function collectModificationImportFileKeys(entry: ModificationImport): string[] {
  return [...new Set([...entry.records.flatMap(record => [
    ...collectRecordFileKeys(record),
    ...(entry.baseStates[record.id] ? collectRecordFileKeys({ ...record, data: entry.baseStates[record.id]!.data }) : []),
  ]), ...(entry.forwardChanges || []).flatMap(collectChangeFileKeys)])]
}
function validateFields(data: Fields): void {
  for (const field of modificationFields) if (data[field] !== undefined && (typeof data[field] !== 'string' || (data[field] as string).length > 4000)) fail()
  if (typeof data.name !== 'string' || !data.name.trim() || data.name.length > 120) fail()
  for (const field of ['installedAt', 'removedAt']) if (data[field] && (typeof data[field] !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(data[field] as string) || !Number.isFinite(Date.parse(data[field] as string)) || new Date(data[field] as string).toISOString().slice(0, 10) !== data[field])) fail()
  if (data.installedAt && data.removedAt && String(data.removedAt) < String(data.installedAt)) fail()
}
export function validateModificationRecords(records: readonly BusinessRecord[], protocol = 5): void {
  const groups = new Map(records.filter(record => record.kind === 'modificationGroup').map(record => [record.id, record]))
  const vehicles = new Map(records.filter(record => record.kind === 'vehicle').map(record => [record.id, record]))
  for (const group of groups.values()) {
    if (protocol < 5 || !uuid(group.id) || group.vehicleId !== null || group.archived || group.data.schema !== 1 || !Number.isSafeInteger(group.version) || group.version < 1) fail()
    validateFields(group.data); modificationFiles(group)
    if (group.data.groupId !== undefined) fail()
  }
  const members = new Set<string>()
  for (const record of records.filter(record => record.kind === 'modification')) {
    const vehicle = record.vehicleId ? vehicles.get(record.vehicleId) : undefined
    if (!vehicle) return fail()
    const groupId = modificationGroupId(record)
    if (groupId) {
      if (protocol < 5 || !groups.has(groupId) || record.archived || vehicle.archived || Object.keys(record.data).some(key => key !== 'groupId')) fail()
      const key = `${groupId}:${record.vehicleId}`
      if (members.has(key)) fail()
      members.add(key)
    } else {
      if (record.data.attachments !== undefined) { validateFields(record.data); modificationFiles(record) }
      if (protocol < 5 && record.data.attachments !== undefined) fail()
    }
  }
}
export function modificationView(records: readonly BusinessRecord[], id: string): ModificationView {
  const member = records.find(record => record.id === id && record.kind === 'modification')
  if (!member) return fail()
  const groupId = modificationGroupId(member), group = groupId ? records.find(record => record.id === groupId && record.kind === 'modificationGroup') : undefined
  if (groupId && !group) return fail()
  const source = group || member
  const data = Object.fromEntries(modificationFields.map(field => [field, source.data[field] ?? '']))
  const files = modificationFiles(source)
  const linkedVehicles = groupId ? records.filter(record => record.kind === 'modification' && !record.archived && record.data.groupId === groupId).flatMap(record => {
    const vehicle = records.find(row => row.kind === 'vehicle' && row.id === record.vehicleId && !row.archived)
    return vehicle ? [{ id: vehicle.id, vin: String(vehicle.data.vin), name: String(vehicle.data.name || ''), plate: String(vehicle.data.plate || '') }] : []
  }).sort((left, right) => left.vin.localeCompare(right.vin)) : []
  return { record: { ...member, data: { ...data, ...(files.length || source.data.attachments !== undefined ? { attachments: files } : {}), ...(groupId ? { groupId } : {}) } }, mode: groupId ? 'linked' : 'independent', groupId, groupVersion: group?.version ?? null, linkedVehicles, files }
}
export function effectiveModificationRecords(records: readonly BusinessRecord[]): BusinessRecord[] {
  return records.map(record => record.kind === 'modification' ? modificationView(records, record.id).record : record)
}
export function validateModificationReceiptEntry(entry: ModificationReceiptEntry): void {
  if (!entry || typeof entry.key !== 'string' || !/^modificationRequest:[a-f0-9-]{36}$/.test(entry.key) || typeof entry.value !== 'string' || entry.value.length > 1000000) return fail()
  let value: unknown
  try { value = JSON.parse(entry.value) } catch { return fail() }
  if (!object(value) || typeof value.actorKey !== 'string' || !value.actorKey || value.actorKey.length > 1000 || typeof value.commandDigest !== 'string' || !/^[a-f0-9]{64}$/.test(value.commandDigest) || !['enable', 'edit', 'upload', 'archiveFile', 'populate', 'unlink', 'archiveMember', 'archiveVehicle'].includes(String(value.kind)) || !object(value.receipt) || value.receipt.requestId !== entry.key.slice('modificationRequest:'.length)) return fail()
  const receipt = value.receipt
  if (typeof receipt.action !== 'string' || !receipt.action || !Array.isArray(receipt.recordIds) || receipt.recordIds.length > 20000 || receipt.recordIds.some(id => typeof id !== 'string' || !id || id.length > 120) || receipt.groupId !== null && !uuid(receipt.groupId) || typeof receipt.localSynced !== 'boolean') fail()
}
