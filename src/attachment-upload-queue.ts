import type { BusinessRecord } from '../shared/business'
import { ATTACHMENT_BATCH_LIMIT, attachmentFileError } from '../shared/attachments'
import { ApiError } from './api'
import type { createWorkspaceScope } from './api'

export type AttachmentUploadStatus = 'pending' | 'invalid' | 'uploading' | 'uploaded' | 'failed' | 'unknown'
export type AttachmentUploadRow = Readonly<{ id: string; file: File; status: AttachmentUploadStatus; error?: string; savedId?: string }>
export type AttachmentUploadSnapshot = Readonly<{
  rows: readonly AttachmentUploadRow[]
  busy: boolean
  limited: boolean
  inspectionRequired: boolean
  refreshError?: string
}>
type Options = {
  scope: ReturnType<typeof createWorkspaceScope>
  vehicleId: string
  onRefresh: (signal: AbortSignal) => Promise<void>
  onBusyChange?: (busy: boolean) => void
}

// Only explicit rejection codes are safe to retry: a lost response can follow a save.
const rejected = new Set(['FILE_TYPE_NOT_ALLOWED', 'FILE_TOO_LARGE', 'FILE_REQUIRED', 'INVALID_INPUT', 'FILE_CORRUPTED', 'MAINTENANCE_IN_PROGRESS', 'SHARE_UNAVAILABLE', 'SHARE_ACCESS_DENIED', 'SHARE_BUSY'])
const fatal = new Set(['LOGIN_REQUIRED', 'ACCESS_DISABLED', 'ADMIN_REQUIRED', 'WORKSPACE_CHANGED', 'WORKSPACE_TOKEN_REQUIRED', 'WORKSPACE_NOT_FOUND', 'NOT_CONFIGURED', 'PARENT_ARCHIVED', 'RECORD_ARCHIVED', 'VEHICLE_DELETED', 'RECORD_NOT_FOUND', 'NOT_FOUND'])
const errorCode = (cause: unknown) => cause instanceof ApiError ? cause.message : 'SERVER_ERROR'

/** A queue belongs to one vehicle and one authenticated workspace for its lifetime. */
export class AttachmentUploadQueue {
  private readonly options: Options
  private snapshot: AttachmentUploadSnapshot = { rows: [], busy: false, limited: false, inspectionRequired: false }
  private readonly listeners = new Set<() => void>()
  private controller: AbortController | null = null
  private disposed = false
  private nextId = 0

  constructor(options: Options) { this.options = options }

  getSnapshot = (): AttachmentUploadSnapshot => this.snapshot
  subscribe = (listener: () => void): (() => void) => {
    if (!this.disposed) this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  private publish(update: Partial<AttachmentUploadSnapshot>): void {
    if (this.disposed) return
    this.snapshot = { ...this.snapshot, ...update }
    for (const listener of this.listeners) listener()
  }

  private current(controller: AbortController): boolean {
    if (this.disposed || this.controller !== controller || controller.signal.aborted) return false
    try { this.options.scope.assertCurrent(controller.signal); return true } catch { return false }
  }

  private updateRow(id: string, update: Partial<AttachmentUploadRow>): void {
    this.publish({ rows: this.snapshot.rows.map(row => row.id === id ? { ...row, ...update } : row) })
  }

  add(files: File[]): void {
    if (this.disposed || this.snapshot.busy || this.snapshot.inspectionRequired || !files.length) return
    const available = ATTACHMENT_BATCH_LIMIT - this.snapshot.rows.length
    const rows = files.slice(0, available).map(file => {
      const error = attachmentFileError(file)
      return { id: String(++this.nextId), file, status: error ? 'invalid' as const : 'pending' as const, ...(error ? { error } : {}) }
    })
    this.publish({ rows: [...this.snapshot.rows, ...rows], limited: files.length > available })
  }

  remove(id: string): void {
    if (this.disposed || this.snapshot.busy || this.snapshot.inspectionRequired && this.snapshot.rows.some(row => row.id === id && row.status === 'unknown')) return
    this.publish({ rows: this.snapshot.rows.filter(row => row.id !== id), limited: false })
  }

  clear(): void {
    if (this.disposed || this.snapshot.busy || this.snapshot.inspectionRequired) return
    this.publish({ rows: [], limited: false, inspectionRequired: false, refreshError: undefined })
  }

  private begin(): AbortController | null {
    if (this.disposed || this.snapshot.busy) return null
    try { this.options.scope.assertCurrent() } catch { return null }
    const controller = new AbortController()
    this.controller = controller
    this.publish({ busy: true })
    this.options.onBusyChange?.(true)
    return controller
  }

  private finish(controller: AbortController): void {
    if (this.controller !== controller) return
    this.controller = null
    if (!this.disposed) {
      this.publish({ busy: false })
      this.options.onBusyChange?.(false)
    }
  }

  private async reload(controller: AbortController, inspected: boolean): Promise<void> {
    if (!this.current(controller)) return
    try {
      await this.options.onRefresh(controller.signal)
      if (this.current(controller)) this.publish({ refreshError: undefined, ...(inspected ? { inspectionRequired: false } : {}) })
    } catch (cause) {
      if (this.current(controller)) this.publish({ refreshError: errorCode(cause) })
    }
  }

  async run(mode: 'pending' | 'failed'): Promise<void> {
    const targets = this.snapshot.rows.filter(row => row.status === mode)
    if (!targets.length) return
    const controller = this.begin()
    if (!controller) return
    try {
      for (const row of targets) {
        if (!this.current(controller)) break
        this.updateRow(row.id, { status: 'uploading', error: undefined })
        try {
          const body = new FormData()
          body.append('file', row.file, row.file.name)
          const record = await this.options.scope.request<BusinessRecord>(`/api/business/vehicles/${encodeURIComponent(this.options.vehicleId)}/attachments`, { method: 'POST', body, signal: controller.signal })
          if (!this.current(controller)) break
          if (!record || typeof record.id !== 'string' || !record.id || record.kind !== 'attachment' || record.vehicleId !== this.options.vehicleId) throw new ApiError('SERVER_ERROR')
          this.updateRow(row.id, { status: 'uploaded', savedId: record.id, error: undefined })
        } catch (cause) {
          if (!this.current(controller)) break
          const code = errorCode(cause), certain = cause instanceof ApiError && (rejected.has(code) || fatal.has(code))
          this.updateRow(row.id, { status: certain ? 'failed' : 'unknown', error: code })
          if (!certain) this.publish({ inspectionRequired: true })
          if (fatal.has(code)) break
        }
      }
      await this.reload(controller, false)
    } finally { this.finish(controller) }
  }

  async refresh(): Promise<void> {
    const controller = this.begin()
    if (!controller) return
    try { await this.reload(controller, true) } finally { this.finish(controller) }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.controller?.abort()
    this.controller = null
    this.listeners.clear()
    if (this.snapshot.busy) this.options.onBusyChange?.(false)
    this.snapshot = { ...this.snapshot, busy: false }
  }
}
