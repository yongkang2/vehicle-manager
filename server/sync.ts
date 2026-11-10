import { DatabaseSync } from 'node:sqlite'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { randomBytes, randomUUID } from 'node:crypto'
import { Business, checksum, fromRow, now, reason, validateEquipmentAttachmentRecords } from './business.js'
import { assertConfigurationProtocol, SharedBusinessSnapshot, validateVehicleDeletion } from './deletions.js'
import type { BusinessHead } from './deletions.js'
import type { RecordRow } from './business.js'
import { AppError, TeamDirectory, assertTeamLock } from './team.js'
import type { Identity, TeamDocument } from '../shared/types.js'
import type { Actor, BusinessRecord, Change, Fields, Operation, RecordKind, RestoredHistoryImport, SyncConflict, SyncStatus, VehicleDeletion, VehicleDeletePreview, VehicleDeleteRequest, VehicleDeleteReceipt } from '../shared/business.js'
import { componentTypeDefinitions, isProtectedKind, validateConfigurationRecords, validateConfigurationRevisionRecord, validateComponentTypeRecord, validateConfigurationReceiptEntry } from '../shared/configuration-revisions.js'
import type { ConfigurationImport } from '../shared/configuration-revisions.js'
import { collectChangeFileKeys, collectRecordFileKeys, hasEnhancedModificationText, modificationFiles, validateModificationRecords, validateModificationReceiptEntry } from '../shared/modifications.js'
import type { ModificationImport } from '../shared/modifications.js'
import { configurationFeatureFlags } from '../shared/business-features.js'
import { parseEquipmentAttachmentId } from '../shared/equipment-attachments.js'

const changeHasEnhancedModificationText = (change: Change): boolean => ['modification', 'modificationGroup'].includes(change.kind) && [change.before, change.after].some(data => data && hasEnhancedModificationText(data))
const operationHasEnhancedModificationText = (operation: Operation): boolean => hasEnhancedModificationText(operation.desired.data) || Boolean(operation.base && hasEnhancedModificationText(operation.base.data)) || operation.changes.some(changeHasEnhancedModificationText)
const equivalent = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right)
const fieldKeys = (base: Fields, desired: Fields) => new Set([...Object.keys(base), ...Object.keys(desired)])
// Legacy records omit these values; materializing a blank is not a change.
const blankEquivalentFields = (kind: RecordKind): readonly string[] => kind === 'vehicle' ? ['physicalLocation', 'photoAttachmentId', 'complianceLevel'] : kind === 'part' ? ['controllerType', 'lifeStatus', 'componentTypeId'] : kind === 'modification' ? ['requestor', 'lead'] : kind === 'equipment' ? ['equipmentType'] : kind === 'attachment' ? ['equipmentId'] : []
const equivalentField = (kind: RecordKind, field: string, left: unknown, right: unknown) => blankEquivalentFields(kind).includes(field)
  ? equivalent(left === undefined ? '' : left, right === undefined ? '' : right)
  : equivalent(left, right)
function equivalentData(kind: RecordKind, left: Fields, right: Fields): boolean {
  const blanks = blankEquivalentFields(kind)
  if (!blanks.length) return equivalent(left, right)
  const leftFields = Object.fromEntries(Object.entries(left).filter(([field]) => !blanks.includes(field)))
  const rightFields = Object.fromEntries(Object.entries(right).filter(([field]) => !blanks.includes(field)))
  return equivalent(leftFields, rightFields) && blanks.every(field => equivalentField(kind, field, left[field], right[field]))
}
const stateOf = (row: RecordRow | undefined) => row ? { data: JSON.parse(row.data) as Fields, archived: Boolean(row.archived) } : null
const hashKey = (key: string) => /^[a-f0-9]{64}$/.test(key)
const kinds = "CASE kind WHEN 'vehicle' THEN 0 WHEN 'modificationGroup' THEN 1 WHEN 'part' THEN 2 WHEN 'equipment' THEN 3 WHEN 'attachment' THEN 5 ELSE 4 END"
type PreviewState = { vehicleId: string; actorKey: string; graph: string; version: number; vin: string; expires: number }

export async function atomicFile(destination: string, bytes: Buffer | string, beforeRename?: () => void): Promise<void> {
  await assertTeamLock()
  const temporary = `${destination}.${randomUUID()}.tmp`
  try {
    const handle = await fs.open(temporary, 'wx')
    try { await handle.writeFile(bytes); await handle.sync() } finally { await handle.close() }
    await assertTeamLock()
    beforeRename?.()
    await fs.rename(temporary, destination)
  } finally { await fs.rm(temporary, { force: true }).catch(() => {}) }
}
async function optionalRead(filename: string): Promise<Buffer | null> {
  return fs.readFile(filename).catch(error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error })
}
async function immutableFile(filename: string, bytes: Buffer): Promise<void> {
  const existing = await optionalRead(filename)
  if (existing) { if (checksum(existing) !== checksum(bytes)) throw new AppError('FILE_CORRUPTED', 409); return }
  await atomicFile(filename, bytes)
}

