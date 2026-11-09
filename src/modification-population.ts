import type { BusinessRecord } from '../shared/business'
import type { ModificationView } from '../shared/modifications'
import { MODIFICATION_MAX_TARGETS } from '../shared/modifications'

/** Selection always binds UUIDs to the VIN that the user actually reviewed. */
export function modificationDestinations(records: readonly BusinessRecord[], source: ModificationView): BusinessRecord[] {
  const linked = new Set(source.linkedVehicles.map(vehicle => vehicle.id))
  return records.filter(record => record.kind === 'vehicle' && !record.archived && record.id !== source.record.vehicleId && !linked.has(record.id))
    .sort((left, right) => String(left.data.vin).localeCompare(String(right.data.vin)))
}

export function selectedModificationTargets(options: readonly BusinessRecord[], ids: readonly string[]): { vehicleId: string; expectedVin: string }[] | null {
  if (!ids.length || ids.length > MODIFICATION_MAX_TARGETS || new Set(ids).size !== ids.length) return null
  const vehicles = new Map(options.map(vehicle => [vehicle.id, vehicle]))
  const result: { vehicleId: string; expectedVin: string }[] = []
  for (const id of ids) {
    const vehicle = vehicles.get(id)
    if (!vehicle || vehicle.kind !== 'vehicle' || vehicle.archived) return null
    result.push({ vehicleId: id, expectedVin: String(vehicle.data.vin) })
  }
  return result
}

export function matchesModificationVin(vin: string, search: string): boolean {
  return vin.toUpperCase().includes(search.trim().toUpperCase())
}
