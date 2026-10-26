export const vehicleColumnIds = ['vehicle', 'project', 'plate', 'status', 'physicalLocation', 'hvBatteryMaturityLevel', 'owner', 'latestDove', 'updated', 'actions', 'model', 'color', 'thermal', 'notes', 'hvBatteryPartNumber', 'hvBatterySerialNumber'] as const
export type VehicleColumnId = typeof vehicleColumnIds[number]
export type VehicleTablePreferences = { version: 1; columns: VehicleColumnId[]; widths: Partial<Record<VehicleColumnId, number>> }

export function defaultVehicleTablePreferences(): VehicleTablePreferences {
  return { version: 1, columns: vehicleColumnIds.slice(0, 10), widths: {} }
}

const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
const columnId = (value: unknown): value is VehicleColumnId => typeof value === 'string' && (vehicleColumnIds as readonly string[]).includes(value)

export function parseVehicleTablePreferences(value: unknown): VehicleTablePreferences | null {
  if (!object(value) || Object.keys(value).some(key => !['version', 'columns', 'widths'].includes(key)) || value.version !== 1 || !Array.isArray(value.columns) || !object(value.widths)) return null
  const columns = value.columns
  if (columns.length < 2 || columns.length > vehicleColumnIds.length || !columns.every(columnId) || new Set(columns).size !== columns.length || columns[0] !== 'vehicle' || columns.at(-1) !== 'actions') return null
  const widths: VehicleTablePreferences['widths'] = {}
  for (const [id, width] of Object.entries(value.widths)) {
    if (!columnId(id) || typeof width !== 'number' || !Number.isInteger(width) || width < 80 || width > 1000) return null
    widths[id] = width
  }
  return { version: 1, columns: [...columns], widths }
}
