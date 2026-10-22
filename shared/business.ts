export type RecordKind = 'vehicle' | 'part' | 'modification' | 'equipment' | 'report' | 'attachment'
export type Fields = Record<string, unknown>
export type BusinessRecord = { id: string; kind: RecordKind; vehicleId: string | null; data: Fields; archived: boolean; version: number; updated: string }
export type Actor = { id: string; name: string; deviceId: string; role: 'admin' | 'member' }
export type Change = { id: string; recordId: string; vehicleId: string; kind: RecordKind; before: Fields | null; after: Fields; archivedBefore: boolean | null; archivedAfter: boolean; actor: Actor; reason: string; action: string; sourceId: string | null; created: string }
export type Operation = { id: string; recordId: string; kind: RecordKind; vehicleId: string | null; base: { data: Fields; archived: boolean } | null; desired: { data: Fields; archived: boolean }; changes: Change[]; actor: Actor; files: string[]; created: string; decision?: boolean; maintenance?: 'restore' }
export type SyncConflict = { recordId: string; kind: RecordKind; name: string; fields: string[]; local: Operation['desired']; remote: Operation['desired'] | null; base: Operation['base']; operationIds: string[]; token: string }
export type SyncStatus = { phase: 'idle' | 'syncing' | 'ready' | 'offline' | 'busy' | 'conflict'; error: string | null; pending: number; conflicts: SyncConflict[]; lastSync: string | null; revision: string | null }
export const vehicleFields = ['name', 'project', 'model', 'vin', 'color', 'plate', 'plateExpiry', 'status', 'owner', 'coolingArchitecture', 'thermal', 'notes'] as const
export const partFields = ['name', 'description', 'category', 'position', 'supplier', 'serial', 'type', 'hardware', 'software', 'functionalPart', 'productPart', 'calibrationPart', 'calibrationVersion', 'network', 'flashingDate', 'productionDate', 'sourceName', 'reportId', 'reportRecordedAt', 'maturity', 'batteryStatus', 'installedAt', 'removedAt', 'notes'] as const
export const keyControllerNames = ['VCU', 'MCU', 'BMS/MSB'] as const
export type KeyControllerName = typeof keyControllerNames[number]
export function keyControllerName(value: unknown): KeyControllerName | null {
	const name = String(value ?? '').trim().toUpperCase()
	if (['BMS', 'MSB', 'BMS/MSB', 'MSB/BMS'].includes(name)) return 'BMS/MSB'
	if (['VCU', 'EVCU'].includes(name)) return 'VCU'
	return name === 'MCU' ? 'MCU' : null
}
export const controllerFields = ['name', 'description', 'network', 'supplier', 'functionalPart', 'productPart', 'software', 'calibrationPart', 'calibrationVersion', 'flashingDate', 'productionDate', 'serial'] as const
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
export type Controller = { name: string; description: string; network: string; supplier: string; functionalPart: string; productPart: string; software: string; calibrationPart: string; calibrationVersion: string; flashingDate: string; productionDate: string; serial: string }
export type Fault = { controller: string; code: string; status: string; statusByte: string; description: string; context: string }
export type DoveData = { vin: string; rawVin: string; vehicleId: string; recordedAt: string; software: string; mileage: number | null; soc: number | null; vehicleMode: string; controllers: Controller[]; faults: Fault[]; warnings: string[]; sheets: string[] }
export type ReportData = { name: string; checksum: string; size: number; recordedAt: string; savedAt: string; parserVersion: string; parsed: DoveData; vehicleSnapshot: Fields }
export const DOVE_BATCH_LIMIT = 8
export const DOVE_MAX_FILE_BYTES = 10 * 1024 * 1024
export type DoveImportConfirmation = { confirmed: true; reportOnly?: boolean; selections?: Partial<Record<KeyControllerName, number>>; versions?: Partial<Record<KeyControllerName, number | null>>; allowOlder?: boolean }
export type DovePreview = { id: string; filename: string; checksum: string; size: number; parsed: DoveData; expires: number; vehicle: BusinessRecord | null; currentControllers: BusinessRecord[]; match: 'matched' | 'unmatched' | 'ambiguous'; existingId: string | null }
export type DoveBatchPreviewResult = { index: number; filename: string } & ({ preview: DovePreview; error?: never } | { preview?: never; error: string })
export type DoveBatchSaveResult = { draftId: string } & ({ record: BusinessRecord; error?: never } | { record?: never; error: string })
