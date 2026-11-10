import path from 'node:path'
import { Business, checksum, normalizeFields, reason as normalizeReason, validateManualRecordFields } from './business.js'
import { AppError } from './team.js'
import { ATTACHMENT_MAX_FILE_BYTES } from '../shared/attachments.js'
import type { Actor, BusinessRecord } from '../shared/business.js'

type EquipmentSave = { id?: string; vehicleId: string | null; data: unknown; version?: number; reason: unknown; requestId?: unknown }
type SaveReceipt = { actorKey: string; digest: string; recordId: string; vehicleId: string }
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i

/** Keep equipment and ordinary vehicle attachments on the same established allowlist. */
export function validateAttachmentFile(name: string, bytes: Buffer): void {
  if (bytes.length > ATTACHMENT_MAX_FILE_BYTES) throw new AppError('FILE_TOO_LARGE', 413)
  const extension = path.extname(name).toLowerCase()
  const valid = extension === '.xlsx' ? bytes.subarray(0, 4).equals(Buffer.from([80, 75, 3, 4]))
    : extension === '.xls' ? bytes.subarray(0, 8).equals(Buffer.from([208, 207, 17, 224, 161, 177, 26, 225]))
      : extension === '.pdf' ? bytes.subarray(0, 5).toString() === '%PDF-'
        : extension === '.png' ? bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
          : ['.jpg', '.jpeg', '.jfif'].includes(extension) && bytes.subarray(0, 3).equals(Buffer.from([255, 216, 255]))
  if (!valid) throw new AppError('FILE_TYPE_NOT_ALLOWED', 422)
}

export class EquipmentRecords {
  constructor(readonly business: Business) {}

  private equipment(id: string): BusinessRecord {
    const record = this.business.get(id)
    if (record.kind !== 'equipment' || !record.vehicleId) throw new AppError('INVALID_INPUT')
    if (record.archived) throw new AppError('RECORD_ARCHIVED', 409)
    this.vehicle(record.vehicleId)
    return record
  }

  private vehicle(id: string): void {
    const vehicle = this.business.get(id)
    if (vehicle.kind !== 'vehicle' || vehicle.archived) throw new AppError('PARENT_ARCHIVED', 409)
  }

  /** Receipts and record/history/outbox writes share one local transaction. */
  save(input: EquipmentSave, actor: Actor, accountId: string): BusinessRecord {
    const data = normalizeFields('equipment', input.data), explanation = normalizeReason(input.reason)
    if (!input.vehicleId || typeof input.vehicleId !== 'string') throw new AppError('INVALID_INPUT')
    const vehicleId = input.vehicleId
    let key: string | null = null
    if (input.requestId !== undefined) {
      if (typeof input.requestId !== 'string' || !uuid.test(input.requestId)) throw new AppError('INVALID_INPUT')
      key = `equipmentRequest:${input.requestId.toLowerCase()}`
    }
    const actorKey = JSON.stringify([accountId, actor.id, actor.deviceId])
    const digest = checksum(JSON.stringify({ id: input.id || null, vehicleId: input.vehicleId, version: input.version ?? null, data, reason: explanation }))
    // Earlier receipts predate the equipmentType field. Only an unclassified
    // replay may match that exact normalized legacy payload; a new selection
    // must never reuse a receipt from another command.
    const legacyData = Object.fromEntries(Object.entries(data).filter(([field]) => field !== 'equipmentType'))
    const legacyDigest = !data.equipmentType ? checksum(JSON.stringify({ id: input.id || null, vehicleId: input.vehicleId, version: input.version ?? null, data: legacyData, reason: explanation })) : null
    let result!: BusinessRecord
    this.business.store.transaction(() => {
      this.business.store.assertWritable()
      this.business.store.assertNotDeleted(input.id || vehicleId, vehicleId)
      const receipt = key ? this.business.store.get<SaveReceipt>(key) : null
      if (receipt) {
        if (receipt.actorKey !== actorKey || receipt.digest !== digest && receipt.digest !== legacyDigest || receipt.vehicleId !== input.vehicleId) throw new AppError('EQUIPMENT_REQUEST_MISMATCH', 409)
        const saved = this.business.get(receipt.recordId)
        if (saved.kind !== 'equipment' || saved.vehicleId !== receipt.vehicleId) throw new AppError('EQUIPMENT_REQUEST_MISMATCH', 409)
        // Return current data after recovery; never overwrite a subsequent edit,
        // archival or restore with the earlier request's result.
        result = saved
        return
      }
      this.vehicle(vehicleId)
      let current: BusinessRecord | undefined
      if (input.id) {
        current = this.equipment(input.id)
        if (current.vehicleId !== input.vehicleId) throw new AppError('INVALID_INPUT')
      }
      validateManualRecordFields('equipment', data, current)
      result = this.business.write({ id: input.id, kind: 'equipment', vehicleId, data, version: input.version, actor, reason: explanation })
      if (key) this.business.store.set(key, { actorKey, digest, recordId: result.id, vehicleId } satisfies SaveReceipt)
    })
    return result
  }

  async upload(id: string, file: { name: string; bytes: Buffer }, reason: unknown, actor: Actor, beforeCommit?: () => Promise<Actor>): Promise<BusinessRecord> {
    const explanation = normalizeReason(reason), original = this.equipment(id)
    const name = path.basename(file.name.replaceAll('\\', '/'))
    if (!name || name.length > 240 || [...name].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) throw new AppError('INVALID_INPUT')
    validateAttachmentFile(name, file.bytes)
    const key = await this.business.blob(file.bytes)
    const author = beforeCommit ? await beforeCommit() : actor
    let result!: BusinessRecord
    this.business.store.transaction(() => {
      const current = this.equipment(id)
      if (current.vehicleId !== original.vehicleId) throw new AppError('INVALID_INPUT')
      result = this.business.write({ kind: 'attachment', vehicleId: current.vehicleId, data: { name, checksum: key, size: file.bytes.length, savedAt: new Date().toISOString(), equipmentId: current.id }, actor: author, reason: explanation, internal: true })
    })
    return result
  }
}
