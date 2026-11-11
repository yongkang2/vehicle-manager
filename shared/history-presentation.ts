import type { Change } from './business.js'

type HistoryChange = Pick<Change, 'before' | 'after'> & Partial<Pick<Change, 'kind'>>
const fileKinds = new Set(['attachment', 'report'])
const metadata: Partial<Record<Change['kind'], readonly string[]>> = {
  attachment: ['size', 'savedAt'], report: ['size', 'savedAt', 'parserVersion'],
  modificationGroup: ['schema'], configurationRevision: ['schema', 'sourceFingerprint'],
  componentType: ['schema'],
}
const references: Partial<Record<Change['kind'], readonly string[]>> = {
  attachment: ['equipmentId', 'modificationId', 'groupId', 'fileId'],
  part: ['reportId', 'componentTypeId'], modification: ['groupId'],
  vehicle: ['photoAttachmentId'], configurationRevision: ['previousRevisionId', 'vehicleId'],
}
export function historyIsReference(kind: Change['kind'] | undefined, key: string): boolean {
  return Boolean(kind && references[kind]?.includes(key))
}

export function historyFieldValue(key: string, value: unknown): unknown {
  if (key === 'attachments' && Array.isArray(value)) return value.map(file => {
    if (!file || typeof file !== 'object') return file
    const item = file as Record<string, unknown>
    return { name: item.name, archived: Boolean(item.archived) }
  })
  return value
}

// A creation records a complete snapshot; only populated values help explain it.
function populated(value: unknown): boolean {
  if (value == null) return false
  if (typeof value === 'string') return Boolean(value.trim())
  if (Array.isArray(value)) return value.some(populated)
  if (typeof value === 'object') return Object.values(value).some(populated)
  return true
}
// Compare contents without exposing hashes, and ignore attachment clone IDs and ordering.
function comparisonValue(key: string, value: unknown): unknown {
  if (key !== 'attachments' || !Array.isArray(value)) return value
  return value.map(file => {
    if (!file || typeof file !== 'object') return JSON.stringify(file)
    const item = file as Record<string, unknown>
    return JSON.stringify({ name: item.name, archived: Boolean(item.archived), checksum: item.checksum })
  }).sort()
}
export function historyChangedFields(change: HistoryChange): string[] {
  return [...new Set([...Object.keys(change.before ?? {}), ...Object.keys(change.after)])].filter(key =>
    !(change.kind && metadata[change.kind]?.includes(key)) && !(key === 'checksum' && change.kind && fileKinds.has(change.kind) && change.before === null) && JSON.stringify(comparisonValue(key, change.before?.[key])) !== JSON.stringify(comparisonValue(key, change.after[key])) && (change.before !== null || populated(change.after[key])))
}
