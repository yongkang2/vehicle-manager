import { activeHvBatteries, doveRecordedTime, keyControllerName, thermalSystemTypes } from '../shared/business.js'
import type { BusinessRecord, KeyControllerName } from '../shared/business.js'
import type { VehicleColumnId } from '../shared/vehicle-table.js'
import { translateBusiness } from './business-i18n.js'
import type { Language } from './i18n.js'

export type VehicleFilterColumnId = Exclude<VehicleColumnId, 'actions'>
export type VehicleColumnFilters = Partial<Record<VehicleFilterColumnId, string[]>>
export type VehicleFilterValue = { key: string; label: string }
export type VehicleFilterValues = Map<string, Record<VehicleFilterColumnId, VehicleFilterValue>>

// Match the table's existing display conversion without confusing missing values
// with a real em dash, zero, or text containing one of the composite separators.
const component = (value: unknown): string => value === null || value === undefined || value === '' ? '' : typeof value === 'object' ? JSON.stringify(value, null, 2) : String(value)
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

function filterValue(column: VehicleFilterColumnId, source: readonly unknown[], language: Language): VehicleFilterValue {
  const parts = source.map(component)
  const canonical = parts.every(value => value === '') ? [] : parts
  return { key: JSON.stringify(canonical), label: valueLabel(column, canonical, language) }
}

function retainedValue(column: VehicleFilterColumnId, key: string, language: Language): VehicleFilterValue {
  try {
    const parts: unknown = JSON.parse(key)
    if (Array.isArray(parts) && parts.every(value => typeof value === 'string')) return { key, label: valueLabel(column, parts, language) }
  } catch { /* Keep unavailable selections visible even if their key cannot be decoded. */ }
  return { key, label: key }
}

const reportTime = (record: BusinessRecord) => {
  const recorded = doveRecordedTime(record.data.recordedAt)
  return Number.isFinite(recorded) ? recorded : Date.parse(String(record.data.savedAt || record.updated))
}

export function sortedVehicleReports(records: readonly BusinessRecord[]): BusinessRecord[] {
  return records.filter(record => record.kind === 'report')
    .sort((left, right) => reportTime(right) - reportTime(left) || right.updated.localeCompare(left.updated))
}

export function findVehicleTableController(records: readonly BusinessRecord[], vehicleId: string, name: KeyControllerName): BusinessRecord | null {
  return records.find(record => record.kind === 'part' && record.vehicleId === vehicleId && !record.archived && record.data.category === 'controller' && keyControllerName(record.data.name) === name) || null
}

export function createVehicleFilterValues(records: readonly BusinessRecord[], language: Language): VehicleFilterValues {
  const partsByVehicle = new Map<string, BusinessRecord[]>()
  for (const record of records) {
    if (record.kind !== 'part' || record.vehicleId === null) continue
    const parts = partsByVehicle.get(record.vehicleId)
    if (parts) parts.push(record)
    else partsByVehicle.set(record.vehicleId, [record])
  }
  const latestReports = new Map<string, BusinessRecord>()
  for (const report of sortedVehicleReports(records)) {
    if (!report.archived && report.vehicleId !== null && !latestReports.has(report.vehicleId)) latestReports.set(report.vehicleId, report)
  }
  const result: VehicleFilterValues = new Map()
  for (const vehicle of records) {
    if (vehicle.kind !== 'vehicle') continue
    const parts = partsByVehicle.get(vehicle.id) ?? []
    const batteries = activeHvBatteries(parts, vehicle.id)
    const value = (column: VehicleFilterColumnId, ...source: unknown[]) => filterValue(column, source, language)
    result.set(vehicle.id, {
      vehicle: value('vehicle', vehicle.data.name, vehicle.data.vin),
      project: value('project', vehicle.data.project),
      plate: value('plate', vehicle.data.plate, vehicle.data.plateExpiry),
      status: value('status', vehicle.archived ? 'archived' : vehicle.data.status),
      physicalLocation: value('physicalLocation', vehicle.data.physicalLocation),
      hvBatteryMaturityLevel: value('hvBatteryMaturityLevel', ...batteries.map(battery => battery.data.maturity)),
      owner: value('owner', vehicle.data.owner),
      latestDove: value('latestDove', latestReports.get(vehicle.id)?.data.recordedAt),
      updated: value('updated', vehicle.updated, vehicle.version),
      model: value('model', vehicle.data.model),
      color: value('color', vehicle.data.color),
      thermal: value('thermal', vehicle.data.thermal),
      notes: value('notes', vehicle.data.notes),
      hvBatteryPartNumber: value('hvBatteryPartNumber', ...batteries.map(battery => battery.data.productPart)),
      hvBatterySerialNumber: value('hvBatterySerialNumber', ...batteries.map(battery => battery.data.serial)),
      vcuType: value('vcuType', findVehicleTableController(parts, vehicle.id, 'VCU')?.data.controllerType),
    })
  }
  return result
}

export function vehicleColumnFilterOptions(column: VehicleFilterColumnId, vehicles: readonly BusinessRecord[], values: VehicleFilterValues, selected: readonly string[], language: Language): VehicleFilterValue[] {
  const options = new Map<string, VehicleFilterValue>()
  for (const vehicle of vehicles) {
    if (vehicle.kind !== 'vehicle') continue
    const value = values.get(vehicle.id)?.[column]
    if (value) options.set(value.key, value)
  }
  for (const key of selected) if (!options.has(key)) options.set(key, retainedValue(column, key, language))
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
