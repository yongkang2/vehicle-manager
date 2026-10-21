import { ZipArchive } from 'archiver'
import unzipper from 'unzipper'
import { AppError } from './team.js'
import { Business, checksum, normalizeFields } from './business.js'
import type { Actor, BusinessRecord, Change, Operation } from '../shared/business.js'
import type { TeamDocument } from '../shared/types.js'

type Manifest = { application: 'stellantis-vehicle-manager'; format: 1; teamId: string; created: string; records: BusinessRecord[]; changes: Change[]; pendingOperations: Operation[]; team?: TeamDocument }

export async function createBackup(business: Business, teamId: string, team?: TeamDocument): Promise<Buffer> {
  const manifest: Manifest = {
    application: 'stellantis-vehicle-manager', format: 1, teamId, created: new Date().toISOString(), records: business.list(),
    changes: business.store.db.prepare('SELECT payload FROM changes ORDER BY created,id').all().map(row => JSON.parse(row.payload as string)),
    pendingOperations: business.store.db.prepare("SELECT payload FROM outbox WHERE state='pending' ORDER BY seq").all().map(row => JSON.parse(row.payload as string)), team,
  }
  const archive = new ZipArchive({ zlib: { level: 6 } }), chunks: Buffer[] = []
  let size = 0
  const completed = new Promise<Buffer>((resolve, reject) => {
    archive.on('data', (chunk: Buffer) => { size += chunk.length; if (size > 200 * 1024 * 1024) { archive.abort(); reject(new AppError('BACKUP_TOO_LARGE', 413)) } else chunks.push(chunk) })
    archive.once('error', reject); archive.once('end', () => resolve(Buffer.concat(chunks)))
  })
  try {
    archive.append(JSON.stringify(manifest), { name: 'manifest.json' })
    const keys = new Set(manifest.records.filter(record => ['report', 'attachment'].includes(record.kind)).map(record => String(record.data.checksum)))
    for (const key of keys) archive.append(await business.readBlob(key), { name: `blobs/${key}` })
    void archive.finalize()
    return await completed
  } catch (error) { archive.abort(); throw error }
}

