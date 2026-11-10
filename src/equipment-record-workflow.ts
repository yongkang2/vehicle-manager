import type { BusinessRecord, Fields } from '../shared/business'
import { ApiError } from './api'
import type { createWorkspaceScope } from './api'
import { AttachmentUploadQueue } from './attachment-upload-queue'
import type { AttachmentUploadSnapshot } from './attachment-upload-queue'

type Scope = ReturnType<typeof createWorkspaceScope>
type SaveCommand = { url: string; method: string; body: { kind: 'equipment'; vehicleId: string; data: Fields; reason: string; version?: number; requestId: string } }
export type EquipmentEditorSnapshot = Readonly<{
  state: 'editing' | 'saving' | 'unknown' | 'saved' | 'blocked'
  busy: boolean
  savedRecord: BusinessRecord | null
  error?: string
  uploads: AttachmentUploadSnapshot
}>
type Options = {
  scope: Scope
  vehicleId: string
  record: BusinessRecord | null
  onRefresh: (signal: AbortSignal) => Promise<void>
  onBusyChange?: (busy: boolean) => void
  requestId?: () => string
}

// These errors explicitly reject a save. An unrecognized/lost response can
// follow a committed transaction, so its original request must remain frozen.
const rejectedSave = new Set(['INVALID_INPUT', 'INVALID_DATE', 'REASON_REQUIRED', 'EQUIPMENT_TYPE_REQUIRED', 'MAINTENANCE_IN_PROGRESS', 'SHARE_UNAVAILABLE', 'SHARE_ACCESS_DENIED', 'SHARE_BUSY'])
const blockedSave = new Set(['VERSION_CONFLICT', 'PARENT_ARCHIVED', 'RECORD_ARCHIVED', 'VEHICLE_DELETED', 'RECORD_NOT_FOUND', 'NOT_FOUND', 'LOGIN_REQUIRED', 'ACCESS_DISABLED', 'CLIENT_UPGRADE_REQUIRED', 'ADMIN_REQUIRED', 'WORKSPACE_CHANGED', 'WORKSPACE_TOKEN_REQUIRED', 'WORKSPACE_NOT_FOUND', 'NOT_CONFIGURED', 'REQUEST_CANCELLED', 'INVALID_REQUEST', 'EQUIPMENT_REQUEST_MISMATCH', 'CONFIRM_RESUME'])
const errorCode = (cause: unknown) => cause instanceof ApiError ? cause.message : 'SERVER_ERROR'

/** One editor, equipment identity and authenticated workspace for its lifetime. */
export class EquipmentRecordWorkflow {
  readonly queue: AttachmentUploadQueue
  private readonly options: Options
  private snapshot: EquipmentEditorSnapshot
  private readonly listeners = new Set<() => void>()
  private readonly downloads = new Set<AbortController>()
  private command: SaveCommand | null = null
  private controller: AbortController | null = null
  private saving = false
  private disposed = false
  private unsubscribeQueue: () => void

  constructor(options: Options) {
    this.options = options
    this.queue = new AttachmentUploadQueue({
      scope: options.scope,
      vehicleId: options.vehicleId,
      onRefresh: options.onRefresh,
      uploadFile: async (file, signal) => {
        const equipment = this.snapshot.savedRecord
        if (!equipment) throw new ApiError('INVALID_INPUT')
        const body = new FormData()
        body.append('file', file, file.name)
        body.append('reason', this.command!.body.reason)
        const record = await options.scope.request<BusinessRecord>(`/api/business/equipment/${encodeURIComponent(equipment.id)}/attachments`, { method: 'POST', body, signal })
        if (!record || record.kind !== 'attachment' || record.vehicleId !== options.vehicleId || record.data.equipmentId !== equipment.id) throw new ApiError('SERVER_ERROR')
        return { id: record.id }
      },
    })
    this.snapshot = { state: 'editing', busy: false, savedRecord: null, uploads: this.queue.getSnapshot() }
    this.unsubscribeQueue = this.queue.subscribe(() => this.publish())
  }

