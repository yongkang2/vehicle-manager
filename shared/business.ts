export type WorkingRecordKind = 'vehicle' | 'part' | 'modification' | 'equipment' | 'report' | 'attachment'
export type RecordKind = WorkingRecordKind | 'configurationRevision' | 'componentType'
export type Fields = Record<string, unknown>
export type BusinessRecord = { id: string; kind: RecordKind; vehicleId: string | null; data: Fields; archived: boolean; version: number; updated: string }
export type Actor = { id: string; name: string; deviceId: string; role: 'admin' | 'member' }
export type Change = { id: string; recordId: string; vehicleId: string; kind: RecordKind; before: Fields | null; after: Fields; archivedBefore: boolean | null; archivedAfter: boolean; actor: Actor; reason: string; action: string; sourceId: string | null; created: string }
export type Operation = { id: string; recordId: string; kind: RecordKind; vehicleId: string | null; base: { data: Fields; archived: boolean } | null; desired: { data: Fields; archived: boolean }; changes: Change[]; actor: Actor; files: string[]; created: string; decision?: boolean; maintenance?: 'restore' }
export type SyncConflict = { recordId: string; kind: RecordKind; name: string; fields: string[]; local: Operation['desired']; remote: Operation['desired'] | null; base: Operation['base']; operationIds: string[]; token: string }
export type SyncStatus = { phase: 'idle' | 'syncing' | 'ready' | 'offline' | 'busy' | 'conflict'; error: string | null; pending: number; quarantined: number; conflicts: SyncConflict[]; lastSync: string | null; revision: string | null }
export type DeleteCounts = Record<WorkingRecordKind, number> & Partial<Record<'configurationRevision' | 'componentType', number>>
export type VehicleDeletion = { id: string; requestId: string; vehicleId: string; vin: string; recordIds: string[]; fileKeys: string[]; actor: Actor; reason: string; deletedAt: string; revision: string; sequence: number }
export type VehicleDeleteReceipt = VehicleDeletion & { localSynced: boolean }
export type VehicleDeletePreview = { vehicleId: string; vin: string; version: number; counts: DeleteCounts; token: string; expires: number; protocolUpgrade: boolean }
export type VehicleDeleteRequest = { previewToken: string; version: number; vin: string; confirmation: string; reason: string; requestId: string }
export type QuarantinedOperation = { id: string; vehicleId: string; reason: 'VEHICLE_DELETED'; quarantinedAt: string; operation: Operation }
export type RestoreResult = { changed: number; skippedVehicles: number; skippedRecords: number; skippedVehicleIds: string[]; syncError?: string }
export type RestorePreview = { appVersion: string | null; records: number; additions: number; changes: number; archiveCandidates: { id: string; kind: RecordKind; name: string; parentName: string | null; relatedRecords: number }[]; droppedFields: { recordId: string; fields: string[] }[]; conflicts: string[]; fingerprint: string }
export const vehicleFields = ['name', 'project', 'model', 'vin', 'color', 'plate', 'plateExpiry', 'status', 'physicalLocation', 'owner', 'thermal', 'complianceLevel', 'notes'] as const
export const thermalSystemTypes = ['Indirect Heat Pump', 'Direct Heat Pump', 'No Heat Pump'] as const
export const complianceLevels = ['Eu7', 'CN6', 'Eu6', 'PL8'] as const
export const controllerTypes = ['Open ECU', 'Close ECU'] as const
export const batteryLifeStatuses = ['BOL', '2Y Aged', '8Y Aged', '10Y Aged', '15Y Aged', 'EOL'] as const
export const partFields = ['name', 'description', 'category', 'componentTypeId', 'position', 'supplier', 'serial', 'type', 'controllerType', 'hardware', 'software', 'functionalPart', 'productPart', 'calibrationPart', 'calibrationVersion', 'network', 'flashingDate', 'productionDate', 'sourceName', 'reportId', 'reportRecordedAt', 'maturity', 'lifeStatus', 'batteryStatus', 'installedAt', 'removedAt', 'notes'] as const
export const batteryFields = ['productPart', 'serial', 'maturity', 'lifeStatus'] as const
export function vehicleHvBatteries(records: readonly BusinessRecord[], vehicleId: string, includeArchived = false): BusinessRecord[] {
	return records.filter(record => record.kind === 'part' && record.vehicleId === vehicleId && record.data.category === 'battery' && (includeArchived || !record.archived))
		.sort((left, right) => left.updated > right.updated ? -1 : left.updated < right.updated ? 1 : left.id < right.id ? -1 : left.id > right.id ? 1 : 0)
}
export function activeHvBatteries(records: readonly BusinessRecord[], vehicleId: string): BusinessRecord[] {
	return vehicleHvBatteries(records, vehicleId).filter(record => !String(record.data.removedAt ?? '').trim())
}
export const keyControllerNames = ['VCU', 'MCU', 'BMS/MSB'] as const
export type KeyControllerName = typeof keyControllerNames[number]
export function keyControllerName(value: unknown): KeyControllerName | null {
	const name = String(value ?? '').trim().toUpperCase()
	if (['BMS', 'MSB', 'BMS/MSB', 'MSB/BMS'].includes(name)) return 'BMS/MSB'
	if (['VCU', 'EVCU'].includes(name)) return 'VCU'
	return name === 'MCU' ? 'MCU' : null
}
export const controllerFields = ['name', 'description', 'network', 'supplier', 'functionalPart', 'productPart', 'software', 'calibrationPart', 'calibrationVersion', 'flashingDate', 'productionDate', 'serial'] as const
// Manual classifications are not observations supplied by DOVE workbooks.
export const controllerEditFields = ['name', 'controllerType', ...controllerFields.filter(field => field !== 'name')] as const
export const configurationFields = ['description', 'supplier', 'serial', 'software', 'functionalPart', 'productPart', 'calibrationPart', 'calibrationVersion', 'network', 'flashingDate', 'productionDate'] as const
export function controllerSources(controllers: Controller[]) {
	return controllers.map((controller, index) => ({ controller, index })).filter(({ controller, index }) => keyControllerName(controller.name) && !controllers.slice(0, index).some(previous => keyControllerName(previous.name) === keyControllerName(controller.name) && configurationFields.every(field => previous[field] === controller[field])))
}
export const controllerRecordId = (vehicleId: string, name: KeyControllerName) => `controller-${vehicleId}-${name.replace('/', '-')}`
export function validControllerValue(value: unknown): value is string {
	return typeof value === 'string' && Boolean(value.trim()) && !/^(?:invalid[e]?|n\/?a|n\.?d\.?|unknown|null|undefined|not available|not defined|[-\u2013\u2014?]+)$/i.test(value.trim())
}
export function doveRecordedTime(value: unknown): number {
	return Date.parse(String(value ?? '').trim().replace(/^(\d{4}-\d{2}-\d{2})[ T](\d{2})h(\d{2})$/, '$1T$2:$3:00'))
}
export const entryFields = ['name', 'description', 'installedAt', 'removedAt', 'notes'] as const
export const businessFieldRegistry = {
	vehicle: { active: vehicleFields, legacy: ['coolingArchitecture'], removed: [] as string[] },
	part: { active: partFields, legacy: [] as string[], removed: [] as string[] },
	entry: { active: entryFields, legacy: [] as string[], removed: [] as string[] },
} as const
export type Controller = { name: string; description: string; network: string; supplier: string; functionalPart: string; productPart: string; software: string; calibrationPart: string; calibrationVersion: string; flashingDate: string; productionDate: string; serial: string }
export type Fault = { controller: string; code: string; status: string; statusByte: string; description: string; context: string }
export type DoveData = { vin: string; rawVin: string; vehicleId: string; recordedAt: string; software: string; mileage: number | null; soc: number | null; vehicleMode: string; controllers: Controller[]; faults: Fault[]; warnings: string[]; sheets: string[] }
export type DoveReportAssociation = { method: 'manual'; vehicleId: string; vin: string; actor: Actor; assignedAt: string }
export type ReportData = { name: string; checksum: string; size: number; recordedAt: string; savedAt: string; parserVersion: string; parsed: DoveData; vehicleSnapshot: Fields; association?: DoveReportAssociation }
const reportObject = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value)
const reportedVin = (value: unknown): value is string => typeof value === 'string' && /^[A-HJ-NPR-Z0-9]{17}$/.test(value)
const blankReportVin = (value: unknown) => value === undefined || (typeof value === 'string' && !value.trim())
/** The original source remains blank for manually associated reports. */
export function reportAssociationVin(record: BusinessRecord): string | null {
	if (record.kind !== 'report' || !record.vehicleId || !reportObject(record.data.parsed)) return null
	const parsed = record.data.parsed, association = record.data.association
	if (association === undefined) return reportedVin(parsed.vin) ? parsed.vin : null
	if (!blankReportVin(parsed.vin) || !blankReportVin(parsed.rawVin) || !reportObject(association) || association.method !== 'manual' || association.vehicleId !== record.vehicleId || !reportedVin(association.vin) || typeof association.assignedAt !== 'string' || association.assignedAt.length > 64 || !Number.isFinite(Date.parse(association.assignedAt)) || !reportObject(association.actor)) return null
	const actor = association.actor
	if (![actor.id, actor.name, actor.deviceId].every(value => typeof value === 'string' && value.trim().length > 0 && value.length <= 120) || (actor.role !== 'member' && actor.role !== 'admin')) return null
	return association.vin
}
export function validReportAssociation(record: BusinessRecord): boolean { return reportAssociationVin(record) !== null }
export function reportMatchesVehicle(report: BusinessRecord, vehicle: BusinessRecord): boolean {
	const vin = reportAssociationVin(report)
	return vehicle.kind === 'vehicle' && report.vehicleId === vehicle.id && vin !== null && vin === vehicle.data.vin
}
export const DOVE_BATCH_LIMIT = 8
export const DOVE_MAX_FILE_BYTES = 10 * 1024 * 1024
export type DoveImportConfirmation = { confirmed: true; reportOnly?: boolean; selections?: Partial<Record<KeyControllerName, number>>; versions?: Partial<Record<KeyControllerName, number | null>>; allowOlder?: boolean; bindingToken?: string; manualVehicleConfirmed?: boolean }
export type DoveManualBinding = { vehicleId: string; vin: string; token: string }
export type DovePreview = { id: string; filename: string; checksum: string; size: number; parsed: DoveData; expires: number; vehicle: BusinessRecord | null; currentControllers: BusinessRecord[]; match: 'matched' | 'unmatched' | 'ambiguous' | 'manual-required'; existingId: string | null; manualBinding?: DoveManualBinding }
export type DoveBatchPreviewResult = { index: number; filename: string } & ({ preview: DovePreview; error?: never } | { preview?: never; error: string })
export type DoveBatchSaveResult = { draftId: string } & ({ record: BusinessRecord; error?: never } | { record?: never; error: string })
