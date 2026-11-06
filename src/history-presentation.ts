import type { Change } from '../shared/business'

// A creation records a complete snapshot; only populated values help explain it.
function populated(value: unknown): boolean {
  if (value == null) return false
  if (typeof value === 'string') return Boolean(value.trim())
  if (Array.isArray(value)) return value.some(populated)
  if (typeof value === 'object') return Object.values(value).some(populated)
  return true
}
export function historyChangedFields(change: Pick<Change, 'before' | 'after'>): string[] {
  return [...new Set([...Object.keys(change.before ?? {}), ...Object.keys(change.after)])].filter(key =>
    JSON.stringify(change.before?.[key]) !== JSON.stringify(change.after[key]) && (change.before !== null || populated(change.after[key])))
}
