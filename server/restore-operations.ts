import { promises as fs } from 'node:fs'
import path from 'node:path'
import { Business, checksum } from './business.js'
import { AppError } from './team.js'
import { createBackup, previewBackup, restoreBackup } from './backup.js'
import type { Actor, RestoreReceipt } from '../shared/business.js'

export const restoreReceipts = (business: Business): RestoreReceipt[] => business.store.get<RestoreReceipt[]>('restoreReceipts') || []
export function saveRestoreReceipt(business: Business, receipt: RestoreReceipt) {
  const receipts = restoreReceipts(business).filter(item => item.requestId !== receipt.requestId)
  business.store.set('restoreReceipts', [receipt, ...receipts])
}
export async function applyRestore(business: Business, request: { requestId: string; bytes: Buffer; teamId: string; actor: Actor; reason: string; archiveRecordIds: string[]; previewFingerprint: string; confirmDroppedFields: boolean }): Promise<RestoreReceipt> {
  if (request.actor.role !== 'admin') throw new AppError('ADMIN_REQUIRED', 403)
  if (!/^[a-f0-9-]{36}$/.test(request.requestId)) throw new AppError('INVALID_INPUT')
  const digest = checksum(JSON.stringify({ backup: checksum(request.bytes), teamId: request.teamId, reason: request.reason, archiveRecordIds: request.archiveRecordIds, previewFingerprint: request.previewFingerprint, confirmDroppedFields: request.confirmDroppedFields }))
  const previous = restoreReceipts(business).find(item => item.requestId === request.requestId)
  if (previous) {
    if (previous.digest !== digest || previous.actorId !== request.actor.id) throw new AppError('RESTORE_REQUEST_CHANGED', 409)
    // A prepared receipt has no committed business transaction. A fresh preview is required.
    if (previous.state === 'prepared' || previous.state === 'failed') throw new AppError('RESTORE_PREVIEW_REQUIRED', 409)
    return previous
  }
  const preview = await previewBackup(business, request.bytes, request.teamId)
  if (preview.fingerprint !== request.previewFingerprint) throw new AppError('RESTORE_PREVIEW_CHANGED', 409)
  if (preview.conflicts.length) throw new AppError('RESTORE_CONFLICTS', 409)
  if (preview.droppedFields.length && !request.confirmDroppedFields) throw new AppError('RESTORE_DROPPED_FIELDS_CONFIRMATION_REQUIRED', 409)
  const receipt: RestoreReceipt = { requestId: request.requestId, digest, actorId: request.actor.id, created: new Date().toISOString(), state: 'prepared' }
  saveRestoreReceipt(business, receipt)
  try {
    const safety = await createBackup(business, request.teamId)
    await previewBackup(business, safety, request.teamId)
    const directory = path.join(business.store.directory, 'restore-backups')
    await fs.mkdir(directory, { recursive: true })
    receipt.safetyFile = `before-restore-${receipt.requestId}.zip`
    receipt.safetySha256 = checksum(safety)
    const file = path.join(directory, receipt.safetyFile)
    await fs.writeFile(file, safety, { flag: 'wx', flush: true })
    if (checksum(await fs.readFile(file)) !== receipt.safetySha256) throw new AppError('LOCAL_BACKUP_FAILED', 503)
    saveRestoreReceipt(business, receipt)
    await restoreBackup(business, request.bytes, request.teamId, request.actor, request.reason, request.archiveRecordIds, { committed: result => saveRestoreReceipt(business, { ...receipt, state: 'applied', result }) })
    return restoreReceipts(business).find(item => item.requestId === receipt.requestId)!
  } catch (error) {
    saveRestoreReceipt(business, { ...receipt, state: 'failed', error: error instanceof AppError ? error.code : 'LOCAL_BACKUP_FAILED' })
    throw error
  }
}
