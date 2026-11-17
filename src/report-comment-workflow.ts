import type { BusinessRecord, ReportCommentRequest } from '../shared/business'
import { ApiError } from './api'
import type { createWorkspaceScope } from './api'

type Scope = ReturnType<typeof createWorkspaceScope>
export const reportComment = (record: BusinessRecord): string => typeof record.data.comment === 'string' ? record.data.comment : ''
export type ReportCommentSnapshot = Readonly<{
  state: 'editing' | 'saving' | 'blocked' | 'inspecting' | 'review' | 'saved'
  busy: boolean
  record: BusinessRecord
  inspected: BusinessRecord | null
  inspectable: boolean
  error?: string
  refreshFailed: boolean
}>
type Options = {
  record: BusinessRecord
  scope: Scope
  onSaved: (record: BusinessRecord, scope: Scope, signal: AbortSignal) => Promise<void>
  onInspected: (record: BusinessRecord, scope: Scope, signal: AbortSignal) => void
  onBusyChange: (busy: boolean) => void
}
const invalidInput = new Set(['INVALID_INPUT', 'REASON_REQUIRED'])
const cannotInspect = new Set(['LOGIN_REQUIRED', 'ACCESS_DISABLED', 'WORKSPACE_CHANGED', 'WORKSPACE_TOKEN_REQUIRED', 'WORKSPACE_NOT_FOUND', 'NOT_CONFIGURED', 'RECORD_NOT_FOUND', 'VEHICLE_DELETED', 'RECORD_ARCHIVED', 'PARENT_ARCHIVED', 'CLIENT_UPGRADE_REQUIRED', 'REQUEST_CANCELLED'])
const code = (cause: unknown): string => cause instanceof ApiError ? cause.message : 'SERVER_ERROR'

/** A comment edit belongs to one report and authenticated workspace until closed. */
export class ReportCommentWorkflow {
  private readonly options: Options
  private snapshot: ReportCommentSnapshot
  private readonly listeners = new Set<() => void>()
  private controller: AbortController | null = null
  private disposed = false

  constructor(options: Options) {
    this.options = options
    this.snapshot = { state: 'editing', busy: false, record: options.record, inspected: null, inspectable: false, refreshFailed: false }
  }
  getSnapshot = (): ReportCommentSnapshot => this.snapshot
  subscribe = (listener: () => void): (() => void) => { if (!this.disposed) this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  get active(): boolean { return !this.disposed }
  private publish(update: Partial<ReportCommentSnapshot>): void {
    if (this.disposed) return
    const wasBusy = this.snapshot.busy
    this.snapshot = { ...this.snapshot, ...update }
    for (const listener of this.listeners) listener()
    if (wasBusy !== this.snapshot.busy) this.options.onBusyChange(this.snapshot.busy)
  }
  private current(controller: AbortController): boolean { return !this.disposed && this.controller === controller && !controller.signal.aborted }
  private validate(record: BusinessRecord): void {
    if (!record || record.id !== this.options.record.id || record.kind !== 'report' || record.vehicleId !== this.options.record.vehicleId || !record.data || !Number.isSafeInteger(record.version) || record.version < 1) throw new ApiError('SERVER_ERROR')
  }
  private finish(controller: AbortController): void {
    if (this.controller !== controller) return
    this.controller = null
    this.publish({ busy: false })
  }
  async save(comment: string, reason: string): Promise<void> {
    if (this.disposed || this.snapshot.busy || this.snapshot.state !== 'editing' || this.snapshot.record.archived) return
    const controller = new AbortController(), record = this.snapshot.record
    this.controller = controller
    this.publish({ state: 'saving', busy: true, error: undefined })
    let saved: BusinessRecord
    try {
      const body: ReportCommentRequest = { comment, version: record.version, reason }
      saved = await this.options.scope.request<BusinessRecord>(`/api/business/reports/${encodeURIComponent(record.id)}/comment`, { method: 'PUT', body, signal: controller.signal })
      this.options.scope.assertCurrent(controller.signal)
      if (!this.current(controller)) return
      this.validate(saved)
      if (saved.version < record.version) throw new ApiError('SERVER_ERROR')
    } catch (cause) {
      if (this.current(controller)) {
        const error = code(cause)
        this.publish({ state: invalidInput.has(error) ? 'editing' : 'blocked', error, inspectable: !cannotInspect.has(error) && !invalidInput.has(error) })
      }
      this.finish(controller)
      throw cause
    }
    this.publish({ state: 'saved', record: saved, inspected: null, inspectable: false })
    try {
      // The caller upserts the confirmed response before refreshing other data.
      await this.options.onSaved(saved, this.options.scope, controller.signal)
      this.options.scope.assertCurrent(controller.signal)
    } catch (cause) {
      if (this.current(controller)) this.publish({ state: 'saved', refreshFailed: true, error: code(cause) })
      throw cause
    } finally { this.finish(controller) }
  }
  async inspect(): Promise<void> {
    if (this.disposed || this.snapshot.busy || !this.snapshot.inspectable) return
    const controller = new AbortController()
    this.controller = controller
    this.publish({ state: 'inspecting', busy: true })
    try {
      const records = await this.options.scope.request<BusinessRecord[]>(`/api/business/records?kind=report&vehicleId=${encodeURIComponent(this.options.record.vehicleId || '')}`, { signal: controller.signal })
      this.options.scope.assertCurrent(controller.signal)
      if (!this.current(controller)) return
      const record = Array.isArray(records) && records.find(row => row.id === this.options.record.id)
      if (!record) throw new ApiError('RECORD_NOT_FOUND')
      this.validate(record)
      this.options.onInspected(record, this.options.scope, controller.signal)
      this.options.scope.assertCurrent(controller.signal)
      if (!this.current(controller)) return
      this.publish({ state: 'review', inspected: record, error: undefined })
    } catch (cause) {
      if (this.current(controller)) this.publish({ state: 'blocked', error: code(cause), inspectable: !cannotInspect.has(code(cause)) })
      throw cause
    } finally { this.finish(controller) }
  }
  acceptInspection(): void {
    if (this.disposed || this.snapshot.busy || this.snapshot.state !== 'review' || !this.snapshot.inspected) return
    this.publish({ state: 'editing', record: this.snapshot.inspected, inspected: null, inspectable: false, error: undefined })
  }
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.controller?.abort(); this.controller = null
    this.listeners.clear()
    if (this.snapshot.busy) this.options.onBusyChange(false)
  }
}
