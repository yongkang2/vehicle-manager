import path from 'node:path'
import { Business, reason as normalizeReason } from './business.js'
import { AppError } from './team.js'
import type { Actor, BusinessRecord } from '../shared/business.js'
import { inspectVehiclePhoto, parsePhotoAttachmentId, PHOTO_MAX_BYTES } from '../shared/vehicle-photo.js'

export class VehiclePhotos {
  constructor(readonly business: Business) {}
  private vehicle(vehicleId: string, version?: number, editing = false): BusinessRecord {
    const vehicle = this.business.get(vehicleId)
    if (vehicle.kind !== 'vehicle') throw new AppError('INVALID_INPUT')
    if (editing && vehicle.archived) throw new AppError('PARENT_ARCHIVED', 409)
    if (version !== undefined && vehicle.version !== version) throw new AppError('VERSION_CONFLICT', 409)
    return vehicle
  }
  async upload(vehicleId: string, file: { name: string; bytes: Buffer }, version: number, reason: unknown, actor: Actor, beforeCommit?: () => Promise<Actor>): Promise<{ vehicle: BusinessRecord; attachment: BusinessRecord }> {
    const why = normalizeReason(reason)
    if (!Number.isSafeInteger(version) || version < 1) throw new AppError('INVALID_INPUT')
    this.vehicle(vehicleId, version, true)
    if (file.bytes.length > PHOTO_MAX_BYTES) throw new AppError('FILE_TOO_LARGE', 413)
    const name = path.basename(file.name.replaceAll('\\', '/')).slice(0, 240), extension = path.extname(name).toLowerCase()
    const info = inspectVehiclePhoto(file.bytes)
    if (!info || (info.mime === 'image/png' ? extension !== '.png' : !['.jpg', '.jpeg'].includes(extension))) throw new AppError('FILE_TYPE_NOT_ALLOWED', 422)
    const checksum = await this.business.blob(file.bytes)
    const author = beforeCommit ? await beforeCommit() : actor
    let result!: { vehicle: BusinessRecord; attachment: BusinessRecord }
    this.business.store.transaction(() => {
      const current = this.vehicle(vehicleId, version, true)
      const attachment = this.business.write({ kind: 'attachment', vehicleId, data: { name, checksum, size: file.bytes.length, savedAt: new Date().toISOString(), purpose: 'vehiclePhoto', ...info }, actor: author, reason: why, internal: true })
      const vehicle = this.business.write({ id: current.id, kind: 'vehicle', data: current.data, version, actor: author, reason: why, photoAttachmentId: attachment.id })
      result = { vehicle, attachment }
    })
    return result
  }
  remove(vehicleId: string, version: number, reason: unknown, actor: Actor): BusinessRecord {
    const why = normalizeReason(reason)
    if (!Number.isSafeInteger(version) || version < 1) throw new AppError('INVALID_INPUT')
    const current = this.vehicle(vehicleId, version, true)
    return this.business.write({ id: current.id, kind: 'vehicle', data: current.data, version, actor, reason: why, photoAttachmentId: '' })
  }
  private attachment(vehicle: BusinessRecord): BusinessRecord {
    const id = parsePhotoAttachmentId(vehicle.data.photoAttachmentId)
    if (!id) throw new AppError('PHOTO_NOT_FOUND', 404)
    let target: BusinessRecord
    try { target = this.business.get(id) } catch (error) {
      if (error instanceof AppError && ['RECORD_NOT_FOUND', 'VEHICLE_DELETED'].includes(error.code)) throw new AppError('PHOTO_NOT_FOUND', 404)
      throw error
    }
    const filename = String(target.data.name || '').toLowerCase()
    const imageName = target.data.mime === 'image/png' ? filename.endsWith('.png') : target.data.mime === 'image/jpeg' && /\.jpe?g$/.test(filename)
    if (target.kind !== 'attachment' || target.vehicleId !== vehicle.id || target.archived || target.data.purpose !== 'vehiclePhoto' || !imageName) throw new AppError('PHOTO_NOT_FOUND', 404)
    return target
  }
  async read(vehicleId: string, beforeReturn?: () => Promise<void>): Promise<{ bytes: Buffer; mime: string; attachmentId: string }> {
    const original = this.attachment(this.vehicle(vehicleId))
    const bytes = await this.business.readBlob(String(original.data.checksum)), info = inspectVehiclePhoto(bytes)
    if (beforeReturn) await beforeReturn()
    const current = this.attachment(this.vehicle(vehicleId))
    if (current.id !== original.id || current.version !== original.version || !info || info.mime !== current.data.mime || info.width !== current.data.width || info.height !== current.data.height || bytes.length !== current.data.size) throw new AppError('PHOTO_NOT_FOUND', 404)
    return { bytes, mime: info.mime, attachmentId: current.id }
  }
}