export class BusinessSync {
  private running: Promise<SyncStatus> | null = null
  private runningFull = false
  private previews = new Map<string, PreviewState>()
  private phase: SyncStatus['phase'] = 'idle'
  private error: string | null = null
  // Only reuse a fully ingested snapshot in this process. Explicit sync and
  // maintenance always verify files; background checks also do so every 5 min.
  private verified: { directory: string; head: string; at: number } | null = null
  constructor(readonly business: Business, readonly teams: TeamDirectory) {}
  status(): SyncStatus {
    const store = this.business.store
    const pendingOperations = store.db.prepare("SELECT COUNT(*) AS total FROM outbox WHERE state='pending'").get()!.total as number
    const pendingImports = store.get<{ deletion: VehicleDeletion; actor: Actor }[]>('pendingDeletionImports') || []
    const configurationImports = store.get<ConfigurationImport[]>('pendingConfigurationImports') || []
    const historyImports = store.get<RestoredHistoryImport[]>('pendingHistoryImports') || []
    const modificationImports = store.get<ModificationImport[]>('pendingModificationImports') || []
    return { phase: this.phase, error: this.error, pending: pendingOperations + pendingImports.length + configurationImports.length + historyImports.length + modificationImports.length, quarantined: store.quarantineRows().length, conflicts: store.db.prepare('SELECT payload FROM conflicts').all().map(row => JSON.parse(row.payload as string)), lastSync: store.get<string>('businessLastSync'), revision: store.get<string>('businessRevision') }
  }
  async settle(): Promise<void> { await this.business.store.settleWork(); if (this.running) await this.running }
  synchronize(directory: string, teamId: string, identity: Identity, options: { ifChanged?: boolean } = {}): Promise<SyncStatus> {
    if (this.running) return !options.ifChanged && !this.runningFull ? this.running.then(() => this.synchronize(directory, teamId, identity, options)) : this.running
    this.runningFull = !options.ifChanged
    this.phase = 'syncing'
    this.running = this.business.store.runWrite(() => this.teams.withAccess(directory, teamId, identity, false, team => this.cycle(directory, team, options.ifChanged))).catch(error => {
      this.verified = null
      this.error = error instanceof AppError ? error.code : 'SHARE_IO_ERROR'
      this.phase = ['SHARE_BUSY', 'SHARE_LOCK_LOST', 'MAINTENANCE_IN_PROGRESS'].includes(this.error) ? 'busy' : 'offline'
      return this.status()
    }).finally(() => { this.running = null })
    return this.running
  }
  async refreshLocked(directory: string, team: TeamDocument): Promise<SyncStatus> { return this.cycle(directory, team) }
  async ingestLocked(snapshot: SharedBusinessSnapshot): Promise<boolean> {
    this.verified = null
    if (!snapshot.head) throw new AppError('SHARE_CORRUPTED', 409)
    try {
      this.acceptCanonical(snapshot.db)
      const conflicts = this.business.store.db.prepare('SELECT payload FROM conflicts').all().map(row => JSON.parse(String(row.payload)) as SyncConflict)
      await this.ingest(snapshot.db, snapshot.directory, snapshot.head, conflicts); this.error = null; this.phase = conflicts.length ? 'conflict' : 'ready'; return true
    }
    catch { this.error = 'LOCAL_REFRESH_REQUIRED'; this.phase = 'offline'; return false }
  }
  private assertTargetSettled(vehicleId: string, canonicalIds: string[] = []): void {
    const store = this.business.store
    const ids = new Set([vehicleId, ...canonicalIds, ...store.db.prepare('SELECT id FROM records WHERE id=? OR vehicle_id=?').all(vehicleId, vehicleId).map(row => String(row.id))])
    const pending = store.db.prepare("SELECT payload FROM outbox WHERE state='pending'").all().map(row => JSON.parse(String(row.payload)) as Operation)
    if (pending.some(operation => ids.has(operation.recordId) || operation.vehicleId === vehicleId) || store.db.prepare('SELECT record_id FROM conflicts').all().some(row => ids.has(String(row.record_id)))) throw new AppError('DELETE_PENDING_CHANGES', 409)
  }
  private actorKey(identity: Identity, actor: Actor): string { return JSON.stringify([identity.deviceId, identity.localUserId, actor.id]) }
  async deletePreview(directory: string, teamId: string, identity: Identity, actor: Actor, vehicleId: string): Promise<VehicleDeletePreview> {
    const store = this.business.store
    return store.withMaintenance(() => this.teams.withAccess(directory, teamId, identity, true, async (team, member) => {
      this.assertTargetSettled(vehicleId)
      await this.refreshLocked(directory, team)
      store.assertNotDeleted(vehicleId)
      const snapshot = await SharedBusinessSnapshot.open(this.business, directory, teamId, atomicFile)
      try {
        const graph = snapshot.graph(vehicleId), vehicle = graph.find(row => row.id === vehicleId && row.kind === 'vehicle')
        if (!vehicle) throw new AppError('RECORD_NOT_FOUND', 404)
        if (!vehicle.archived) throw new AppError('VEHICLE_NOT_ARCHIVED', 409)
        this.assertTargetSettled(vehicleId, graph.map(row => row.id))
        for (const [token, previous] of this.previews) if (previous.expires < Date.now()) this.previews.delete(token)
        if (this.previews.size >= 100) this.previews.delete(this.previews.keys().next().value!)
        const token = randomBytes(32).toString('hex'), expires = Date.now() + 5 * 60 * 1000
        const version = this.business.get(vehicleId).version, vin = String(JSON.parse(vehicle.data).vin)
        this.previews.set(token, { vehicleId, actorKey: this.actorKey(identity, { ...actor, id: member.id }), graph: checksum(JSON.stringify(graph)), version, vin, expires })
        return { vehicleId, vin, version, counts: snapshot.counts(graph), token, expires, protocolUpgrade: (snapshot.head?.protocol || 1) < 2 }
      } finally { await snapshot.close() }
    }))
  }
  async deleteVehicle(directory: string, teamId: string, identity: Identity, actor: Actor, vehicleId: string, request: VehicleDeleteRequest): Promise<VehicleDeleteReceipt> {
    const store = this.business.store
    return store.withMaintenance(() => this.teams.withAccess(directory, teamId, identity, true, async (_, member) => {
      if (!request || request.confirmation !== 'DELETE') throw new AppError('DELETE_CONFIRMATION_REQUIRED')
      const explanation = reason(request.reason)
      if (typeof request.requestId !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(request.requestId) || typeof request.vin !== 'string') throw new AppError('INVALID_INPUT')
      const liveActor: Actor = { id: member.id, name: member.name, deviceId: identity.deviceId, role: member.role }
      const requestDigest = checksum(JSON.stringify({ vehicleId, actorKey: this.actorKey(identity, liveActor), previewToken: request.previewToken, version: request.version, vin: request.vin, confirmation: request.confirmation, reason: request.reason, requestId: request.requestId }))
      const snapshot = await SharedBusinessSnapshot.open(this.business, directory, teamId, atomicFile)
      let committed: VehicleDeletion | null = null
      try {
        const existing = snapshot.deletions().find(row => row.requestId === request.requestId)
        if (existing) {
          const storedDigest = snapshot.db.prepare('SELECT value FROM metadata WHERE key=?').get(`deleteRequest:${request.requestId}`)?.value
          if (existing.vehicleId !== vehicleId || existing.vin !== request.vin || existing.reason !== explanation || existing.actor.id !== member.id || existing.actor.deviceId !== identity.deviceId || (storedDigest && storedDigest !== requestDigest)) throw new AppError('DELETE_REQUEST_MISMATCH', 409)
          committed = existing
        } else {
          if (snapshot.deletions().some(row => row.vehicleId === vehicleId)) throw new AppError('VEHICLE_DELETED', 410)
          const preview = this.previews.get(request.previewToken)
          if (!preview || preview.expires < Date.now()) throw new AppError('DELETE_PREVIEW_EXPIRED', 409)
          if (preview.vehicleId !== vehicleId || preview.actorKey !== this.actorKey(identity, liveActor) || preview.vin !== request.vin || preview.version !== request.version) throw new AppError('DELETE_PREVIEW_CHANGED', 409)
          const graph = snapshot.graph(vehicleId), vehicle = graph.find(row => row.id === vehicleId && row.kind === 'vehicle')
          if (!vehicle) throw new AppError('RECORD_NOT_FOUND', 404)
          this.assertTargetSettled(vehicleId, graph.map(row => row.id))
          if (this.business.get(vehicleId).version !== request.version || checksum(JSON.stringify(graph)) !== preview.graph) throw new AppError('DELETE_PREVIEW_CHANGED', 409)
          if (!vehicle.archived) throw new AppError('VEHICLE_NOT_ARCHIVED', 409)
          const revision = randomUUID(), sequence = (snapshot.head?.sequence || 0) + 1, deletedAt = now(), id = randomUUID()
          const marker: VehicleDeletion = { id, requestId: request.requestId, vehicleId, vin: preview.vin, recordIds: graph.map(row => row.id), fileKeys: [...new Set(graph.flatMap(row => collectRecordFileKeys(fromRow(row))))], actor: liveActor, reason: explanation, deletedAt, revision, sequence }
          validateVehicleDeletion(marker)
          const change: Change = { id, recordId: vehicleId, vehicleId, kind: 'vehicle', before: JSON.parse(vehicle.data), after: {}, archivedBefore: true, archivedAfter: true, actor: liveActor, reason: explanation, action: 'vehicle.deleted', sourceId: null, created: deletedAt }
          snapshot.db.exec('BEGIN IMMEDIATE')
          try {
            snapshot.db.prepare('INSERT INTO vehicle_deletions VALUES(?,?,?)').run(vehicleId, request.requestId, JSON.stringify(marker))
            snapshot.db.prepare('INSERT INTO changes VALUES(?,?,?,?,?)').run(id, vehicleId, vehicleId, JSON.stringify(change), deletedAt)
            snapshot.db.prepare('INSERT INTO metadata VALUES(?,?)').run(`deleteRequest:${request.requestId}`, requestDigest)
            snapshot.db.prepare('DELETE FROM records WHERE vehicle_id=?').run(vehicleId)
            snapshot.db.prepare('DELETE FROM records WHERE id=?').run(vehicleId)
            snapshot.db.exec('COMMIT')
          } catch (error) { snapshot.db.exec('ROLLBACK'); throw error }
          try { await snapshot.publish(teamId, 2, revision, sequence) }
          catch (error) { if (snapshot.head?.revision !== revision) throw error; committed = marker }
          committed = marker
          this.previews.delete(request.previewToken)
        }
        store.rememberDeletions([committed])
        try { await this.ingest(snapshot.db, snapshot.directory, snapshot.head!, []); this.error = null; this.phase = 'ready'; return { ...committed, localSynced: true } }
        catch { this.error = 'LOCAL_REFRESH_REQUIRED'; this.phase = 'offline'; return { ...committed, localSynced: false } }
      } finally { await snapshot.close() }
    }))
  }
  private checkConflict(master: DatabaseSync, operations: Operation[], team: TeamDocument, retainedEquipmentUploads: ReadonlySet<string> = new Set()): SyncConflict | null {
    const first = operations[0], last = operations.at(-1)!
    const row = master.prepare('SELECT * FROM records WHERE id=?').get(first.recordId) as RecordRow | undefined
    const remote = stateOf(row), fields: string[] = []
    if (isProtectedKind(first.kind)) fields.push('_protected')
    if (first.kind === 'modificationGroup') fields.push('_modificationManaged')
    if (first.kind === 'attachment' && !first.decision) {
      const equipmentId = parseEquipmentAttachmentId(last.desired.data.equipmentId)
      const beforeId = first.base ? parseEquipmentAttachmentId(first.base.data.equipmentId) : ''
      if (equipmentId === null || equipmentId && last.desired.data.purpose === 'vehiclePhoto' || first.base && beforeId !== equipmentId || remote && parseEquipmentAttachmentId(remote.data.equipmentId) !== equipmentId) fields.push('_equipmentLink')
      if (equipmentId) {
        const equipment = master.prepare('SELECT kind,vehicle_id,archived FROM records WHERE id=?').get(equipmentId)
        if (!equipment || equipment.kind !== 'equipment' || equipment.vehicle_id !== first.vehicleId || !first.base && equipment.archived && !retainedEquipmentUploads.has(first.recordId) && !operations.every(operation => operation.maintenance === 'restore')) fields.push('_equipmentParent')
      }
    }
    if (first.kind === 'modification') {
      const discard = first.decision && equivalent(remote, last.desired)
      if (!discard && (remote?.data.groupId || last.desired.data.groupId)) fields.push('_modificationLink')
      const protocol = Number(master.prepare("SELECT value FROM metadata WHERE key='protocol'").get()?.value || 1)
      const protectedText = remote && hasEnhancedModificationText(remote.data) || operations.some(operationHasEnhancedModificationText)
      if (protocol < 5 && (protectedText || !discard && last.desired.data.attachments !== undefined)) fields.push('_modificationDisabled')
    }
    if (first.kind === 'vehicle' && last.desired.archived && master.prepare("SELECT data FROM records WHERE vehicle_id=? AND kind='modification' AND archived=0").all(first.recordId).some(row => Boolean(JSON.parse(String(row.data)).groupId))) fields.push('_modificationLinkedArchive')
    for (const operation of operations) {
      const member = team.members.find(item => item.id === operation.actor.id && item.enabled)
      const binding = team.bindings.find(item => item.memberId === operation.actor.id && item.deviceId === operation.actor.deviceId && item.enabled)
      const privileged = operation.maintenance === 'restore' || (operation.base && operation.base.archived !== operation.desired.archived)
      if (!member || !binding || (privileged && member.role !== 'admin')) fields.push('_permission')
    }
    const duplicateReport = first.kind === 'report' && !first.base && remote?.data.checksum === last.desired.data.checksum && row?.vehicle_id === first.vehicleId
    if (!duplicateReport) {
      if (!first.base) { if (remote) fields.push('_record') }
      else if (!remote) fields.push('_record')
      else {
        for (const key of fieldKeys(first.base.data, last.desired.data)) if (!equivalentField(first.kind, key, first.base.data[key], last.desired.data[key]) && !equivalentField(first.kind, key, remote.data[key], first.base.data[key]) && !equivalentField(first.kind, key, remote.data[key], last.desired.data[key])) fields.push(key)
        if (remote.archived !== first.base.archived && (last.desired.archived !== remote.archived || !equivalentData(first.kind, last.desired.data, first.base.data) || operations.some(operation => operation.files.length))) fields.push('_archived')
        if (last.desired.archived !== first.base.archived && !equivalentData(first.kind, remote.data, first.base.data)) fields.push('_archived')
      }
    }
    if (first.kind === 'vehicle' && master.prepare('SELECT id FROM records WHERE vin=? AND id<>?').get(String(last.desired.data.vin), first.recordId)) fields.push('_vin')
    if (first.vehicleId) {
      const parent = master.prepare('SELECT archived FROM records WHERE id=?').get(first.vehicleId)
      if (!parent || (parent.archived && !operations.every(operation => operation.maintenance === 'restore'))) fields.push('_parent')
    }
    if (first.kind === 'part' && last.desired.data.category === 'component') {
      const protocol = Number(master.prepare("SELECT value FROM metadata WHERE key='protocol'").get()?.value || 1)
      const flags = configurationFeatureFlags(protocol, master.prepare("SELECT value FROM metadata WHERE key='configurationEnabled'").get()?.value, master.prepare("SELECT value FROM metadata WHERE key='configurationPolicyEnabled'").get()?.value)
      if (!flags.enabled) fields.push('_configurationDisabled')
      const definitions = componentTypeDefinitions((master.prepare('SELECT * FROM records').all() as RecordRow[]).map(fromRow))
      if (!definitions.some(type => type.id === last.desired.data.componentTypeId && !['hv-battery', 'emotor', 'controllers'].includes(type.id))) fields.push('_componentType')
    }
    if (!fields.length) return null
    const conflict = { recordId: first.recordId, kind: first.kind, name: String(last.desired.data.name || first.recordId), fields: [...new Set(fields)], local: last.desired, remote, base: first.base, operationIds: operations.map(operation => operation.id) }
    return { ...conflict, token: checksum(JSON.stringify(conflict)) }
  }
  private apply(master: DatabaseSync, operations: Operation[]): void {
    const first = operations[0], last = operations.at(-1)!
    const row = master.prepare('SELECT * FROM records WHERE id=?').get(first.recordId) as RecordRow | undefined
    const duplicateReport = first.kind === 'report' && !first.base && row && JSON.parse(row.data).checksum === last.desired.data.checksum
    if (!first.decision && !duplicateReport) {
      const data: Fields = row ? JSON.parse(row.data) : structuredClone(last.desired.data)
      if (first.base) for (const key of fieldKeys(first.base.data, last.desired.data)) if (!equivalentField(first.kind, key, first.base.data[key], last.desired.data[key])) {
        if (Object.hasOwn(last.desired.data, key)) data[key] = last.desired.data[key]
        else delete data[key]
      }
      const archived = !row || !first.base || first.base.archived !== last.desired.archived ? last.desired.archived : Boolean(row.archived)
      const vin = first.kind === 'vehicle' ? String(data.vin) : null
      if (row) master.prepare('UPDATE records SET data=?,vin=?,archived=?,version=version+1,updated=? WHERE id=?').run(JSON.stringify(data), vin, archived ? 1 : 0, now(), first.recordId)
      else master.prepare('INSERT INTO records VALUES(?,?,?,?,?,?,?,?)').run(first.recordId, first.kind, first.vehicleId, vin, JSON.stringify(data), archived ? 1 : 0, 1, now())
    }
    for (const operation of operations) {
      for (const change of operation.changes) master.prepare('INSERT OR IGNORE INTO changes VALUES(?,?,?,?,?)').run(change.id, change.recordId, change.vehicleId, JSON.stringify(change), change.created)
      master.prepare('INSERT INTO applied VALUES(?,?)').run(operation.id, JSON.stringify(operation))
    }
  }
  private async filesToShare(directory: string, operations: Operation[]): Promise<void> {
    for (const key of new Set(operations.flatMap(operation => [...operation.files, ...operation.changes.flatMap(collectChangeFileKeys)]))) {
      if (!hashKey(key)) throw new AppError('INVALID_INPUT')
      const bytes = await this.business.readBlob(key)
      await immutableFile(path.join(directory, 'blobs', key), bytes)
    }
  }
  private acceptCanonical(master: DatabaseSync): VehicleDeletion[] {
    const store = this.business.store
    const markers = master.prepare('SELECT payload FROM vehicle_deletions').all().map(row => validateVehicleDeletion(JSON.parse(String(row.payload))))
    store.rememberDeletions(markers)
    store.transaction(() => {
      for (const operation of store.db.prepare("SELECT id FROM outbox WHERE state='pending'").all()) if (master.prepare('SELECT id FROM applied WHERE id=?').get(operation.id)) store.db.prepare("UPDATE outbox SET state='sent' WHERE id=?").run(operation.id)
      store.applyDeletions(markers)
      for (const change of master.prepare('SELECT * FROM changes').all()) store.db.prepare('INSERT OR IGNORE INTO changes VALUES(?,?,?,?,?)').run(change.id, change.record_id, change.vehicle_id, change.payload, change.created)
      const imports = store.get<{ deletion: VehicleDeletion; actor: Actor }[]>('pendingDeletionImports') || []
      if (imports.length) store.set('pendingDeletionImports', imports.filter(item => !markers.some(marker => marker.vehicleId === item.deletion.vehicleId && marker.id === item.deletion.id)))
    })
    return markers
  }
  private async ingest(master: DatabaseSync, directory: string, head: BusinessHead, conflicts: SyncConflict[]): Promise<void> {
    this.acceptCanonical(master)
    const records = master.prepare(`SELECT * FROM records ORDER BY ${kinds},id`).all() as RecordRow[]
    if (head.protocol >= 3) { try { const view = records.map(fromRow); assertConfigurationProtocol(view, head.protocol); validateConfigurationRecords(view) } catch { throw new AppError('CONFIGURATION_CORRUPTED', 409) } }
    try { validateModificationRecords(records.map(fromRow), head.protocol) } catch { throw new AppError('MODIFICATION_CORRUPTED', 409) }
    validateEquipmentAttachmentRecords(records.map(fromRow))
    const files = new Map<string, number>()
    for (const row of records) {
      const record = fromRow(row)
      const references = ['report', 'attachment'].includes(record.kind) ? [{ checksum: String(record.data.checksum), size: Number(record.data.size) }] : modificationFiles(record)
      for (const file of references) {
        if (!hashKey(file.checksum) || files.has(file.checksum) && files.get(file.checksum) !== file.size) throw new AppError('FILE_CORRUPTED', 409)
        files.set(file.checksum, file.size)
      }
    }
    for (const row of master.prepare('SELECT payload FROM changes').all()) {
      const change = JSON.parse(String(row.payload)) as Change
      if (!['modification', 'modificationGroup'].includes(change.kind)) continue
      for (const data of [change.before, change.after]) if (data) for (const file of modificationFiles({ kind: change.kind, data } as BusinessRecord)) {
        if (files.has(file.checksum) && files.get(file.checksum) !== file.size) throw new AppError('FILE_CORRUPTED', 409)
        files.set(file.checksum, file.size)
      }
    }
    for (const [key, size] of files) {
      const localPath = path.join(this.business.store.directory, 'blobs', key)
      const local = await optionalRead(localPath)
      if (local && checksum(local) === key && local.length === size) continue
      const bytes = await fs.readFile(path.join(directory, 'blobs', key))
      if (checksum(bytes) !== key || bytes.length !== size) throw new AppError('FILE_CORRUPTED', 409)
      await fs.mkdir(path.dirname(localPath), { recursive: true })
      await atomicFile(localPath, bytes)
    }
    const store = this.business.store
    store.transaction(() => {
      for (const operation of store.db.prepare("SELECT id FROM outbox WHERE state='pending'").all()) if (master.prepare('SELECT id FROM applied WHERE id=?').get(operation.id)) store.db.prepare("UPDATE outbox SET state='sent' WHERE id=?").run(operation.id)
      const pending = new Set(store.db.prepare("SELECT record_id FROM outbox WHERE state='pending'").all().map(row => row.record_id))
      for (const row of records) {
        if (pending.has(row.id)) continue
        const duplicate = row.kind === 'vehicle' ? store.db.prepare('SELECT id FROM records WHERE vin=? AND id<>?').get(JSON.parse(row.data).vin, row.id) : null
        if (duplicate) {
          if (!pending.has(duplicate.id)) throw new AppError('VIN_EXISTS', 409)
          store.db.prepare('UPDATE records SET vin=?,version=version+1 WHERE id=?').run(`pending:${duplicate.id}`, duplicate.id)
        }
        const local = store.db.prepare('SELECT * FROM records WHERE id=?').get(row.id) as RecordRow | undefined
        if (row.kind === 'configurationRevision' && local && (local.kind !== row.kind || local.vehicle_id !== row.vehicle_id || local.data !== row.data || local.archived !== row.archived)) throw new AppError('CONFIGURATION_CORRUPTED', 409)
        if (row.kind === 'modificationGroup') {
          if (!local) store.db.prepare('INSERT INTO records VALUES(?,?,?,?,?,?,?,?)').run(row.id, row.kind, null, null, row.data, row.archived, row.version, row.updated)
          else store.db.prepare('UPDATE records SET data=?,archived=?,version=?,updated=? WHERE id=?').run(row.data, row.archived, row.version, row.updated, row.id)
        }
        else if (!local) store.db.prepare('INSERT INTO records VALUES(?,?,?,?,?,?,?,?)').run(row.id, row.kind, row.vehicle_id, row.kind === 'vehicle' ? String(JSON.parse(row.data).vin) : null, row.data, row.archived, 1, row.updated)
        else if (row.data !== local.data || row.archived !== local.archived) store.db.prepare('UPDATE records SET data=?,vin=?,archived=?,version=version+1,updated=? WHERE id=?').run(row.data, row.kind === 'vehicle' ? String(JSON.parse(row.data).vin) : null, row.archived, row.updated, row.id)
      }
      for (const change of master.prepare('SELECT * FROM changes').all()) store.db.prepare('INSERT OR IGNORE INTO changes VALUES(?,?,?,?,?)').run(change.id, change.record_id, change.vehicle_id, change.payload, change.created)
      store.db.exec('DELETE FROM conflicts')
      for (const conflict of conflicts) store.db.prepare('INSERT INTO conflicts VALUES(?,?)').run(conflict.recordId, JSON.stringify(conflict))
      store.set('businessRevision', head.revision); store.set('businessSequence', head.sequence); store.set('businessProtocol', head.protocol); store.set('businessLastSync', now())
      const flags = configurationFeatureFlags(head.protocol, master.prepare("SELECT value FROM metadata WHERE key='configurationEnabled'").get()?.value, master.prepare("SELECT value FROM metadata WHERE key='configurationPolicyEnabled'").get()?.value)
      store.set('configurationEnabled', flags.enabled); store.set('configurationPolicyEnabled', flags.policyEnabled)
      store.set('configurationReceipts', master.prepare("SELECT key,value FROM metadata WHERE key LIKE 'configurationRequest:%'").all().map(row => ({ key: String(row.key), value: String(row.value) })))
      store.set('modificationReceipts', master.prepare("SELECT key,value FROM metadata WHERE key LIKE 'modificationRequest:%'").all().map(row => ({ key: String(row.key), value: String(row.value) })))
      const imports = store.get<ConfigurationImport[]>('pendingConfigurationImports') || []
      if (imports.length) store.set('pendingConfigurationImports', imports.filter(entry => !master.prepare('SELECT key FROM metadata WHERE key=?').get(`configurationImport:${entry.id}`)))
      const historyImports = store.get<RestoredHistoryImport[]>('pendingHistoryImports') || []
      if (historyImports.length) store.set('pendingHistoryImports', historyImports.filter(entry => !master.prepare('SELECT key FROM metadata WHERE key=?').get(`historyImport:${entry.id}`)))
      const modificationImports = store.get<ModificationImport[]>('pendingModificationImports') || []
      if (modificationImports.length) store.set('pendingModificationImports', modificationImports.filter(entry => !master.prepare('SELECT key FROM metadata WHERE key=?').get(`modificationImport:${entry.id}`)))
    })
  }
  private async cycle(shared: string, team: TeamDocument, ifChanged = false): Promise<SyncStatus> {
    const previous = this.verified, state = this.status()
    if (ifChanged && previous?.directory === shared && Date.now() >= previous.at && Date.now() - previous.at < 300000 && !state.pending && !state.conflicts.length) {
      // Runs under the existing shared lock, after fresh membership/device
      // validation. Even an unchanged HEAD must pass rollback/protocol checks.
      const head = await SharedBusinessSnapshot.readHead(this.business, shared, team.id)
      if (head && JSON.stringify(head) === previous.head && head.revision === state.revision) {
        this.error = null; this.phase = 'ready'
        return this.status()
      }
    }
    this.verified = null
    const snapshot = await SharedBusinessSnapshot.open(this.business, shared, team.id, atomicFile)
    try {
      const master = snapshot.db, directory = snapshot.directory, store = this.business.store
      const markers = snapshot.deletions()
      this.acceptCanonical(master)
      let changed = !snapshot.head, protocol: 1 | 2 | 3 | 4 | 5 = snapshot.head?.protocol || 1
      for (const entry of store.get<{ deletion: VehicleDeletion; actor: Actor }[]>('pendingDeletionImports') || []) {
        const marker = validateVehicleDeletion(entry.deletion), existing = markers.find(item => item.vehicleId === marker.vehicleId)
        if (existing) { if (existing.id !== marker.id) throw new AppError('BACKUP_DELETION_CONFLICT', 409); continue }
        const member = team.members.find(item => item.id === entry.actor.id && item.enabled && item.role === 'admin')
        const binding = team.bindings.find(item => item.memberId === entry.actor.id && item.deviceId === entry.actor.deviceId && item.enabled)
        if (!member || !binding) throw new AppError('ADMIN_REQUIRED', 403)
        if (master.prepare('SELECT vehicle_id FROM vehicle_deletions WHERE request_id=?').get(marker.requestId) || snapshot.graph(marker.vehicleId).length || marker.recordIds.some(id => master.prepare('SELECT id FROM records WHERE id=?').get(id))) throw new AppError('BACKUP_DELETION_CONFLICT', 409)
        master.prepare('INSERT INTO vehicle_deletions VALUES(?,?,?)').run(marker.vehicleId, marker.requestId, JSON.stringify(marker))
        const deferredHistory: Change[] = []
        for (const row of store.db.prepare('SELECT * FROM changes WHERE vehicle_id=?').all(marker.vehicleId)) {
          const change = JSON.parse(String(row.payload)) as Change
          if (protocol < 5 && changeHasEnhancedModificationText(change)) { deferredHistory.push(change); continue }
          master.prepare('INSERT OR IGNORE INTO changes VALUES(?,?,?,?,?)').run(row.id, row.record_id, row.vehicle_id, row.payload, row.created)
        }
        if (deferredHistory.length) {
          const historyImports = store.get<RestoredHistoryImport[]>('pendingHistoryImports') || []
          const queued = new Set(historyImports.flatMap(historyImport => historyImport.changes.map(change => change.id)))
          const missing = deferredHistory.filter(change => !queued.has(change.id))
          if (missing.length) {
            const historyImport = historyImports.find(historyImport => historyImport.id === marker.id)
            if (historyImport) historyImport.changes.push(...missing)
            else historyImports.push({ id: marker.id, actor: entry.actor, changes: missing })
            store.set('pendingHistoryImports', historyImports)
          }
        }
        markers.push(marker); changed = true; protocol = Math.max(protocol, 2) as 2 | 3 | 4 | 5
      }
      const configurationImports = (store.get<ConfigurationImport[]>('pendingConfigurationImports') || []).filter(entry => !master.prepare('SELECT key FROM metadata WHERE key=?').get(`configurationImport:${entry.id}`))
      const configurationFlags = configurationFeatureFlags(protocol, master.prepare("SELECT value FROM metadata WHERE key='configurationEnabled'").get()?.value, master.prepare("SELECT value FROM metadata WHERE key='configurationPolicyEnabled'").get()?.value)
      if (configurationImports.length && !configurationFlags.enabled) throw new AppError('CONFIGURATION_NOT_ENABLED', 409)
      if (!configurationFlags.policyEnabled && configurationImports.some(entry => entry.records.some(record => isProtectedKind(record.kind) && record.data.schema === 2))) throw new AppError('CONFIGURATION_POLICY_NOT_ENABLED', 409)
      for (const entry of configurationImports) {
        const member = team.members.find(item => item.id === entry.actor.id && item.enabled && item.role === 'admin')
        const binding = team.bindings.find(item => item.memberId === entry.actor.id && item.deviceId === entry.actor.deviceId && item.enabled)
        if (!member || !binding) throw new AppError('ADMIN_REQUIRED', 403)
        for (const record of entry.records.filter(row => row.kind === 'componentType')) {
          try { validateComponentTypeRecord(record) } catch { throw new AppError('INVALID_BACKUP', 422) }
          const existing = master.prepare('SELECT * FROM records WHERE id=?').get(record.id) as RecordRow | undefined
          if (existing) { if (existing.kind !== record.kind || existing.vehicle_id !== null) throw new AppError('CONFIGURATION_CORRUPTED', 409); continue }
          master.prepare('INSERT INTO records VALUES(?,?,?,?,?,?,?,?)').run(record.id, record.kind, null, null, JSON.stringify(record.data), 0, 1, record.updated)
          changed = true
        }
      }
      try { componentTypeDefinitions((master.prepare('SELECT * FROM records').all() as RecordRow[]).map(fromRow)) }
      catch (error) { throw new AppError(error instanceof Error && 'code' in error && error.code === 'COMPONENT_TYPE_EXISTS' ? 'COMPONENT_TYPE_EXISTS' : 'CONFIGURATION_CORRUPTED', 409) }
      const modificationImports = (store.get<ModificationImport[]>('pendingModificationImports') || []).filter(entry => !master.prepare('SELECT key FROM metadata WHERE key=?').get(`modificationImport:${entry.id}`))
      if (modificationImports.length && protocol < 5) throw new AppError('MODIFICATION_NOT_ENABLED', 409)
      const deferredModifications: BusinessRecord[] = []
      const deletedRecord = (record: BusinessRecord) => markers.some(marker => marker.recordIds.includes(record.id) || marker.vehicleId === record.vehicleId)
      const stable = (value: unknown): unknown => Array.isArray(value) ? value.map(stable) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, child]) => [key, stable(child)])) : value
      const applyModificationImportRecord = (record: BusinessRecord) => {
        if (deletedRecord(record)) return
        if (!['modification', 'modificationGroup'].includes(record.kind)) throw new AppError('INVALID_BACKUP', 422)
        const existing = master.prepare('SELECT * FROM records WHERE id=?').get(record.id) as RecordRow | undefined
        if (existing && (existing.kind !== record.kind || existing.vehicle_id !== record.vehicleId)) throw new AppError('MODIFICATION_RESTORE_CONFLICT', 409)
        if (existing) master.prepare('UPDATE records SET data=?,archived=?,version=version+1,updated=? WHERE id=?').run(JSON.stringify(record.data), record.archived ? 1 : 0, now(), record.id)
        else master.prepare('INSERT INTO records VALUES(?,?,?,?,?,?,?,?)').run(record.id, record.kind, record.vehicleId, null, JSON.stringify(record.data), record.archived ? 1 : 0, 1, now())
        for (const change of store.db.prepare('SELECT * FROM changes WHERE record_id=?').all(record.id)) master.prepare('INSERT OR IGNORE INTO changes VALUES(?,?,?,?,?)').run(change.id, change.record_id, change.vehicle_id, change.payload, change.created)
        changed = true
      }
      for (const entry of modificationImports) {
        const member = team.members.find(item => item.id === entry.actor.id && item.enabled && item.role === 'admin')
        const binding = team.bindings.find(item => item.memberId === entry.actor.id && item.deviceId === entry.actor.deviceId && item.enabled)
        if (!member || !binding) throw new AppError('ADMIN_REQUIRED', 403)
        for (const record of entry.records.filter(record => !deletedRecord(record))) {
          const current = master.prepare('SELECT * FROM records WHERE id=?').get(record.id) as RecordRow | undefined
          if (!entry.baseStates || !Object.hasOwn(entry.baseStates, record.id) || JSON.stringify(stable(stateOf(current))) !== JSON.stringify(stable(entry.baseStates[record.id]))) throw new AppError('MODIFICATION_RESTORE_CONFLICT', 409)
          if (record.kind === 'modificationGroup' && (current?.version ?? null) !== entry.baseVersions[record.id]) throw new AppError('MODIFICATION_RESTORE_CONFLICT', 409)
          for (const key of collectRecordFileKeys(record)) await immutableFile(path.join(directory, 'blobs', key), await this.business.readBlob(key))
        }
        for (const receipt of entry.receipts || []) {
          try { validateModificationReceiptEntry(receipt) } catch { throw new AppError('INVALID_BACKUP', 422) }
          const existing = master.prepare('SELECT value FROM metadata WHERE key=?').get(receipt.key)
          if (existing && existing.value !== receipt.value) throw new AppError('MODIFICATION_RESTORE_CONFLICT', 409)
        }
      }
      for (const entry of modificationImports) for (const record of [...entry.records].sort((left, right) => Number(right.kind === 'modificationGroup') - Number(left.kind === 'modificationGroup'))) {
        if (deletedRecord(record)) continue
        if (record.vehicleId && !master.prepare("SELECT id FROM records WHERE id=? AND kind='vehicle'").get(record.vehicleId)) deferredModifications.push(record)
        else applyModificationImportRecord(record)
      }
      const pending = this.business.store.db.prepare("SELECT payload FROM outbox WHERE state='pending' ORDER BY seq").all().map(row => JSON.parse(row.payload as string) as Operation)
      const groups = new Map<string, Operation[]>()
      for (const operation of pending) {
        const deleted = markers.find(marker => marker.recordIds.includes(operation.recordId) || marker.vehicleId === operation.vehicleId || marker.vehicleId === operation.recordId)
        if (deleted) { store.quarantineOperation(operation, deleted.vehicleId); continue }
        if (!(protocol < 5 && operation.kind === 'modification' && operationHasEnhancedModificationText(operation))) await immutableFile(path.join(directory, 'operations', `${operation.id}.json`), Buffer.from(JSON.stringify(operation)))
        if (master.prepare('SELECT id FROM applied WHERE id=?').get(operation.id)) continue
        if (!groups.has(operation.recordId)) groups.set(operation.recordId, [])
        groups.get(operation.recordId)!.push(operation)
      }
      const conflicts: SyncConflict[] = []
      const operationOrder = (operation: Operation) => operation.kind === 'vehicle' ? 0 : operation.kind === 'equipment' ? 1 : operation.kind === 'attachment' ? 3 : 2
      const ordered = [...groups.values()].sort((left, right) => operationOrder(left[0]) - operationOrder(right[0]))
      const ordinals = new Map(pending.map((operation, index) => [operation.id, index]))
      const retainedEquipmentUploads = new Set<string>()
      for (const operations of ordered) {
        const conflict = this.checkConflict(master, operations, team, retainedEquipmentUploads)
        if (conflict && !operations[0].decision) { conflicts.push(conflict); continue }
        if (conflict?.fields.some(field => ['_permission', '_protected', '_configurationDisabled', '_componentType', '_modificationManaged', '_modificationLink', '_modificationDisabled', '_modificationLinkedArchive', '_equipmentParent', '_equipmentLink'].includes(field))) { conflicts.push(conflict); continue }
        await this.filesToShare(directory, operations)
        master.exec('BEGIN IMMEDIATE')
        try { this.apply(master, operations); master.exec('COMMIT'); changed = true } catch (error) { master.exec('ROLLBACK'); throw error }
        // Files accepted before a local archive stay with that equipment in the
        // same atomic publication. A later remote archive never grants this.
        const archive = operations.find(operation => operation.kind === 'equipment' && operation.desired.archived && !operation.base?.archived && !operation.decision)
        if (archive) for (const queued of groups.values()) {
          const upload = queued[0]
          if (upload.kind === 'attachment' && !upload.base && parseEquipmentAttachmentId(upload.desired.data.equipmentId) === archive.recordId && ordinals.get(upload.id)! < ordinals.get(archive.id)!) retainedEquipmentUploads.add(upload.recordId)
        }
      }
      for (const record of deferredModifications) {
        if (!record.vehicleId || !master.prepare("SELECT id FROM records WHERE id=? AND kind='vehicle'").get(record.vehicleId)) throw new AppError('MODIFICATION_RESTORE_CONFLICT', 409)
        applyModificationImportRecord(record)
      }
      for (const entry of modificationImports) {
        for (const receipt of entry.receipts || []) master.prepare('INSERT OR IGNORE INTO metadata VALUES(?,?)').run(receipt.key, receipt.value)
        master.prepare('INSERT OR REPLACE INTO metadata VALUES(?,?)').run(`modificationImport:${entry.id}`, '1')
        changed = true
      }
      for (const entry of configurationImports) {
        for (const record of entry.records.filter(row => row.kind === 'configurationRevision')) {
          if (markers.some(marker => marker.vehicleId === record.vehicleId || marker.recordIds.includes(record.id))) throw new AppError('VEHICLE_DELETED', 410)
          try { validateConfigurationRevisionRecord(record) } catch { throw new AppError('INVALID_BACKUP', 422) }
          const existing = master.prepare('SELECT * FROM records WHERE id=?').get(record.id) as RecordRow | undefined
          if (existing) { if (existing.kind !== record.kind || existing.vehicle_id !== record.vehicleId || existing.data !== JSON.stringify(record.data)) throw new AppError('CONFIGURATION_CORRUPTED', 409); continue }
          master.prepare('INSERT INTO records VALUES(?,?,?,?,?,?,?,?)').run(record.id, record.kind, record.vehicleId, null, JSON.stringify(record.data), 0, 1, record.updated)
          changed = true
        }
        for (const receipt of entry.receipts || []) {
          try { validateConfigurationReceiptEntry(receipt) } catch { throw new AppError('INVALID_BACKUP', 422) }
          const existing = master.prepare('SELECT value FROM metadata WHERE key=?').get(receipt.key)
          if (existing && existing.value !== receipt.value) throw new AppError('CONFIGURATION_CORRUPTED', 409)
          if (!existing) master.prepare('INSERT INTO metadata VALUES(?,?)').run(receipt.key, receipt.value)
        }
        master.prepare('INSERT OR REPLACE INTO metadata VALUES(?,?)').run(`configurationImport:${entry.id}`, '1')
        changed = true
      }
      for (const entry of store.get<RestoredHistoryImport[]>('pendingHistoryImports') || []) {
        if (protocol < 5 && entry.changes.some(changeHasEnhancedModificationText)) continue
        if (master.prepare('SELECT key FROM metadata WHERE key=?').get(`historyImport:${entry.id}`)) continue
        const member = team.members.find(item => item.id === entry.actor.id && item.enabled && item.role === 'admin')
        const binding = team.bindings.find(item => item.memberId === entry.actor.id && item.deviceId === entry.actor.deviceId && item.enabled)
        if (!member || !binding) throw new AppError('ADMIN_REQUIRED', 403)
        for (const change of entry.changes) {
          for (const key of collectChangeFileKeys(change)) await immutableFile(path.join(directory, 'blobs', key), await this.business.readBlob(key))
          master.prepare('INSERT OR IGNORE INTO changes VALUES(?,?,?,?,?)').run(change.id, change.recordId, change.vehicleId, JSON.stringify(change), change.created)
        }
        master.prepare('INSERT INTO metadata VALUES(?,?)').run(`historyImport:${entry.id}`, '1')
        changed = true
      }
      if (protocol >= 3) { try { const view = (master.prepare('SELECT * FROM records').all() as RecordRow[]).map(fromRow); assertConfigurationProtocol(view, protocol); validateConfigurationRecords(view) } catch { throw new AppError('CONFIGURATION_CORRUPTED', 409) } }
      try { validateModificationRecords((master.prepare('SELECT * FROM records').all() as RecordRow[]).map(fromRow), protocol) } catch { throw new AppError('MODIFICATION_CORRUPTED', 409) }
      validateEquipmentAttachmentRecords((master.prepare('SELECT * FROM records').all() as RecordRow[]).map(fromRow))
      if (changed) {
        await snapshot.publish(team.id, protocol)
      }
      await this.ingest(snapshot.db, directory, snapshot.head!, conflicts)
      this.error = null; this.phase = conflicts.length ? 'conflict' : 'ready'
      this.verified = { directory: shared, head: JSON.stringify(snapshot.head), at: Date.now() }
      return this.status()
    } finally { await snapshot.close() }
  }
  async resolve(directory: string, teamId: string, identity: Identity, actor: Actor, recordId: string, token: string, choices: Record<string, string>, reason: string): Promise<SyncStatus> {
    return this.business.store.runWrite(() => this.resolveWithinWrite(directory, teamId, identity, actor, recordId, token, choices, reason))
  }
  private async resolveWithinWrite(directory: string, teamId: string, identity: Identity, actor: Actor, recordId: string, token: string, choices: Record<string, string>, reason: string): Promise<SyncStatus> {
    await this.synchronize(directory, teamId, identity)
    if (this.phase === 'offline' || this.phase === 'busy') throw new AppError(this.error || 'SHARE_UNAVAILABLE', 409)
    const store = this.business.store
    store.assertNotDeleted(recordId)
    const row = store.db.prepare('SELECT payload FROM conflicts WHERE record_id=?').get(recordId)
    const conflict = row ? JSON.parse(row.payload as string) as SyncConflict : null
    if (!conflict || conflict.token !== token || conflict.fields.some(field => !['local', 'shared'].includes(choices[field]))) throw new AppError('CONFLICT_CHANGED', 409)
    if (conflict.fields.includes('_permission') && actor.role !== 'admin') throw new AppError('ADMIN_REQUIRED', 403)
    const operations = store.db.prepare("SELECT payload FROM outbox WHERE record_id=? AND state='pending' ORDER BY seq").all(recordId).map(row => JSON.parse(row.payload as string) as Operation)
    const current = this.business.get(recordId)
    if (isProtectedKind(current.kind) || conflict.fields.includes('_protected')) throw new AppError('CONFIGURATION_IMMUTABLE', 409)
    if (current.kind === 'modificationGroup' || conflict.fields.includes('_modificationManaged')) throw new AppError('MODIFICATION_MANAGED', 409)
    if (current.kind === 'modification' && (store.get<number>('businessProtocol') || 1) < 5 && (hasEnhancedModificationText(current.data) || conflict.remote && hasEnhancedModificationText(conflict.remote.data) || operations.some(operationHasEnhancedModificationText))) throw new AppError('MODIFICATION_NOT_ENABLED', 409)
    if (conflict.fields.some(field => ['_modificationLink', '_modificationDisabled', '_modificationLinkedArchive'].includes(field) && choices[field] !== 'shared')) throw new AppError('MODIFICATION_LINKED', 409)
    if (conflict.fields.some(field => ['_equipmentParent', '_equipmentLink'].includes(field) && choices[field] !== 'shared')) throw new AppError('INVALID_INPUT', 409)
    if (!equivalent(conflict.local, { data: current.data, archived: current.archived }) || !equivalent(conflict.operationIds, operations.map(operation => operation.id))) throw new AppError('CONFLICT_CHANGED', 409)
    const discard = conflict.fields.some(field => field.startsWith('_') && choices[field] === 'shared')
    if (conflict.fields.includes('_vin') && !discard) throw new AppError('VIN_EXISTS', 409)
    const desired = structuredClone(conflict.remote || conflict.local)
    if (!discard) {
      for (const field of fieldKeys(conflict.base?.data || {}, current.data)) if ((!conflict.base || !equivalentField(current.kind, field, conflict.base.data[field], current.data[field])) && (!conflict.fields.includes(field) || choices[field] === 'local')) {
        if (Object.hasOwn(current.data, field)) desired.data[field] = current.data[field]
        else delete desired.data[field]
      }
      if (!conflict.base || conflict.base.archived !== current.archived || choices._archived === 'local') desired.archived = current.archived
    }
    const id = randomUUID(), created = now()
    const change: Change = { id, recordId, kind: current.kind, vehicleId: current.vehicleId || current.id, before: current.data, after: desired.data, archivedBefore: current.archived, archivedAfter: desired.archived, actor, action: 'conflict.resolved', reason, sourceId: null, created }
    const operation: Operation = { id, recordId, kind: current.kind, vehicleId: current.vehicleId, base: conflict.remote, desired, changes: [...operations.flatMap(operation => operation.changes), change], actor, files: discard ? [] : operations.flatMap(operation => operation.files), created, decision: discard }
    store.transaction(() => {
      for (const previous of operations) store.db.prepare("UPDATE outbox SET state='superseded' WHERE id=?").run(previous.id)
      store.db.prepare('INSERT INTO outbox(id,record_id,payload) VALUES(?,?,?)').run(id, recordId, JSON.stringify(operation))
      store.db.prepare('INSERT INTO changes VALUES(?,?,?,?,?)').run(id, recordId, change.vehicleId, JSON.stringify(change), created)
      store.db.prepare('UPDATE records SET data=?,archived=?,vin=?,version=version+1,updated=? WHERE id=?').run(JSON.stringify(desired.data), discard && !conflict.remote ? 1 : desired.archived ? 1 : 0, current.kind === 'vehicle' ? discard && !conflict.remote ? `discarded:${recordId}` : String(desired.data.vin) : null, created, recordId)
      store.db.prepare('DELETE FROM conflicts WHERE record_id=?').run(recordId)
    })
    return this.synchronize(directory, teamId, identity)
  }
}