  getSnapshot = (): EquipmentEditorSnapshot => this.snapshot
  subscribe = (listener: () => void): (() => void) => {
    if (!this.disposed) this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  private publish(update: Partial<EquipmentEditorSnapshot> = {}): void {
    if (this.disposed) return
    const wasBusy = this.snapshot.busy
    this.snapshot = { ...this.snapshot, ...update, uploads: this.queue.getSnapshot(), busy: this.saving || this.queue.getSnapshot().busy }
    for (const listener of this.listeners) listener()
    if (wasBusy !== this.snapshot.busy) this.options.onBusyChange?.(this.snapshot.busy)
  }

  assertCurrent(signal?: AbortSignal): void {
    if (this.disposed) throw new DOMException('Editor closed', 'AbortError')
    this.options.scope.assertCurrent(signal)
  }

  private current(controller: AbortController): boolean {
    if (this.controller !== controller) return false
    try { this.assertCurrent(controller.signal); return true } catch { return false }
  }

  async save(data?: Fields, reason?: string): Promise<void> {
    if (this.disposed || this.snapshot.busy || this.snapshot.state === 'saved' || this.snapshot.state === 'blocked') return
    this.assertCurrent()
    if (this.snapshot.state !== 'unknown') {
      if (!data || typeof reason !== 'string') return
      const record = this.options.record
      this.command = {
        url: `/api/business/records${record ? `/${encodeURIComponent(record.id)}` : ''}`,
        method: record ? 'PUT' : 'POST',
        body: { kind: 'equipment', vehicleId: this.options.vehicleId, data: structuredClone(data), reason, ...(record ? { version: record.version } : {}), requestId: this.options.requestId?.() || crypto.randomUUID() },
      }
    }
    if (!this.command) return
    const controller = new AbortController()
    this.controller = controller
    this.saving = true
    this.publish({ state: 'saving', error: undefined })
    try {
      const record = await this.options.scope.request<BusinessRecord>(this.command.url, { method: this.command.method, body: this.command.body, signal: controller.signal })
      if (!this.current(controller)) return
      if (!record || record.kind !== 'equipment' || record.vehicleId !== this.options.vehicleId || !record.id || this.options.record && record.id !== this.options.record.id) throw new ApiError('SERVER_ERROR')
      this.publish({ state: 'saved', savedRecord: record })
      if (this.queue.getSnapshot().rows.some(row => row.status === 'pending')) await this.queue.run('pending')
      else await this.queue.refresh()
    } catch (cause) {
      if (!this.current(controller)) return
      const code = errorCode(cause)
      // A refresh/queue failure after a known record response must never turn
      // into a new record save or discard the known saved identity.
      if (this.snapshot.savedRecord) this.publish({ state: 'saved', error: code })
      else {
        const blocked = cause instanceof ApiError && blockedSave.has(code)
        const certain = blocked || cause instanceof ApiError && rejectedSave.has(code)
        if (certain) this.command = null
        this.publish({ state: blocked ? 'blocked' : certain ? 'editing' : 'unknown', error: code })
      }
    } finally {
      if (this.controller === controller) {
        this.controller = null
        this.saving = false
        this.publish()
      }
    }
  }

  canFinishCleanly(): boolean {
    return this.snapshot.state === 'saved' && !this.snapshot.busy && !this.snapshot.error && !this.snapshot.uploads.refreshError && this.snapshot.uploads.rows.every(row => row.status === 'uploaded')
  }

  async readAttachment(record: BusinessRecord): Promise<Blob> {
    this.assertCurrent()
    const equipmentId = this.snapshot.savedRecord?.id || this.options.record?.id
    if (!equipmentId || record.kind !== 'attachment' || record.vehicleId !== this.options.vehicleId || record.data.equipmentId !== equipmentId) throw new ApiError('INVALID_INPUT')
    const controller = new AbortController()
    this.downloads.add(controller)
    try {
      const bytes = await this.options.scope.blob(`/api/business/files/${encodeURIComponent(record.id)}`, { signal: controller.signal })
      this.assertCurrent(controller.signal)
      return bytes
    } finally { this.downloads.delete(controller) }
  }

  dispose(): void {
    if (this.disposed) return
    const wasBusy = this.snapshot.busy
    this.disposed = true
    this.controller?.abort()
    this.controller = null
    for (const controller of this.downloads) controller.abort()
    this.downloads.clear()
    this.unsubscribeQueue()
    this.queue.dispose()
    this.listeners.clear()
    if (wasBusy) this.options.onBusyChange?.(false)
  }
}
