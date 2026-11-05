import ExcelJS from 'exceljs'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { LocalStore } from './store.js'
import { AppError } from './team.js'
import type { Change } from '../shared/business.js'

function text(value: unknown, max: number): string {
  if (value === undefined) return ''
  if (typeof value !== 'string' || value.length > max) throw new AppError('INVALID_INPUT')
  return value
}
const display = (value: unknown) => value === undefined ? '' : typeof value === 'string' ? value : JSON.stringify(value)
type HistoryFilters = { vehicleId?: unknown; q?: unknown; page?: unknown; kind?: unknown; date?: unknown; offset?: unknown; endOffset?: unknown }

export class History {
  constructor(private store: LocalStore) {}

  private selection(input: HistoryFilters) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new AppError('INVALID_INPUT')
    const vehicleId = text(input.vehicleId, 200), q = text(input.q, 1000).trim()
    const kind = text(input.kind, 32), date = text(input.date, 10), offsetText = text(input.offset, 5)
    if (kind && !['vehicle', 'part', 'modification', 'equipment', 'report', 'attachment', 'configurationRevision', 'componentType'].includes(kind)) throw new AppError('INVALID_INPUT')
    if (input.offset !== undefined && (!/^-?\d+$/.test(offsetText) || !Number.isInteger(Number(offsetText)) || Math.abs(Number(offsetText)) > 840)) throw new AppError('INVALID_INPUT')
    const endOffsetText = input.endOffset === undefined ? offsetText : text(input.endOffset, 5)
    if (input.endOffset !== undefined && (!/^-?\d+$/.test(endOffsetText) || !Number.isInteger(Number(endOffsetText)) || Math.abs(Number(endOffsetText)) > 840)) throw new AppError('INVALID_INPUT')
    const clauses: string[] = [], values: string[] = []
    if (vehicleId) { clauses.push('changes.vehicle_id=?'); values.push(vehicleId) }
    if (kind) { clauses.push("json_extract(changes.payload,'$.kind')=?"); values.push(kind) }
    if (date) {
      const midnight = Date.parse(`${date}T00:00:00.000Z`)
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(midnight) || new Date(midnight).toISOString().slice(0, 10) !== date || input.offset === undefined) throw new AppError('INVALID_INPUT')
      const start = midnight + Number(offsetText) * 60000
      clauses.push('julianday(changes.created)>=julianday(?) AND julianday(changes.created)<julianday(?)')
      values.push(new Date(start).toISOString(), new Date(midnight + 86400000 + Number(endOffsetText) * 60000).toISOString())
    }
    const fieldAliases: Record<string, string> = { 软件: 'software', 软件版本: 'software', 硬件: 'hardware', 硬件版本: 'hardware', 序列号: 'serial', 名称: 'name', 车型: 'model', 负责人: 'owner', 状态: 'status', 标定版本: 'calibrationVersion', 说明: 'description', 备注: 'notes' }
    for (const term of q ? q.split(/\s+/) : []) {
      clauses.push(`(EXISTS (SELECT 1 FROM json_tree(changes.payload) WHERE CAST(json_tree.key AS TEXT) LIKE ? ESCAPE '\\' OR (json_tree.type IN ('text','integer','real','true','false') AND CAST(json_tree.value AS TEXT) LIKE ? ESCAPE '\\')) OR json_extract(vehicle.data,'$.model') LIKE ? ESCAPE '\\' OR json_extract(vehicle.data,'$.vin') LIKE ? ESCAPE '\\' OR changes.vehicle_id IN (SELECT historical.vehicle_id FROM changes historical WHERE json_extract(historical.payload,'$.kind')='vehicle' AND (json_extract(historical.payload,'$.after.model') LIKE ? ESCAPE '\\' OR json_extract(historical.payload,'$.before.model') LIKE ? ESCAPE '\\' OR json_extract(historical.payload,'$.after.vin') LIKE ? ESCAPE '\\' OR json_extract(historical.payload,'$.before.vin') LIKE ? ESCAPE '\\')))`)
      const pattern = `%${term.replace(/[\\%_]/g, '\\$&')}%`
      const keyPattern = `%${(Object.hasOwn(fieldAliases, term) ? fieldAliases[term] : term).replace(/[\\%_]/g, '\\$&')}%`
      values.push(keyPattern, pattern, pattern, pattern, pattern, pattern, pattern, pattern)
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''
    const from = "FROM changes LEFT JOIN records vehicle ON vehicle.id=changes.vehicle_id AND vehicle.kind='vehicle'"
    return { where, from, values }
  }

  query(input: HistoryFilters) {
    const { where, from, values } = this.selection(input)
    const pageText = text(input.page, 20) || '1', page = Number(pageText)
    if (!/^[1-9]\d*$/.test(pageText) || !Number.isSafeInteger(page) || !Number.isSafeInteger(page * 50)) throw new AppError('INVALID_INPUT')
    const total = Number(this.store.db.prepare(`SELECT count(*) AS total ${from} ${where}`).get(...values)!.total)
    const nonblank = (value: unknown) => typeof value === 'string' ? value.trim() : ''
    const labels = new Map<string, { model: string; vin: string }>()
    const rows = this.store.db.prepare(`SELECT ids.vehicle_id, vehicle.data, CASE WHEN vehicle.data IS NULL THEN (SELECT payload FROM changes historical WHERE historical.vehicle_id=ids.vehicle_id AND json_extract(historical.payload,'$.kind')='vehicle' ORDER BY historical.created DESC,historical.rowid DESC LIMIT 1) END AS historical FROM (SELECT DISTINCT vehicle_id FROM changes) ids LEFT JOIN records vehicle ON vehicle.id=ids.vehicle_id AND vehicle.kind='vehicle' ORDER BY ids.vehicle_id`).all()
    for (const row of rows) {
      const current = row.data ? JSON.parse(row.data as string) : null
      const historical = row.historical ? JSON.parse(row.historical as string) as Change : null
      labels.set(String(row.vehicle_id), current ? { model: nonblank(current.model), vin: nonblank(current.vin) } : { model: nonblank(historical?.after.model) || nonblank(historical?.before?.model), vin: nonblank(historical?.after.vin) || nonblank(historical?.before?.vin) })
    }
    const items = this.store.db.prepare(`SELECT changes.payload ${from} ${where} ORDER BY changes.created DESC,changes.rowid DESC LIMIT 50 OFFSET ?`).all(...values, (page - 1) * 50).map(row => {
      const change = JSON.parse(row.payload as string) as Change, label = labels.get(change.vehicleId)
      return { ...change, vehicleLabel: label?.model || label?.vin || change.vehicleId }
    })
    const vehicleOptions = [...labels].map(([id, label]) => ({ id, label: [label.model, label.vin].filter(Boolean).join(' · ') || id }))
    return { items, total, page, pageSize: 50, vehicleOptions }
  }

  async export(input: HistoryFilters = {}) {
    const { where, from, values } = this.selection(input)
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'vehicle-history-'))
    const file = path.join(directory, 'history.xlsx')
    const cleanup = () => fs.rm(directory, { recursive: true, force: true })
    try {
      const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({ filename: file, useSharedStrings: false })
      let sheet = workbook.addWorksheet('Vehicle History'), rows = 0, sheetNumber = 1
      const serials = (fields: Record<string, unknown> | null) => Object.fromEntries(Object.entries(fields || {}).filter(([key]) => /serial/i.test(key)))
      const headers = ['Time', 'Actor Name', 'Actor ID', 'Device ID', 'Kind', 'Record ID', 'Vehicle ID', 'Action', 'Reason', 'Field', 'Before', 'After', 'Source ID', 'Change ID', 'Current Vehicle Name', 'Current Vehicle VIN', 'Object Name', 'Serial Before', 'Serial After', 'Text Part']
      sheet.addRow(headers).commit()
      for (const row of this.store.db.prepare(`SELECT changes.payload, vehicle.data AS vehicle_data ${from} ${where} ORDER BY changes.created DESC,changes.rowid DESC`).iterate(...values)) {
        const current = row.vehicle_data ? JSON.parse(row.vehicle_data as string) as Record<string, unknown> : {}
        const change = JSON.parse(row.payload as string) as Change
        const fields = [...new Set([...Object.keys(change.before || {}), ...Object.keys(change.after)])].filter(key => JSON.stringify(change.before?.[key]) !== JSON.stringify(change.after[key]))
        if (change.archivedBefore !== change.archivedAfter) fields.push('$archived')
        if (!fields.length) fields.push('')
        for (const field of fields) {
          const before = field === '$archived' ? change.archivedBefore : change.before?.[field]
          const after = field === '$archived' ? change.archivedAfter : change.after[field]
          const cells = [change.created, change.actor.name, change.actor.id, change.actor.deviceId, change.kind, change.recordId, change.vehicleId, change.action, change.reason, field, display(before), display(after), change.sourceId || '', change.id, display(current.name), display(current.vin), display(change.after.name ?? change.before?.name), display(serials(change.before)), display(serials(change.after))]
          // Split every text column so even nested report snapshots remain recoverable within Excel's cell limit.
          const parts = Math.max(1, ...cells.map(cell => Math.ceil(cell.length / 30000)))
          for (let part = 0; part < parts; part++) {
            if (rows === 1048575) { sheet.commit(); sheet = workbook.addWorksheet(`Vehicle History ${++sheetNumber}`); sheet.addRow(headers).commit(); rows = 0 }
            sheet.addRow([...cells.map(cell => cell.length > 30000 ? cell.slice(part * 30000, (part + 1) * 30000) : cell), `${part + 1}/${parts}`]).commit()
            rows++
          }
        }
      }
      sheet.commit()
      await workbook.commit()
      return { path: file, cleanup }
    } catch (error) { await cleanup(); throw error }
  }
}
