import { activeHvBatteries, doveRecordedTime, keyControllerName } from './business.js'
import type { BusinessRecord, KeyControllerName } from './business.js'
import type { VehicleColumnId } from './vehicle-table.js'
import type { ConfigurationRevisionSummary } from './configuration-revisions.js'
export type VehicleFilterColumnId = Exclude<VehicleColumnId, 'actions'>
export type VehicleColumnFilters = Partial<Record<VehicleFilterColumnId, string[]>>
const component = (value: unknown): string => value === null || value === undefined || value === '' ? '' : typeof value === 'object' ? JSON.stringify(value, null, 2) : String(value)

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

export function createVehicleFilterKeys(records: readonly BusinessRecord[], summaries: readonly ConfigurationRevisionSummary[] = []): Map<string, Record<VehicleFilterColumnId, string>> {
  const revisions = new Map(summaries.map(summary => [summary.vehicleId, summary]))
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
  const result = new Map<string, Record<VehicleFilterColumnId, string>>()
  for (const vehicle of records) {
    if (vehicle.kind !== 'vehicle') continue
    const parts = partsByVehicle.get(vehicle.id) ?? []
    const batteries = activeHvBatteries(parts, vehicle.id)
    const value = (_column: VehicleFilterColumnId, ...source: unknown[]) => { const parts = source.map(component); return JSON.stringify(parts.every(part => part === '') ? [] : parts) }
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
      name: value('name', vehicle.data.name),
      vin: value('vin', vehicle.data.vin),
      plateExpiry: value('plateExpiry', vehicle.data.plateExpiry),
      complianceLevel: value('complianceLevel', vehicle.data.complianceLevel),
      coolingArchitecture: value('coolingArchitecture', vehicle.data.coolingArchitecture),
      configurationRevision: revisions.has(vehicle.id) ? value('configurationRevision', revisions.get(vehicle.id)!.label, revisions.get(vehicle.id)!.hasChanges) : value('configurationRevision'),
    })
  }
  return result
}
