import type { WorkspaceData, WorkspaceSnapshot } from '../shared/workspace'

type Reader = <T>(url: string) => Promise<T>
type Options = { audit?: boolean; quarantined?: boolean; localFirst?: boolean; localOnly?: boolean; full?: boolean }

/** Per-mounted-workspace cache. Only the newest request may update the UI. */
export class WorkspaceLoader {
  private generation = 0
  private revision: string | null = null
  private data: WorkspaceData | null = null
  private active = 0
  get busy() { return this.active > 0 }
  invalidate() { this.generation++; this.revision = null; this.data = null }

  async load(request: Reader, accept: (snapshot: WorkspaceSnapshot) => void, options: Options = {}): Promise<void> {
    const generation = ++this.generation
    this.active++
    const read = async (local: boolean, allowDelta = true): Promise<boolean> => {
      const query = new URLSearchParams()
      if (this.revision && allowDelta) { query.set('known', this.revision); query.set('delta', '1') }
      if (options.audit) query.set('audit', '1')
      if (options.quarantined) query.set('quarantined', '1')
      if (local) query.set('local', '1')
      else if (options.full) query.set('full', '1')
      const snapshot = await request<WorkspaceSnapshot>(`/api/business/workspace?${query}`)
      if (generation !== this.generation) return false
      if (snapshot.patch) {
        if (!allowDelta) throw new Error('SERVER_ERROR')
        if (!this.data || snapshot.patch.baseRevision !== this.revision) return read(local, false)
        const records = new Map(this.data.records.map(record => [record.id, record]))
        for (const id of snapshot.patch.removed) records.delete(id)
        for (const record of snapshot.patch.upsert) records.set(record.id, record)
        this.data = { ...snapshot.patch.data, records: [...records.values()].sort((left, right) => left.updated === right.updated ? (left.id < right.id ? -1 : left.id > right.id ? 1 : 0) : left.updated > right.updated ? -1 : 1) }
      } else if (snapshot.data) this.data = snapshot.data
      accept(snapshot.patch ? { ...snapshot, data: this.data! } : snapshot)
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