export async function restoreBackup(business: Business, bytes: Buffer, teamId: string, actor: Actor, reason: string): Promise<number> {
  if (actor.role !== 'admin') throw new AppError('ADMIN_REQUIRED', 403)
  const zip = await unzipper.Open.buffer(bytes).catch(() => { throw new AppError('INVALID_BACKUP', 422) })
  if (zip.files.length > 20000 || zip.files.reduce((sum, entry) => sum + entry.uncompressedSize, 0) > 200 * 1024 * 1024) throw new AppError('BACKUP_TOO_LARGE', 413)
  const files = new Map<string, Buffer>()
  let totalLength = 0
  for (const file of zip.files) {
    if (file.type === 'Directory') continue
    if (files.has(file.path) || (file.path !== 'manifest.json' && !/^blobs\/[a-f0-9]{64}$/.test(file.path))) throw new AppError('INVALID_BACKUP', 422)
    const chunks: Buffer[] = []; let length = 0
    const limit = file.path === 'manifest.json' ? 20 * 1024 * 1024 : 10 * 1024 * 1024
    for await (const chunk of file.stream()) {
      length += chunk.length
      totalLength += chunk.length
      if (length > limit || totalLength > 200 * 1024 * 1024) throw new AppError('BACKUP_TOO_LARGE', 413)
      chunks.push(Buffer.from(chunk))
    }
    files.set(file.path, Buffer.concat(chunks))
  }
  let manifest: Manifest
  try { manifest = JSON.parse(files.get('manifest.json')!.toString()) as Manifest } catch { throw new AppError('INVALID_BACKUP', 422) }
  if (manifest.application !== 'stellantis-vehicle-manager' || manifest.format !== 1 || manifest.teamId !== teamId || !Array.isArray(manifest.records) || manifest.records.length > 20000 || !Array.isArray(manifest.changes) || manifest.changes.length > 200000) throw new AppError('INVALID_BACKUP', 422)
  const ids = new Set<string>()
  for (const record of manifest.records) {
    if (typeof record.id !== 'string' || record.id.length > 120 || ids.has(record.id) || typeof record.archived !== 'boolean' || !record.data || typeof record.data !== 'object') throw new AppError('INVALID_BACKUP', 422)
    ids.add(record.id)
    if (['vehicle', 'part', 'modification', 'equipment'].includes(record.kind)) record.data = normalizeFields(record.kind, record.data)
    else if (record.kind === 'report' || record.kind === 'attachment') {
      const file = files.get(`blobs/${record.data.checksum}`)
      if (!file || checksum(file) !== record.data.checksum || file.length !== record.data.size || (record.kind === 'report' && (!record.data.parsed || !Array.isArray((record.data.parsed as { controllers?: unknown }).controllers) || !Array.isArray((record.data.parsed as { faults?: unknown }).faults)))) throw new AppError('INVALID_BACKUP', 422)
      await business.blob(file)
    } else throw new AppError('INVALID_BACKUP', 422)
  }
  for (const record of manifest.records) if ((record.kind !== 'vehicle' && (!record.vehicleId || !ids.has(record.vehicleId))) || (record.kind === 'vehicle' && record.vehicleId)) throw new AppError('INVALID_BACKUP', 422)
  if (business.store.db.prepare("SELECT id FROM outbox WHERE state='pending' LIMIT 1").get()) throw new AppError('PENDING_BEFORE_RESTORE', 409)
  const ordered = manifest.records.toSorted((left, right) => Number(right.kind === 'vehicle') - Number(left.kind === 'vehicle'))
  let changed = 0
  business.store.transaction(() => {
    const previousSequence = business.store.db.prepare('SELECT COALESCE(MAX(seq),0) AS seq FROM outbox').get()!.seq as number
    for (const record of ordered) {
      const exists = business.store.db.prepare('SELECT id FROM records WHERE id=?').get(record.id)
      const current = exists ? business.get(record.id) : null
      const targetArchived = record.kind === 'vehicle' ? false : record.archived
      if (current && JSON.stringify(current.data) === JSON.stringify(record.data) && current.archived === targetArchived) continue
      if (record.kind !== 'vehicle') {
        const parent = business.get(record.vehicleId!)
        if (parent.archived && !record.archived) throw new AppError('INVALID_BACKUP', 422)
      }
      business.write({ id: record.id, kind: record.kind, vehicleId: record.vehicleId, data: record.data, version: current?.version, archived: targetArchived, actor, reason: `Restore: ${reason}`, internal: ['report', 'attachment'].includes(record.kind), maintenance: 'restore' })
      changed++
    }
    const extras = business.list().filter(record => !ids.has(record.id) && !record.archived).sort((left, right) => Number(left.kind === 'vehicle') - Number(right.kind === 'vehicle'))
    for (const record of extras) { business.write({ id: record.id, kind: record.kind, vehicleId: record.vehicleId, data: record.data, version: record.version, archived: true, actor, reason: `Restore archive: ${reason}`, internal: ['report', 'attachment'].includes(record.kind), maintenance: 'restore' }); changed++ }
    for (const record of ordered.filter(record => record.kind === 'vehicle' && record.archived)) {
      const current = business.get(record.id)
      business.write({ id: current.id, kind: 'vehicle', data: current.data, version: current.version, archived: true, actor, reason: `Restore archive state: ${reason}`, maintenance: 'restore' }); changed++
    }
    const historical = manifest.changes.filter(change => typeof change.id === 'string' && ids.has(change.recordId) && typeof change.vehicleId === 'string' && typeof change.created === 'string')
    for (const change of historical) business.store.db.prepare('INSERT OR IGNORE INTO changes VALUES(?,?,?,?,?)').run(change.id, change.recordId, change.vehicleId, JSON.stringify(change), change.created)
    const first = business.store.db.prepare('SELECT id,payload FROM outbox WHERE seq>? ORDER BY seq LIMIT 1').get(previousSequence)
    if (first) {
      const operation = JSON.parse(first.payload as string) as Operation
      operation.changes.push(...historical.filter(change => !operation.changes.some(existing => existing.id === change.id)))
      business.store.db.prepare('UPDATE outbox SET payload=? WHERE id=?').run(JSON.stringify(operation), first.id)
    }
    business.store.event(actor.id, 'backup.restored', { reason, changed, teamId })
  })
  return changed
}