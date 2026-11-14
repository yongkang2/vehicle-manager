import { Business, reason } from './business.js'
import { AppError } from './team.js'
import type { Actor, BusinessRecord } from '../shared/business.js'

type ReportCommentSave = { id: string; comment: unknown; version: unknown; reason: unknown }

/** Only the shared annotation is editable; retained DOVE observations stay intact. */
export class ReportComments {
  constructor(readonly business: Business) {}

  save(input: ReportCommentSave, actor: Actor): BusinessRecord {
    if (typeof input.id !== 'string' || !input.id || input.id.length > 200 || typeof input.comment !== 'string' || input.comment.length > 4000 || typeof input.version !== 'number' || !Number.isSafeInteger(input.version) || input.version < 1) throw new AppError('INVALID_INPUT')
    const comment = input.comment.trim(), explanation = reason(input.reason), version = input.version
    const store = this.business.store
    store.assertWritable()
    let result!: BusinessRecord
    store.transaction(() => {
      store.assertWritable()
      const current = this.business.get(input.id)
      if (current.kind !== 'report') throw new AppError('INVALID_INPUT')
      if (current.version !== version) throw new AppError('VERSION_CONFLICT', 409)
      if (current.archived) throw new AppError('RECORD_ARCHIVED', 409)
      if (!current.vehicleId) throw new AppError('INVALID_INPUT')
      const parent = this.business.get(current.vehicleId)
      if (parent.kind !== 'vehicle' || parent.archived) throw new AppError('PARENT_ARCHIVED', 409)
      const previous = typeof current.data.comment === 'string' ? current.data.comment.trim() : current.data.comment === undefined ? '' : current.data.comment
      if (previous === comment) { result = current; return }
      result = this.business.write({ id: current.id, kind: 'report', vehicleId: current.vehicleId, data: { ...current.data, comment }, version, actor, reason: explanation, internal: true })
    })
    return result
  }
}
