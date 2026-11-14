import { randomUUID } from 'node:crypto'
import { ZipArchive } from 'archiver'
import { Business, reason } from './business.js'
import { AppError, TeamDirectory } from './team.js'
import { BusinessSync, atomicFile } from './sync.js'
import { SharedBusinessSnapshot } from './deletions.js'
import { restoreReceipts, saveRestoreReceipt } from './restore-operations.js'
import { collectModificationImportFileKeys } from '../shared/modifications.js'
import type { AbandonedModificationImport, ModificationImport } from '../shared/modifications.js'
import type { ModificationContext } from './modifications.js'
import type { Change, RestoredHistoryImport } from '../shared/business.js'

export function pendingModificationRestores(business: Business, requestId: string): ModificationImport[] {
  return (business.store.get<ModificationImport[]>('pendingModificationImports') || []).filter(entry => entry.restoreRequestId === requestId)
}
export async function exportModificationRestore(business: Business, requestId: string): Promise<Buffer> {
  const entries = pendingModificationRestores(business, requestId)
  const retained = (business.store.get<AbandonedModificationImport[]>('abandonedModificationImports') || []).filter(entry => entry.import.restoreRequestId === requestId)
  if (!entries.length && !retained.length) throw new AppError('RESTORE_PREVIEW_REQUIRED', 409)
  const imports = [...entries, ...retained.map(entry => entry.import)], keys = new Set(imports.flatMap(collectModificationImportFileKeys))
  const archive = new ZipArchive(), chunks: Buffer[] = []
  const completed = new Promise<Buffer>((resolve, reject) => { archive.on('data', chunk => chunks.push(Buffer.from(chunk))); archive.once('error', reject); archive.once('end', () => resolve(Buffer.concat(chunks))) })
  const manifest = Buffer.from(JSON.stringify({ kind: 'retained-modification-restore', requestId, entries, retained }, null, 2))
  let total = manifest.length
  if (total > 20 * 1024 * 1024) throw new AppError('BACKUP_TOO_LARGE', 413)
  archive.append(manifest, { name: 'retained-restore.json' })
  for (const key of keys) {
    const bytes = await business.readBlob(key); total += bytes.length
    if (total > 200 * 1024 * 1024) throw new AppError('BACKUP_TOO_LARGE', 413)
    archive.append(bytes, { name: `blobs/${key}` })
  }
  void archive.finalize(); return completed
}
/** Preserve a failed desired overlay before refreshing canonical shared records; never rewrite shared HEAD. */
export async function abandonModificationRestore(business: Business, synchronization: BusinessSync, teams: TeamDirectory, context: ModificationContext, requestId: string, explanation: unknown) {
  const why = reason(explanation), store = business.store
  context.assertCurrent?.(); context.assertLinked?.()
  if (context.syncEnabled === false) throw new AppError('CONFIRM_RESUME', 409)
  return store.withMaintenance(() => teams.withAccess(context.directory, context.teamId, context.identity, true, async (_team, member) => {
    context.assertCurrent?.(); context.assertLinked?.()
    const receipt = restoreReceipts(business).find(entry => entry.requestId === requestId)
    const entries = pendingModificationRestores(business, requestId)
    if (!receipt || !entries.length) throw new AppError('RESTORE_PREVIEW_REQUIRED', 409)
    const snapshot = await SharedBusinessSnapshot.open(business, context.directory, context.teamId, atomicFile)
    try {
      const retained = store.get<AbandonedModificationImport[]>('abandonedModificationImports') || []
      const actor = { id: member.id, name: member.name, role: member.role, deviceId: context.identity.deviceId }
      for (const entry of entries) if (!retained.some(saved => saved.import.id === entry.id)) retained.push({ id: randomUUID(), abandonedAt: new Date().toISOString(), actor, reason: why, import: structuredClone(entry) })
      store.set('abandonedModificationImports', retained)
      if (!await synchronization.ingestLocked(snapshot)) throw new AppError('LOCAL_REFRESH_REQUIRED', 503)
      context.assertCurrent?.(); context.assertLinked?.()
      store.transaction(() => {
        const abandonedChanges = new Set(entries.flatMap(entry => (entry.forwardChanges || []).map(change => change.id)))
        const historyImports = (store.get<RestoredHistoryImport[]>('pendingHistoryImports') || []).map(entry => ({ ...entry, changes: entry.changes.filter(change => !abandonedChanges.has(change.id)) })).filter(entry => entry.changes.length)
        store.set('pendingHistoryImports', historyImports)
        for (const id of abandonedChanges) {
          const row = store.db.prepare('SELECT payload FROM changes WHERE id=?').get(id)
          if (row) { const change = JSON.parse(String(row.payload)) as Change; store.db.prepare('UPDATE changes SET payload=? WHERE id=?').run(JSON.stringify({ ...change, action: 'modification.restoreRetained' }), id) }
        }
        const pending = new Set(store.db.prepare("SELECT record_id FROM outbox WHERE state='pending'").all().map(row => String(row.record_id)))
        for (const record of entries.flatMap(entry => entry.records).toSorted((left, right) => Number(left.kind === 'modificationGroup') - Number(right.kind === 'modificationGroup'))) {
          if (pending.has(record.id) || snapshot.db.prepare('SELECT id FROM records WHERE id=?').get(record.id)) continue
          const referenced = record.kind === 'modificationGroup' && store.db.prepare("SELECT data FROM records WHERE kind='modification'").all().some(row => JSON.parse(String(row.data)).groupId === record.id)
          if (!referenced) store.db.prepare('DELETE FROM records WHERE id=?').run(record.id)
        }
        store.set('pendingModificationImports', (store.get<ModificationImport[]>('pendingModificationImports') || []).filter(entry => !entries.some(discarded => discarded.id === entry.id)))
        saveRestoreReceipt(business, { ...receipt, state: 'failed', error: 'MODIFICATION_RESTORE_REVIEW_REQUIRED' })
        store.event(actor, 'backup.modification-restore-retained', { requestId, reason: why, imports: entries.map(entry => entry.id) })
      })
      return { retained: entries.length, pending: synchronization.status().pending, needsNewPreview: true }
    } finally { await snapshot.close() }
  }))
}
