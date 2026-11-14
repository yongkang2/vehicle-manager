import { checksum } from './business.js'
import type { WorkspaceData, WorkspaceSnapshot } from '../shared/workspace.js'

type CachedSnapshot = { revision: string; data: WorkspaceData; records: Map<string, string> }

export class WorkspaceSnapshots {
  private readonly scopes = new Map<string, { stamp: string | null; snapshots: CachedSnapshot[] }>()

  read(scope: string, stamp: string | null, build: () => WorkspaceData, known?: string, delta = false): Pick<WorkspaceSnapshot, 'revision' | 'data' | 'patch'> {
    let cached = this.scopes.get(scope)
    if (!cached) { cached = { stamp: null, snapshots: [] }; this.scopes.set(scope, cached) }
    if (stamp === null || cached.stamp !== stamp || !cached.snapshots.length) {
      const data = build(), revision = checksum(JSON.stringify(data))
      if (cached.snapshots[0]?.revision !== revision) {
        cached.snapshots.unshift({ revision, data, records: new Map(data.records.map(record => [record.id, JSON.stringify(record)])) })
        cached.snapshots.length = Math.min(cached.snapshots.length, 2)
      }
      cached.stamp = stamp
    }
    const current = cached.snapshots[0]
    if (known === current.revision) return { revision: current.revision }
    const previous = delta && known ? cached.snapshots.find(snapshot => snapshot.revision === known) : undefined
    if (!previous) return { revision: current.revision, data: current.data }
    const { records, ...data } = current.data
    const upsert = records.filter(record => previous.records.get(record.id) !== current.records.get(record.id))
    const removed = [...previous.records.keys()].filter(id => !current.records.has(id))
    const patch = { baseRevision: previous.revision, upsert, removed, data }
    return Buffer.byteLength(JSON.stringify(patch)) < Buffer.byteLength(JSON.stringify(current.data)) ? { revision: current.revision, patch } : { revision: current.revision, data: current.data }
  }
}