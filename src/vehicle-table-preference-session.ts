import { defaultVehicleTablePreferences, parseVehicleTablePreferences } from '../shared/vehicle-table'
import type { VehicleTablePreferences } from '../shared/vehicle-table'

export type VehicleTableSaveStatus = 'loading' | 'saving' | 'saved' | 'error'
export type VehicleTablePreferenceState = { layout: VehicleTablePreferences; saveStatus: VehicleTableSaveStatus; error?: string }
type Scope = { request<T>(url: string, options?: { method?: string; body?: unknown; signal?: AbortSignal }): Promise<T> }
const route = '/api/business/vehicle-table-preferences'
const errorCode = (cause: unknown) => cause instanceof Error ? cause.message : 'SERVER_ERROR'

/** One captured workspace scope, one request at a time, latest pending layout wins. */
export class VehicleTablePreferenceSession {
  private readonly controller = new AbortController()
  private state: VehicleTablePreferenceState = { layout: defaultVehicleTablePreferences(), saveStatus: 'loading' }
  private loaded = false
  private loading = false
  private running = false
  private disposed = false
  private committed = ''
  private pending: VehicleTablePreferences | null = null
  private readonly scope: Scope
  private readonly publish: (state: VehicleTablePreferenceState) => void
  constructor(scope: Scope, publish: (state: VehicleTablePreferenceState) => void) { this.scope = scope; this.publish = publish }
  private emit(saveStatus: VehicleTableSaveStatus, error?: string): void {
    if (this.disposed) return
    this.state = { layout: this.state.layout, saveStatus, ...(error ? { error } : {}) }
    this.publish(this.state)
  }
  start(): void { if (!this.loaded && !this.loading && !this.disposed) void this.load() }
  private async load(): Promise<void> {
    this.loading = true; this.emit('loading')
    try {
      const result = await this.scope.request<unknown>(route, { signal: this.controller.signal })
      if (this.disposed) return
      const parsed = parseVehicleTablePreferences(result)
      if (!parsed) throw new Error('SERVER_ERROR')
      this.state = { layout: parsed, saveStatus: 'saved' }; this.loaded = true; this.committed = JSON.stringify(parsed)
      this.emit('saved')
    } catch (cause) { if (!this.disposed) this.emit('error', errorCode(cause)) }
    finally { this.loading = false }
  }
  change(input: VehicleTablePreferences): void {
    if (this.disposed || !this.loaded || this.loading) return
    const parsed = parseVehicleTablePreferences(input)
    if (!parsed) { this.emit('error', 'INVALID_INPUT'); return }
    this.state = { layout: parsed, saveStatus: 'saving' }; this.pending = parsed
    this.emit('saving'); void this.pump()
  }
  retry(): void {
    if (this.disposed || this.loading || this.running) return
    if (!this.loaded) this.start()
    else if (this.pending) void this.pump()
    else this.emit('saved')
  }
  private async pump(): Promise<void> {
    if (this.disposed || this.running || !this.loaded) return
    this.running = true; this.emit('saving')
    try {
      while (this.pending && !this.disposed) {
        const next = this.pending; this.pending = null
        if (JSON.stringify(next) === this.committed) continue
        try {
          const result = await this.scope.request<unknown>(route, { method: 'PUT', body: next, signal: this.controller.signal })
          if (this.disposed) return
          const parsed = parseVehicleTablePreferences(result)
          if (!parsed) throw new Error('SERVER_ERROR')
          this.committed = JSON.stringify(parsed)
        } catch (cause) {
          if (!this.disposed) { this.pending ||= next; this.emit('error', errorCode(cause)) }
          return
        }
      }
      this.emit('saved')
    } finally { this.running = false }
  }
  dispose(): void { this.disposed = true; this.pending = null; this.controller.abort() }
}
