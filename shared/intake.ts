import type { BusinessRecord } from './business.js'

export const intakeFields = ['vin', 'model', 'plate', 'supplier', 'serial', 'productPart', 'hardware', 'software', 'functionalPart', 'calibrationPart', 'calibrationVersion'] as const
export type IntakeFields = Partial<Record<typeof intakeFields[number], string>>
export function parseIntakeFields(value: unknown): IntakeFields {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('INVALID_RECOGNITION')
  const result: IntakeFields = {}
  for (const key of intakeFields) {
    const entry = (value as Record<string, unknown>)[key]
    if (entry === null || entry === undefined || entry === '') continue
    if (typeof entry !== 'string' || entry.length > 400) throw new Error('INVALID_RECOGNITION')
    const text = entry.trim()
    if (!text) continue
    if (key === 'vin' && !/^[A-HJ-NPR-Z0-9]{17}$/.test(text)) throw new Error('INVALID_RECOGNITION')
    result[key] = text
  }
  return result
}
export function matchIntakeRecords(records: readonly BusinessRecord[], fields: IntakeFields): BusinessRecord[] {
  const vehicles = records.filter(row => row.kind === 'vehicle' && !row.archived && row.data.vin === fields.vin)
  const keys = (['serial', 'productPart'] as const).filter(key => fields[key])
  if (!keys.length) return fields.vin ? vehicles : []
  const vehicleIds = new Set(vehicles.map(row => row.id))
  return records.filter(row => !row.archived && row.kind === 'part' && (!fields.vin || vehicleIds.has(row.vehicleId || '')) && keys.every(key => row.data[key] === fields[key]))
}
