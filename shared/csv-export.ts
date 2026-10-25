import { entryFields, partFields, vehicleFields } from './business.js'
import type { BusinessRecord, RecordKind } from './business.js'

export const MAX_EXPORT_VEHICLES = 20000
export const MAX_EXPORT_ID_LENGTH = 120
export const exportKinds: RecordKind[] = ['vehicle', 'part', 'modification', 'equipment', 'report', 'attachment']
export const exportFilterFields = ['project', 'model', 'status', 'owner', 'physicalLocation', 'thermal'] as const
export type VehicleExportFilters = { search: string } & Record<typeof exportFilterFields[number], string[]>
export type ExportConfiguration = { version: 1; filters: VehicleExportFilters; columns: Partial<Record<RecordKind, string[]>>; includeArchived: boolean; language: 'en' | 'zh' }
export type ExportTemplate = { id: string; name: string; configuration: ExportConfiguration; updated: string }
export type CsvExportRequest = { vehicleIds: string[]; configuration: ExportConfiguration }
export type ExportColumn = { id: string; label: [string, string] }

const labels: Record<string, [string, string]> = {
  id: ['Record ID', '记录标识'], vehicleId: ['Vehicle ID', '车辆标识'], vehicleVin: ['Vehicle VIN', '车辆 VIN'], archived: ['Archived', '已归档'], version: ['Version', '版本'], updated: ['Last updated', '最近更新'],
  name: ['Name', '名称'], project: ['Project code', '项目代号'], model: ['Model', '车型'], vin: ['VIN', 'VIN'], color: ['Color', '颜色'], plate: ['License plate', '车牌'], plateExpiry: ['Plate valid until', '车牌有效期'],
  status: ['Status', '状态'], physicalLocation: ['Physical location', '实际位置'], owner: ['Owner', '负责人'], thermal: ['Thermal System Type', '热管理系统类型'], notes: ['Notes', '其他说明'],
  description: ['Description', '说明'], category: ['Category', '部件类别'], position: ['Position / identifier', '位置 / 标识'], supplier: ['Supplier', '供应商'], serial: ['Serial number', '序列号'], type: ['Type', '类型'], hardware: ['Hardware version', '硬件版本'], software: ['Software identifier / version', '软件标识 / 版本'],
  controllerType: ['Controller Type', '控制器类型'], lifeStatus: ['Life Status', '寿命状态'],
  functionalPart: ['Functional part number', '功能零件号'], productPart: ['Product part number', '产品零件号'], calibrationPart: ['Software / calibration part', '软件 / 标定零件号'], calibrationVersion: ['Calibration version', '标定版本'], network: ['Diagnostic network', '诊断网络'],
  flashingDate: ['Flashed on', '刷写日期'], productionDate: ['Produced on', '生产日期'], sourceName: ['Original controller name', '报告原始名称'], reportId: ['Source report ID', '来源报告标识'], reportRecordedAt: ['Source report date', '来源报告采集时间'],
  maturity: ['Part maturity', '零件成熟度'], batteryStatus: ['Battery pack condition', '电池包状态'], installedAt: ['Installed on', '安装日期'], removedAt: ['Removed on', '拆除日期'],
  checksum: ['File checksum', '文件校验值'], size: ['File size (bytes)', '文件大小（字节）'], recordedAt: ['Recorded at', '采集时间'], savedAt: ['Retained at', '留存时间'], parserVersion: ['Parser version', '解析器版本'],
  reportVin: ['Report VIN', '报告 VIN'], rawVin: ['Original report VIN', '报告原始 VIN'], mileage: ['Mileage', '总里程'], soc: ['SOC', 'SOC'], vehicleMode: ['Vehicle mode', '车辆模式'],
}
const columns = (fields: readonly string[]): ExportColumn[] => fields.map(id => ({ id, label: labels[id] }))
const metadata = ['id', 'archived', 'version', 'updated']
const childMetadata = ['id', 'vehicleId', 'vehicleVin', 'archived', 'version', 'updated']
export const exportColumns: Record<RecordKind, ExportColumn[]> = {
  vehicle: [...columns(vehicleFields).map(column => column.id === 'name' ? { ...column, label: ['Nick Name', '昵称'] as [string, string] } : column), ...columns(metadata)],
  part: [...columns(partFields), ...columns(childMetadata)],
  modification: [...columns(entryFields), ...columns(childMetadata)],
  equipment: [...columns(entryFields), ...columns(childMetadata)],
  report: [...columns(['name', 'checksum', 'size', 'recordedAt', 'savedAt', 'parserVersion', 'reportVin', 'rawVin', 'software', 'mileage', 'soc', 'vehicleMode']).map(column => column.id === 'name' ? { ...column, label: ['Filename', '文件名'] as [string, string] } : column), ...columns(childMetadata)],
  attachment: [...columns(['name', 'checksum', 'size', 'savedAt']).map(column => column.id === 'name' ? { ...column, label: ['Filename', '文件名'] as [string, string] } : column), ...columns(childMetadata)],
}

