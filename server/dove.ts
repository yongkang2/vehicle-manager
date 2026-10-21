import { fork } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { AppError } from './team.js'
import { Business, checksum, now } from './business.js'
import type { Actor, BusinessRecord, DoveData, ReportData } from '../shared/business.js'

type Draft = { id: string; owner: string; filename: string; bytes: Buffer; parsed: DoveData; checksum: string; expires: number }
export type Preview = { id: string; filename: string; checksum: string; size: number; parsed: DoveData; expires: number; vehicle: BusinessRecord | null; match: 'matched' | 'unmatched' | 'ambiguous'; existingId: string | null }
function parseIsolated(bytes: Buffer): Promise<DoveData> {
  return new Promise((resolve, reject) => {
    const compiled = fileURLToPath(new URL('./dove-worker.js', import.meta.url))
    const entry = existsSync(compiled) ? compiled : fileURLToPath(new URL('./dove-worker.ts', import.meta.url))
    const child = fork(entry, [], { execArgv: [...(entry.endsWith('.ts') ? ['--import', 'tsx'] : []), '--max-old-space-size=256'], stdio: ['ignore', 'ignore', 'ignore', 'ipc'], serialization: 'advanced', windowsHide: true })
    let settled = false
    const timer = setTimeout(() => { settled = true; child.kill(); reject(new AppError('PARSE_TIMEOUT', 422)) }, 20000)
    const finish = () => { clearTimeout(timer); child.kill() }
    child.once('message', (message: { ok: boolean; result?: DoveData; error?: string }) => {
      settled = true; finish()
      if (message.ok && message.result) resolve(message.result)
      else reject(new AppError(['INVALID_VIN', 'VIN_MISMATCH', 'EXCEL_RESOURCE_LIMIT', 'UNSUPPORTED_REPORT', 'FILE_TOO_LARGE'].includes(message.error || '') ? message.error! : 'DOVE_PARSE_FAILED', 422))
    })
    child.once('error', () => { if (!settled) { settled = true; finish(); reject(new AppError('DOVE_PARSE_FAILED', 422)) } })
    child.once('exit', () => { if (!settled) { settled = true; finish(); reject(new AppError('DOVE_PARSE_FAILED', 422)) } })
    child.send(bytes)
  })
}

export class DoveService {
  private readonly drafts = new Map<string, Draft>()
  private active = 0
  constructor(readonly business: Business) {}
  private view(draft: Draft): Preview {
    const matches = this.business.list('vehicle').filter(record => !record.archived && record.data.vin === draft.parsed.vin)
    const id = `report-${draft.checksum}`
    const existing = this.business.store.db.prepare('SELECT id FROM records WHERE id=?').get(id)
    return { id: draft.id, filename: draft.filename, checksum: draft.checksum, size: draft.bytes.length, parsed: draft.parsed, expires: draft.expires, vehicle: matches.length === 1 ? matches[0] : null, match: matches.length === 1 ? 'matched' : matches.length ? 'ambiguous' : 'unmatched', existingId: existing ? id : null }
  }
  async preview(bytes: Buffer, filename: string, owner: string): Promise<Preview> {
    if (!/\.xlsx$/i.test(filename)) throw new AppError('XLSX_REQUIRED', 422)
    if (this.active >= 2) throw new AppError('DOVE_BUSY', 429)
    if (bytes.length > 10 * 1024 * 1024) throw new AppError('FILE_TOO_LARGE', 413)
    this.active++
    let parsed: DoveData
    try { parsed = await parseIsolated(bytes) } finally { this.active-- }
    for (const [id, draft] of this.drafts) if (draft.expires < Date.now()) this.drafts.delete(id)
    while (this.drafts.size >= 8) this.drafts.delete(this.drafts.keys().next().value!)
    const draft: Draft = { id: randomUUID(), owner, filename, bytes, parsed, checksum: checksum(bytes), expires: Date.now() + 30 * 60 * 1000 }
    this.drafts.set(draft.id, draft)
    return this.view(draft)
  }
  async save(id: string, owner: string, actor: Actor): Promise<BusinessRecord> {
    const draft = this.drafts.get(id)
    if (!draft || draft.owner !== owner || draft.expires < Date.now()) throw new AppError('DRAFT_EXPIRED', 409)
    const preview = this.view(draft)
    if (!preview.vehicle) throw new AppError('VIN_NOT_MATCHED', 409)
    if (preview.existingId) return this.business.get(preview.existingId)
    await this.business.blob(draft.bytes)
    const current = this.view(draft)
    if (!current.vehicle) throw new AppError('VIN_NOT_MATCHED', 409)
    if (current.existingId) return this.business.get(current.existingId)
    const data: ReportData = { name: draft.filename, checksum: draft.checksum, size: draft.bytes.length, recordedAt: draft.parsed.recordedAt, savedAt: now(), parserVersion: 'dove-current-1', parsed: draft.parsed, vehicleSnapshot: current.vehicle.data }
    const report = this.business.write({ id: `report-${draft.checksum}`, kind: 'report', vehicleId: current.vehicle.id, data: { ...data }, actor, reason: 'DOVE retained after VIN verification', internal: true })
    this.drafts.delete(id)
    return report
  }
}

export type Difference = { key: string; status: 'added' | 'missing' | 'changed' | 'unchanged' | 'ambiguous'; before: unknown; after: unknown; fields: string[] }
function differences<T extends object>(before: T[], after: T[], keyOf: (item: T) => string): Difference[] {
  const left = new Map<string, T[]>(), right = new Map<string, T[]>()
  for (const [items, target] of [[before, left], [after, right]] as const) for (const item of items) target.set(keyOf(item), [...(target.get(keyOf(item)) || []), item])
  return [...new Set([...left.keys(), ...right.keys()])].sort().map(key => {
    const previous = left.get(key) || [], current = right.get(key) || []
    const fields = previous.length === 1 && current.length === 1 ? Object.keys(previous[0]).filter(field => JSON.stringify((previous[0] as Record<string, unknown>)[field]) !== JSON.stringify((current[0] as Record<string, unknown>)[field])) : []
    return { key, status: previous.length > 1 || current.length > 1 ? 'ambiguous' : !previous.length ? 'added' : !current.length ? 'missing' : fields.length ? 'changed' : 'unchanged', before: previous.length === 1 ? previous[0] : previous, after: current.length === 1 ? current[0] : current, fields }
  })
}
export function compareReports(left: BusinessRecord, right: BusinessRecord) {
  if (left.kind !== 'report' || right.kind !== 'report' || left.vehicleId !== right.vehicleId) throw new AppError('REPORT_VIN_MISMATCH', 409)
  const before = (left.data as unknown as ReportData).parsed, after = (right.data as unknown as ReportData).parsed
  if (before.vin !== after.vin) throw new AppError('REPORT_VIN_MISMATCH', 409)
  return { left, right, controllers: differences(before.controllers, after.controllers, item => `${item.name}|${item.network}`), faults: differences(before.faults, after.faults, item => `${item.controller}|${item.code}`) }
}