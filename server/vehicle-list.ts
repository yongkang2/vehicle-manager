import { DatabaseSync } from 'node:sqlite'
import { AppError } from './team.js'
import type { ConfigurationWorkingView } from '../shared/configuration-revisions.js'
import type { WorkspaceData } from '../shared/workspace.js'
import type { VehicleListQuery } from '../shared/vehicle-list.js'
import { vehicleColumnIds } from '../shared/vehicle-table.js'
import { createVehicleFilterKeys, sortedVehicleReports } from '../shared/vehicle-table-values.js'
import type { VehicleFilterColumnId } from '../shared/vehicle-table-values.js'

const filterColumns = vehicleColumnIds.filter((column): column is VehicleFilterColumnId => column !== 'actions')

function createProjection(view: ConfigurationWorkingView) {
  const db = new DatabaseSync(':memory:')
  try {
    const vehicles = view.records.filter(record => record.kind === 'vehicle')
    const keys = createVehicleFilterKeys(view.records, view.revisionSummaries)
    // JavaScript preserves Unicode casing, NUL and UTF-16 substring semantics.
    db.function('contains_js', (text, search) => Number((JSON.parse(String(text)) as string).includes(JSON.parse(String(search)) as string)))
    db.exec(`CREATE TABLE vehicles (ordinal INTEGER PRIMARY KEY, archived INTEGER, vehicle_status TEXT, search TEXT, ${filterColumns.map(column => `"${column}" TEXT`).join(', ')})`)
    const insert = db.prepare(`INSERT INTO vehicles VALUES (${Array(4 + filterColumns.length).fill('?').join(', ')})`)
    db.exec('BEGIN')
    vehicles.forEach((record, ordinal) => insert.run(ordinal, Number(record.archived), String(record.data.status), JSON.stringify(Object.values(record.data).join(' ').toLowerCase()), ...filterColumns.map(column => keys.get(record.id)![column])))
    db.exec('COMMIT')
    db.exec('CREATE INDEX vehicles_archive_status ON vehicles (archived, vehicle_status, ordinal)')
    for (const column of filterColumns) db.exec(`CREATE INDEX "filter_${column}" ON vehicles ("${column}", ordinal)`)
    const options = (archived: boolean): NonNullable<WorkspaceData['vehicleList']>['options'] => Object.fromEntries(filterColumns.map(column => [column, db.prepare(`SELECT "${column}" AS value FROM vehicles ${archived ? '' : 'WHERE archived = 0'} GROUP BY "${column}" ORDER BY MIN(ordinal)`).all().map(row => String(row.value))]))
    const counts: Record<string, number> = { total: 0, available: 0, testing: 0, maintenance: 0, inactive: 0 }
    for (const row of db.prepare('SELECT vehicle_status AS status, COUNT(*) AS count FROM vehicles WHERE archived = 0 GROUP BY vehicle_status').all()) {
      counts.total += Number(row.count)
      if (Object.hasOwn(counts, String(row.status))) counts[String(row.status)] += Number(row.count)
    }
    return { db, vehicles, options: [options(false), options(true)], counts }
  } catch (error) { db.close(); throw error }
}

/** One derived working view per local revision, never a cache of authorization. */
export class VehicleListQueries {
  private cached: { stamp: string | null; view: ConfigurationWorkingView; projection: ReturnType<typeof createProjection> } | null = null
  constructor(private readonly build: () => ConfigurationWorkingView) {}
  close(): void { this.cached?.projection.db.close(); this.cached = null }
  read(stamp: string | null, query: VehicleListQuery): WorkspaceData {
    if (!query || typeof query.search !== 'string' || query.search.length > 4000 || typeof query.archived !== 'boolean' || !Number.isSafeInteger(query.page) || query.page < 1 || !Number.isSafeInteger(query.pageSize) || query.pageSize < 1 || query.pageSize > 100 || query.status !== undefined && !['available', 'testing', 'maintenance', 'inactive'].includes(query.status) || !query.filters || typeof query.filters !== 'object' || Array.isArray(query.filters)) throw new AppError('INVALID_INPUT')
    for (const id of [query.detailId, query.reportId]) if (id !== undefined && (typeof id !== 'string' || !id || id.length > 200)) throw new AppError('INVALID_INPUT')
    for (const [column, values] of Object.entries(query.filters)) if (column === 'actions' || !(vehicleColumnIds as readonly string[]).includes(column) || !Array.isArray(values) || values.length > 20000 || values.some(value => typeof value !== 'string' || value.length > 10000)) throw new AppError('INVALID_INPUT')
    if (!this.cached || stamp === null || this.cached.stamp !== stamp) {
      const view = this.build()
      const projection = createProjection(view)
      this.cached?.projection.db.close()
      // shortcut: retain the complete validated view; revisit if fleet memory becomes limiting.
      this.cached = { stamp, view, projection }
    }
    const { view, projection } = this.cached
    const { db, vehicles, counts } = projection
    const options = projection.options[Number(query.archived)]
    const clauses: string[] = query.archived ? [] : ['archived = 0']
    const parameters: (string | number)[] = []
    if (query.status) { clauses.push('vehicle_status = ?'); parameters.push(query.status) }
    if (query.search) { clauses.push('contains_js(search, ?)'); parameters.push(JSON.stringify(query.search.toLowerCase())) }
    for (const [column, selected] of Object.entries(query.filters)) if (selected?.length) {
      clauses.push(`"${column}" IN (SELECT value FROM json_each(?))`)
      parameters.push(JSON.stringify(selected))
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''
    const total = Number(db.prepare(`SELECT COUNT(*) AS total FROM vehicles ${where}`).get(...parameters)!.total)
    const page = Math.min(query.page, Math.max(1, Math.ceil(total / query.pageSize)))
    const rows = db.prepare(`SELECT ordinal FROM vehicles ${where} ORDER BY ordinal LIMIT ? OFFSET ?`).all(...parameters, query.pageSize, (page - 1) * query.pageSize).map(row => vehicles[Number(row.ordinal)])
    const ids = new Set(rows.map(record => record.id))
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
    return { ...view, records: [...summaries.values()], revisionSummaries: view.revisionSummaries.filter(summary => ids.has(summary.vehicleId) || detailVehicles.has(summary.vehicleId)), historyRevision: 0, audit: [], quarantined: [], vehicleList: { total, page, pageSize: query.pageSize, ids: rows.map(record => record.id), counts, options, detailId: detail?.id || null, reportId: report?.id || null } }
  }
}
