import type { WorkspaceSnapshot } from '../shared/workspace'

type Reader = <T>(url: string) => Promise<T>
type Options = { audit?: boolean; quarantined?: boolean; localFirst?: boolean; localOnly?: boolean; full?: boolean }

/** Per-mounted-workspace cache. Only the newest request may update the UI. */
export class WorkspaceLoader {
  private generation = 0
  private revision: string | null = null
  private active = 0
  get busy() { return this.active > 0 }
  invalidate() { this.generation++; this.revision = null }

  async load(request: Reader, accept: (snapshot: WorkspaceSnapshot) => void, options: Options = {}): Promise<void> {
    const generation = ++this.generation
    this.active++
    const read = async (local: boolean) => {
      const query = new URLSearchParams()
      if (this.revision) query.set('known', this.revision)
      if (options.audit) query.set('audit', '1')
      if (options.quarantined) query.set('quarantined', '1')
      if (local) query.set('local', '1')
      else if (options.full) query.set('full', '1')
      const snapshot = await request<WorkspaceSnapshot>(`/api/business/workspace?${query}`)
      if (generation !== this.generation) return false
      accept(snapshot)
      this.revision = snapshot.revision
      return true
    }
    try {
      if (options.localFirst || options.localOnly) {
        if (!await read(true) || options.localOnly) return
      }
      await read(false)
    } catch (error) {
      if (generation === this.generation) throw error
    } finally { this.active-- }
  }
}