export function defaultExportConfiguration(language: 'en' | 'zh'): ExportConfiguration {
  return { version: 1, filters: { search: '', project: [], model: [], status: [], owner: [], physicalLocation: [], thermal: [] }, columns: { vehicle: [...vehicleFields] }, includeArchived: false, language }
}

const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
const keysWithin = (value: Record<string, unknown>, allowed: readonly string[]) => Object.keys(value).every(key => allowed.includes(key))
export function parseExportConfiguration(value: unknown): ExportConfiguration | null {
  if (!object(value) || !keysWithin(value, ['version', 'filters', 'columns', 'includeArchived', 'language']) || value.version !== 1 || typeof value.includeArchived !== 'boolean' || (value.language !== 'en' && value.language !== 'zh')) return null
  const sourceFilters = value.filters, sourceColumns = value.columns
  if (!object(sourceFilters) || !keysWithin(sourceFilters, ['search', ...exportFilterFields]) || typeof sourceFilters.search !== 'string' || sourceFilters.search.length > 4000 || !object(sourceColumns) || !keysWithin(sourceColumns, exportKinds)) return null
  const filters: VehicleExportFilters = { search: sourceFilters.search, project: [], model: [], status: [], owner: [], physicalLocation: [], thermal: [] }
  for (const field of exportFilterFields) {
    const selected = sourceFilters[field]
    if (!Array.isArray(selected) || selected.length > 20000 || Array.from(selected).some(item => typeof item !== 'string' || item.length > 4000) || new Set(selected).size !== selected.length) return null
    filters[field] = [...selected]
  }
  const selectedColumns: ExportConfiguration['columns'] = {}
  for (const kind of exportKinds) {
    if (!Object.hasOwn(sourceColumns, kind)) continue
    const selected = sourceColumns[kind], allowed = exportColumns[kind].map(column => column.id)
    if (!Array.isArray(selected) || !selected.length || selected.length > allowed.length || Array.from(selected).some(id => typeof id !== 'string' || !allowed.includes(id)) || new Set(selected).size !== selected.length) return null
    selectedColumns[kind] = [...selected]
  }
  if (!Object.keys(selectedColumns).length) return null
  return { version: 1, filters, columns: selectedColumns, includeArchived: value.includeArchived, language: value.language }
}

const scalarText = (value: unknown) => typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' ? String(value) : ''
export function matchesExportVehicle(record: BusinessRecord, configuration: ExportConfiguration): boolean {
  if (record.kind !== 'vehicle' || (!configuration.includeArchived && record.archived)) return false
  for (const field of exportFilterFields) if (configuration.filters[field].length && !configuration.filters[field].includes(scalarText(record.data[field]))) return false
  const search = configuration.filters.search.trim().toLowerCase()
  return !search || vehicleFields.some(field => scalarText(record.data[field]).toLowerCase().includes(search))
}

export function recordsForExport(records: BusinessRecord[], kind: RecordKind, selectedVehicleIds: ReadonlySet<string>, includeArchived: boolean): BusinessRecord[] {
  const parents = new Set(records.filter(record => record.kind === 'vehicle' && selectedVehicleIds.has(record.id) && (includeArchived || !record.archived)).map(record => record.id))
  return records.filter(record => record.kind === kind && (includeArchived || !record.archived) && (kind === 'vehicle' ? parents.has(record.id) : record.vehicleId !== null && parents.has(record.vehicleId)))
}
