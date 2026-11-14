import { thermalSystemTypes } from '../shared/business.js'
import type { BusinessRecord } from '../shared/business.js'
import type { VehicleColumnId } from '../shared/vehicle-table.js'
import { createVehicleFilterKeys } from '../shared/vehicle-table-values.js'
export { sortedVehicleReports, findVehicleTableController } from '../shared/vehicle-table-values.js'
import type { ConfigurationRevisionSummary } from '../shared/configuration-revisions.js'
import { translateBusiness } from './business-i18n.js'
import type { Language } from './i18n.js'

export type VehicleFilterColumnId = Exclude<VehicleColumnId, 'actions'>
export type VehicleColumnFilters = Partial<Record<VehicleFilterColumnId, string[]>>
export type VehicleFilterValue = { key: string; label: string }
export type VehicleFilterValues = Map<string, Record<VehicleFilterColumnId, VehicleFilterValue>>

const blankLabel = (language: Language) => language === 'zh' ? '（空白）' : '(blank)'
const displayComponent = (value: string) => value === '' ? '—' : value

function valueLabel(column: VehicleFilterColumnId, parts: readonly string[], language: Language): string {
  if (!parts.length || parts.every(value => value === '')) return blankLabel(language)
  const text = translateBusiness(language)
  switch (column) {
    case 'vehicle':
    case 'plate':
      return parts.map(displayComponent).join(' · ')
    case 'updated':
      return `${parts[0] ? new Date(parts[0]).toLocaleString(language === 'zh' ? 'zh-CN' : 'en-GB') : '—'} · v${parts[1] ?? ''}`
    case 'configurationRevision':
      return parts[1] === 'true' ? `${parts[0]} · ${text('unpublishedConfigurationChanges')}` : parts[0]
    case 'status':
      return text(parts[0])
    case 'thermal':
      return thermalSystemTypes.some(type => type === parts[0]) ? text(parts[0]) : parts[0]
    case 'hvBatteryMaturityLevel':
    case 'hvBatteryPartNumber':
    case 'hvBatterySerialNumber':
      return parts.map(displayComponent).join(' / ')
    default:
      return parts[0]
  }
}

export function retainedVehicleFilterValue(column: VehicleFilterColumnId, key: string, language: Language): VehicleFilterValue {
  try {
    const parts: unknown = JSON.parse(key)
    if (Array.isArray(parts) && parts.every(value => typeof value === 'string')) return { key, label: valueLabel(column, parts, language) }
  } catch { /* Keep unavailable selections visible even if their key cannot be decoded. */ }
  return { key, label: key }
}

export function createVehicleFilterValues(records: readonly BusinessRecord[], language: Language, summaries: readonly ConfigurationRevisionSummary[] = []): VehicleFilterValues {
  return new Map([...createVehicleFilterKeys(records, summaries)].map(([id, keys]) => [id, Object.fromEntries(Object.entries(keys).map(([column, key]) => [column, retainedVehicleFilterValue(column as VehicleFilterColumnId, key, language)])) as Record<VehicleFilterColumnId, VehicleFilterValue>]))
}

export function vehicleColumnFilterOptions(column: VehicleFilterColumnId, vehicles: readonly BusinessRecord[], values: VehicleFilterValues, selected: readonly string[], language: Language): VehicleFilterValue[] {
  const options = new Map<string, VehicleFilterValue>()
  for (const vehicle of vehicles) {
    if (vehicle.kind !== 'vehicle') continue
    const value = values.get(vehicle.id)?.[column]
    if (value) options.set(value.key, value)
  }
  for (const key of selected) if (!options.has(key)) options.set(key, retainedVehicleFilterValue(column, key, language))
  return [...options.values()].sort((left, right) => left.label.localeCompare(right.label, language === 'zh' ? 'zh-CN' : 'en-GB') || left.key.localeCompare(right.key))
}

export function matchesVehicleColumnFilters(values: Record<VehicleFilterColumnId, VehicleFilterValue>, filters: VehicleColumnFilters): boolean {
  return Object.entries(filters).every(([column, keys]) => !keys?.length || keys.includes(values[column as VehicleFilterColumnId]?.key))
}

export function visibleVehicleColumnFilters(filters: VehicleColumnFilters, columns: readonly VehicleColumnId[]): VehicleColumnFilters {
  const visible = new Set(columns)
  const entries = Object.entries(filters)
  const retained = entries.filter(([column]) => column !== 'actions' && visible.has(column as VehicleColumnId))
  return retained.length === entries.length ? filters : Object.fromEntries(retained)
}
