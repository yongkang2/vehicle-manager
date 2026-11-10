import type { BusinessRecord } from './business.js'

/** Empty means a legacy vehicle-level file; null means invalid link metadata. */
export function parseEquipmentAttachmentId(value: unknown): string | null {
  if (value === undefined || value === '') return ''
  return typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value) ? value : null
}

export function equipmentAttachments(records: readonly BusinessRecord[], equipment: BusinessRecord, includeArchived = false): BusinessRecord[] {
  return records.filter(record => record.kind === 'attachment' && record.vehicleId === equipment.vehicleId && parseEquipmentAttachmentId(record.data.equipmentId) === equipment.id && (includeArchived || !record.archived))
}
