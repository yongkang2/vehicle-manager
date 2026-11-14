import { AppError } from './team.js'
import type { ConfigurationWorkingView } from '../shared/configuration-revisions.js'
import type { WorkspaceData } from '../shared/workspace.js'
import type { VehicleListQuery } from '../shared/vehicle-list.js'
import { vehicleColumnIds } from '../shared/vehicle-table.js'
import { createVehicleFilterKeys, sortedVehicleReports } from '../shared/vehicle-table-values.js'
import type { VehicleFilterColumnId } from '../shared/vehicle-table-values.js'

/** One derived working view per local revision, never a cache of authorization. */
export class VehicleListQueries {
  private cached: { stamp: string | null; view: ConfigurationWorkingView; keys: ReturnType<typeof createVehicleFilterKeys> } | null = null
  constructor(private readonly build: () => ConfigurationWorkingView) {}
  read(stamp: string | null, query: VehicleListQuery): WorkspaceData {
    if (!query || typeof query.search !== 'string' || query.search.length > 4000 || typeof query.archived !== 'boolean' || !Number.isSafeInteger(query.page) || query.page < 1 || !Number.isSafeInteger(query.pageSize) || query.pageSize < 1 || query.pageSize > 100 || query.status !== undefined && !['available', 'testing', 'maintenance', 'inactive'].includes(query.status) || !query.filters || typeof query.filters !== 'object' || Array.isArray(query.filters)) throw new AppError('INVALID_INPUT')
    for (const id of [query.detailId, query.reportId]) if (id !== undefined && (typeof id !== 'string' || !id || id.length > 200)) throw new AppError('INVALID_INPUT')
    for (const [column, values] of Object.entries(query.filters)) if (column === 'actions' || !(vehicleColumnIds as readonly string[]).includes(column) || !Array.isArray(values) || values.length > 20000 || values.some(value => typeof value !== 'string' || value.length > 10000)) throw new AppError('INVALID_INPUT')
    if (!this.cached || stamp === null || this.cached.stamp !== stamp) {
      const view = this.build()
      this.cached = { stamp, view, keys: createVehicleFilterKeys(view.records, view.revisionSummaries) }
    }
    const { view, keys } = this.cached
    const vehicles = view.records.filter(record => record.kind === 'vehicle')
    const eligible = vehicles.filter(record => query.archived || !record.archived)
    const options: NonNullable<WorkspaceData['vehicleList']>['options'] = {}
    for (const column of vehicleColumnIds) if (column !== 'actions') options[column] = [...new Set(eligible.map(record => keys.get(record.id)![column]))]
    const search = query.search.toLowerCase()
    const matches = eligible.filter(record => (!query.status || record.data.status === query.status) && Object.values(record.data).join(' ').toLowerCase().includes(search) && Object.entries(query.filters).every(([column, selected]) => !selected?.length || selected.includes(keys.get(record.id)![column as VehicleFilterColumnId])))
    const page = Math.min(query.page, Math.max(1, Math.ceil(matches.length / query.pageSize)))
    const rows = matches.slice((page - 1) * query.pageSize, page * query.pageSize), ids = new Set(rows.map(record => record.id))
    const summaries = new Map(rows.map(record => [record.id, record]))
    for (const record of view.records) if (ids.has(record.vehicleId || '') && record.kind === 'part' && !record.archived && ['battery', 'controller'].includes(String(record.data.category))) summaries.set(record.id, { ...record, data: Object.fromEntries(['name', 'category', 'maturity', 'productPart', 'serial', 'removedAt', 'controllerType'].map(field => [field, record.data[field]])) })
    const reportVehicles = new Set<string>()
    for (const record of sortedVehicleReports(view.records)) if (!record.archived && ids.has(record.vehicleId || '') && !reportVehicles.has(record.vehicleId!)) {
      reportVehicles.add(record.vehicleId!)
      summaries.set(record.id, { ...record, data: { name: record.data.name, recordedAt: record.data.recordedAt, savedAt: record.data.savedAt } })
    }
    const detail = vehicles.find(record => record.id === query.detailId)
    const report = query.reportId ? view.records.find(record => record.id === query.reportId && record.kind === 'report') : undefined
    const detailVehicles = new Set([detail?.id, report?.vehicleId].filter((id): id is string => Boolean(id)))
    const groups = new Set(view.records.filter(record => record.kind === 'modification' && detailVehicles.has(record.vehicleId || '')).map(record => record.data.groupId).filter((id): id is string => typeof id === 'string'))
    // Modification scope reviews and populate destinations need the whole fleet's
    // identities and relevant memberships, but not its equipment/report payloads.
    if (detail) for (const vehicle of vehicles) if (!summaries.has(vehicle.id)) summaries.set(vehicle.id, { ...vehicle, data: { name: vehicle.data.name, vin: vehicle.data.vin, plate: vehicle.data.plate, model: vehicle.data.model } })
    for (const record of view.records) if (detailVehicles.has(record.id) || detailVehicles.has(record.vehicleId || '') || groups.has(record.id) || record.kind === 'modification' && typeof record.data.groupId === 'string' && groups.has(record.data.groupId)) summaries.set(record.id, record)
    const counts: Record<string, number> = { total: 0, available: 0, testing: 0, maintenance: 0, inactive: 0 }
    for (const vehicle of vehicles) if (!vehicle.archived) { counts.total++; if (Object.hasOwn(counts, String(vehicle.data.status))) counts[String(vehicle.data.status)]++ }
    return { ...view, records: [...summaries.values()], revisionSummaries: view.revisionSummaries.filter(summary => ids.has(summary.vehicleId) || detailVehicles.has(summary.vehicleId)), historyRevision: 0, audit: [], quarantined: [], vehicleList: { total: matches.length, page, pageSize: query.pageSize, ids: rows.map(record => record.id), counts, options, detailId: detail?.id || null, reportId: report?.id || null } }
  }
}
