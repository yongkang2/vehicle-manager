import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { promises as fs } from 'node:fs'
import { Business, checksum, fromRow, normalizeFields, now, reason } from './business.js'
import type { RecordRow } from './business.js'
import { SharedBusinessSnapshot } from './deletions.js'
import { atomicFile, BusinessSync } from './sync.js'
import { AppError, bindingFor, TeamDirectory } from './team.js'
import type { Actor, BusinessRecord, Change, Fields } from '../shared/business.js'
import type { Identity, Member } from '../shared/types.js'
import { collectRecordFileKeys, MODIFICATION_MAX_TARGETS, modificationGroupId, modificationView, validateModificationRecords } from '../shared/modifications.js'
import type { ModificationFile, ModificationImport, ModificationMutation, ModificationPopulateRequest, ModificationReceipt, ModificationReceiptEntry, ModificationView } from '../shared/modifications.js'
import { validateModificationFile } from './modification-files.js'

export type ModificationContext = { directory: string; teamId: string; identity: Identity; actor: Actor; assertCurrent?: () => void; assertLinked?: () => void; scopeKey?: string; syncEnabled?: boolean; online?: boolean; verifyAccess?: () => Promise<Actor> }
export type ModificationResult = ModificationReceipt & { modification?: ModificationView; fileId?: string; enabled?: boolean }
type StoredReceipt = { actorKey: string; commandDigest: string; kind: string; receipt: ModificationResult }
type EditRequest = ModificationMutation & { data: Fields }
type ArchiveRequest = ModificationMutation & { archived: boolean }
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/
const plain = (value: unknown): value is Fields => value !== null && typeof value === 'object' && !Array.isArray(value)
const rawRecords = (snapshot: SharedBusinessSnapshot): BusinessRecord[] => (snapshot.db.prepare('SELECT * FROM records ORDER BY kind,id').all() as RecordRow[]).map(fromRow)
const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right)
const stale = (): never => { throw new AppError('MODIFICATION_STALE', 409) }

/** Shared groups are canonical maintenance commands; independent records remain ordinary queued writes. */
export class Modifications {
  constructor(readonly business: Business, readonly synchronization: BusinessSync, readonly teams: TeamDirectory = synchronization.teams) {}
  detail(id: string): ModificationView {
    if (this.business.get(id).kind !== 'modification') throw new AppError('RECORD_NOT_FOUND', 404)
    return modificationView(this.business.list(), id)
  }
  private assertContext(context: ModificationContext, linked = false): void {
    context.assertCurrent?.()
    if (linked) context.assertLinked?.()
    if (linked && context.syncEnabled === false) throw new AppError('CONFIRM_RESUME', 409)
    if (linked && context.online === false) throw new AppError('MODIFICATION_LINKED_ONLINE_REQUIRED', 409)
  }
  private actorKey(context: ModificationContext, actor = context.actor): string { return JSON.stringify([context.identity.deviceId, context.identity.localUserId, actor.id]) }
  private checkRequest(input: { requestId: string; reason: string; version?: number; groupVersion?: number | null }, withVersion = true): void {
    if (!input || !uuid.test(input.requestId) || withVersion && (!Number.isSafeInteger(input.version) || Number(input.version) < 1) || input.groupVersion != null && (!Number.isSafeInteger(input.groupVersion) || input.groupVersion < 1)) throw new AppError('INVALID_INPUT')
    reason(input.reason)
  }
  private verifyStored(stored: StoredReceipt, context: ModificationContext, actor: Actor, kind: string, command: unknown): ModificationResult {
    if (stored.actorKey !== this.actorKey(context, actor) || stored.kind !== kind || stored.commandDigest !== checksum(JSON.stringify(command))) throw new AppError('MODIFICATION_REQUEST_MISMATCH', 409)
    return structuredClone(stored.receipt)
  }
  private localReceipt(context: ModificationContext, requestId: string, kind: string, command: unknown, actor = context.actor): ModificationResult | null {
    const store = this.business.store, key = `modificationRequest:${requestId}`
    const retained = [...(store.get<ModificationReceiptEntry[]>('modificationLocalReceipts') || []), ...(store.get<ModificationReceiptEntry[]>('modificationReceipts') || []), ...(store.get<ModificationImport[]>('pendingModificationImports') || []).flatMap(entry => entry.receipts)].find(entry => entry.key === key)
    const stored = store.get<StoredReceipt>(key) || (retained ? JSON.parse(retained.value) as StoredReceipt : null)
    return stored ? this.verifyStored(stored, context, actor, kind, command) : null
  }
  private rememberLocal(context: ModificationContext, actor: Actor, kind: string, command: unknown, receipt: ModificationResult): void {
    const key = `modificationRequest:${receipt.requestId}`, stored = { actorKey: this.actorKey(context, actor), commandDigest: checksum(JSON.stringify(command)), kind, receipt }
    this.business.store.set(key, stored)
    const entries = this.business.store.get<ModificationReceiptEntry[]>('modificationLocalReceipts') || []
    this.business.store.set('modificationLocalReceipts', [...entries.filter(entry => entry.key !== key), { key, value: JSON.stringify(stored) }])
  }
  private canonicalReceipt(snapshot: SharedBusinessSnapshot, context: ModificationContext, actor: Actor, requestId: string, kind: string, command: unknown): ModificationResult | null {
    const row = snapshot.db.prepare('SELECT value FROM metadata WHERE key=?').get(`modificationRequest:${requestId}`)
    return row ? this.verifyStored(JSON.parse(String(row.value)) as StoredReceipt, context, actor, kind, command) : null
  }
  private decorate(receipt: ModificationResult, id?: string): ModificationResult {
    if (!id || !receipt.localSynced) return receipt
    try { return { ...receipt, modification: this.detail(id) } } catch { return receipt }
  }
  private requireEnabled(protocol = this.business.store.get<number>('businessProtocol') || 1): void { if (protocol < 5) throw new AppError('MODIFICATION_NOT_ENABLED', 409) }
  private requireVehicle(records: readonly BusinessRecord[], id: string, writable = true): BusinessRecord {
    this.business.store.assertNotDeleted(id)
    const record = records.find(row => row.id === id && row.kind === 'vehicle')
    if (!record) throw new AppError('RECORD_NOT_FOUND', 404)
    if (writable && record.archived) throw new AppError('PARENT_ARCHIVED', 409)
    return record
  }
  private requireView(records: readonly BusinessRecord[], id: string, writable = true): ModificationView {
    this.business.store.assertNotDeleted(id)
    const record = records.find(row => row.id === id && row.kind === 'modification')
    if (!record || !record.vehicleId) throw new AppError('RECORD_NOT_FOUND', 404)
    this.requireVehicle(records, record.vehicleId, writable)
    if (writable && record.archived) throw new AppError('RECORD_ARCHIVED', 409)
    return modificationView(records, id)
  }
  private assertVersions(view: ModificationView, request: ModificationMutation): void {
    if (view.record.version !== request.version) throw new AppError('VERSION_CONFLICT', 409)
    if ((request.groupVersion ?? null) !== view.groupVersion) stale()
  }
  private reviewed(snapshot: SharedBusinessSnapshot, id: string, request: ModificationMutation, writable = true): ModificationView {
    const local = this.requireView(this.business.list(), id, writable)
    this.assertVersions(local, request)
    const records = rawRecords(snapshot), canonical = this.requireView(records, id, writable), localRaw = this.business.get(id), canonicalRaw = records.find(row => row.id === id)!
    if (!same(localRaw.data, canonicalRaw.data) || localRaw.archived !== canonicalRaw.archived || localRaw.vehicleId !== canonicalRaw.vehicleId || canonical.groupVersion !== (request.groupVersion ?? null)) stale()
    return canonical
  }
  private assertSettled(ids: readonly string[]): void {
    const store = this.business.store, wanted = new Set(ids)
    const rows = store.db.prepare("SELECT payload FROM outbox WHERE state='pending'").all()
    if (rows.some(row => { const operation = JSON.parse(String(row.payload)); return wanted.has(operation.recordId) || wanted.has(operation.vehicleId) }) || store.db.prepare('SELECT record_id FROM conflicts').all().some(row => wanted.has(String(row.record_id)))) throw new AppError('MODIFICATION_PENDING_CHANGES', 409)
    if (['pendingConfigurationImports', 'pendingModificationImports', 'pendingHistoryImports', 'pendingDeletionImports'].some(key => store.get<unknown[]>(key)?.length)) throw new AppError('MODIFICATION_PENDING_CHANGES', 409)
  }
  private async verifyLocal(context: ModificationContext): Promise<Actor> {
    this.assertContext(context)
    if (context.verifyAccess) { const actor = await context.verifyAccess(); this.assertContext(context); return actor }
    try {
      const team = await this.teams.read(context.directory, context.teamId), { member, binding } = bindingFor(team, context.identity)
      if (!member?.enabled || !binding?.enabled) throw new AppError('ACCESS_DISABLED', 403)
      this.assertContext(context)
      return { id: member.id, name: member.name, role: member.role, deviceId: context.identity.deviceId }
    } catch (error) {
      if (!(error instanceof AppError) || !['SHARE_UNAVAILABLE', 'SHARE_IO_ERROR', 'SHARE_ACCESS_DENIED'].includes(error.code)) throw error
      this.assertContext(context); return context.actor
    }
  }
  private async ensureFiles(files: readonly ModificationFile[]): Promise<void> {
    for (const file of files) { const bytes = await this.business.readBlob(file.checksum); if (bytes.length !== file.size) throw new AppError('FILE_CORRUPTED', 409) }
  }
  private async filesToShare(snapshot: SharedBusinessSnapshot, records: readonly BusinessRecord[]): Promise<void> {
    for (const key of new Set(records.flatMap(collectRecordFileKeys))) {
      const bytes = await this.business.readBlob(key), target = path.join(snapshot.directory, 'blobs', key)
      const existing = await fs.readFile(target).catch(error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error })
      if (existing) { if (checksum(existing) !== key) throw new AppError('FILE_CORRUPTED', 409) } else await atomicFile(target, bytes)
    }
  }
  private async canonical(context: ModificationContext, requestId: string, kind: string, command: unknown, admin: boolean, work: (snapshot: SharedBusinessSnapshot, actor: Actor) => Promise<ModificationResult>, decorateId?: string): Promise<ModificationResult> {
    this.assertContext(context, true)
    return this.business.store.withMaintenance(() => this.teams.withAccess(context.directory, context.teamId, context.identity, admin, async (team, member: Member) => {
      const actor: Actor = { id: member.id, name: member.name, role: member.role, deviceId: context.identity.deviceId }
      this.assertContext(context, true)
      const writer = (destination: string, bytes: Buffer | string) => atomicFile(destination, bytes, path.basename(destination) === 'HEAD.json' ? () => this.assertContext(context, true) : undefined)
      let snapshot = await SharedBusinessSnapshot.open(this.business, context.directory, context.teamId, writer)
      try {
        const recovered = this.canonicalReceipt(snapshot, context, actor, requestId, kind, command)
        if (recovered) return this.decorate({ ...recovered, localSynced: await this.synchronization.ingestLocked(snapshot) }, decorateId)
      } finally { await snapshot.close() }
      const state = await this.synchronization.refreshLocked(context.directory, team)
      this.assertContext(context, true)
      if (state.error) throw new AppError(state.error, 409)
      snapshot = await SharedBusinessSnapshot.open(this.business, context.directory, context.teamId, writer)
      try {
        const recovered = this.canonicalReceipt(snapshot, context, actor, requestId, kind, command)
        if (recovered) return this.decorate({ ...recovered, localSynced: await this.synchronization.ingestLocked(snapshot) }, decorateId)
        snapshot.db.exec('BEGIN IMMEDIATE')
        let receipt: ModificationResult
        try {
          receipt = await work(snapshot, actor)
          this.assertContext(context, true)
          validateModificationRecords(rawRecords(snapshot), kind === 'enable' ? 5 : snapshot.head?.protocol || 1)
          snapshot.db.prepare('INSERT INTO metadata VALUES(?,?)').run(`modificationRequest:${requestId}`, JSON.stringify({ actorKey: this.actorKey(context, actor), commandDigest: checksum(JSON.stringify(command)), kind, receipt }))
          snapshot.db.exec('COMMIT')
        } catch (error) { snapshot.db.exec('ROLLBACK'); throw error }
        await snapshot.publish(context.teamId, 5)
        return this.decorate({ ...receipt, localSynced: await this.synchronization.ingestLocked(snapshot) }, decorateId)
      } finally { await snapshot.close() }
    }))
  }
  private writeCanonical(snapshot: SharedBusinessSnapshot, record: BusinessRecord): void {
    const current = snapshot.db.prepare('SELECT id FROM records WHERE id=?').get(record.id)
    if (current) snapshot.db.prepare('UPDATE records SET data=?,archived=?,version=?,updated=? WHERE id=?').run(JSON.stringify(record.data), record.archived ? 1 : 0, record.version, record.updated, record.id)
    else snapshot.db.prepare('INSERT INTO records VALUES(?,?,?,?,?,?,?,?)').run(record.id, record.kind, record.vehicleId, null, JSON.stringify(record.data), record.archived ? 1 : 0, record.version, record.updated)
  }
  private advanceGroupScope(snapshot: SharedBusinessSnapshot, groupId: string): void {
    snapshot.db.prepare("UPDATE records SET version=version+1,updated=? WHERE id=? AND kind='modificationGroup'").run(now(), groupId)
  }
  private audit(snapshot: SharedBusinessSnapshot, actor: Actor, record: BusinessRecord, before: BusinessRecord | null, explanation: string, action: string): void {
    const change: Change = { id: randomUUID(), recordId: record.id, vehicleId: record.vehicleId || record.id, kind: record.kind, before: before?.data || null, after: record.data, archivedBefore: before?.archived ?? null, archivedAfter: record.archived, actor, reason: explanation, action, sourceId: null, created: now() }
    snapshot.db.prepare('INSERT INTO changes VALUES(?,?,?,?,?)').run(change.id, change.recordId, change.vehicleId, JSON.stringify(change), change.created)
  }
  private cloneFiles(files: readonly ModificationFile[], activeOnly = false): ModificationFile[] { return files.filter(file => !activeOnly || !file.archived).map(file => ({ ...file, id: randomUUID() })) }
  private receipt(requestId: string, action: string, recordIds: string[], groupId: string | null = null): ModificationResult { return { requestId, action, recordIds, groupId, localSynced: false } }
  private linked(id: string, request: ModificationMutation): boolean { if (request.groupVersion != null) return true; try { return Boolean(modificationGroupId(this.business.get(id))) } catch { return false } }

  async enable(context: ModificationContext, request: { requestId: string; reason: string }): Promise<ModificationResult> {
    this.checkRequest(request, false)
    const command = { reason: reason(request.reason) }
    return this.canonical(context, request.requestId, 'enable', command, true, async (snapshot, actor) => {
      const receipt = { ...this.receipt(request.requestId, 'enabled', []), enabled: true }
      for (const [key, threshold] of [['configurationEnabled', 3], ['configurationPolicyEnabled', 4]] as const) {
        if (!snapshot.db.prepare('SELECT key FROM metadata WHERE key=?').get(key)) snapshot.db.prepare('INSERT INTO metadata VALUES(?,?)').run(key, (snapshot.head?.protocol || 1) >= threshold ? '1' : '0')
      }
      if ((snapshot.head?.protocol || 1) < 5) this.audit(snapshot, actor, { id: 'modification-activation', kind: 'modificationGroup', vehicleId: null, data: { name: 'Vehicle Modification enabled' }, archived: false, version: 1, updated: now() }, null, command.reason, 'modification.enabled')
      return receipt
    })
  }
  async edit(id: string, request: EditRequest, context: ModificationContext): Promise<ModificationResult> {
    this.checkRequest(request)
    if (!plain(request.data) || ['groupId', 'attachments', 'schema'].some(key => Object.hasOwn(request.data, key))) throw new AppError('INVALID_INPUT')
    const fields = normalizeFields('modification', request.data), command = { id, version: request.version, groupVersion: request.groupVersion ?? null, data: fields, reason: reason(request.reason) }
    if (this.linked(id, request)) return this.canonical(context, request.requestId, 'edit', command, false, async (snapshot, actor) => {
      this.requireEnabled(snapshot.head?.protocol)
      const records = rawRecords(snapshot), view = this.reviewed(snapshot, id, request)
      if (!view.groupId) stale()
      this.assertSettled([id, view.groupId!, ...view.linkedVehicles.map(vehicle => vehicle.id)])
      const group = records.find(record => record.id === view.groupId)!, updated = { ...group, data: { schema: 1, ...fields, attachments: view.files }, version: group.version + 1, updated: now() }
      this.writeCanonical(snapshot, updated)
      for (const member of records.filter(record => record.kind === 'modification' && record.data.groupId === view.groupId)) {
        const before = modificationView(records, member.id).record
        this.audit(snapshot, actor, { ...member, data: { ...fields, attachments: view.files, groupId: view.groupId } }, before, command.reason, 'modification.sharedUpdated')
      }
      return this.receipt(request.requestId, 'updated', [id], view.groupId)
    }, id)
    return this.independent(id, request, context, 'edit', command, [], (view, actor) => {
      this.business.write({ id, kind: 'modification', vehicleId: view.record.vehicleId, data: fields, version: request.version, actor, reason: command.reason })
      return this.receipt(request.requestId, 'updated', [id])
    })
  }
  private async independent(id: string, request: ModificationMutation, context: ModificationContext, kind: string, command: unknown, files: readonly ModificationFile[], work: (view: ModificationView, actor: Actor) => ModificationResult): Promise<ModificationResult> {
    return this.business.store.runWrite(async () => {
      this.assertContext(context)
      const recovered = this.localReceipt(context, request.requestId, kind, command)
      if (recovered) return this.decorate(recovered, id)
      const before = this.requireView(this.business.list(), id, kind !== 'archiveMember')
      this.assertVersions(before, request); if (before.groupId) stale()
      await this.ensureFiles(files)
      const actor = await this.verifyLocal(context)
      let receipt!: ModificationResult
      this.business.store.transaction(() => {
        const retry = this.localReceipt(context, request.requestId, kind, command, actor)
        if (retry) { receipt = retry; return }
        const current = this.requireView(this.business.list(), id, kind !== 'archiveMember')
        this.assertVersions(current, request); if (current.groupId) stale()
        this.assertContext(context)
        receipt = { ...work(current, actor), localSynced: true }
        this.rememberLocal(context, actor, kind, command, receipt)
      })
      return this.decorate(receipt, id)
    })
  }
  async upload(id: string, request: ModificationMutation & { name: string; bytes: Buffer }, context: ModificationContext): Promise<ModificationResult> {
    this.checkRequest(request)
    const command = { id, version: request.version, groupVersion: request.groupVersion ?? null, name: request.name, checksum: checksum(request.bytes), size: request.bytes.length, reason: reason(request.reason) }
    if (this.linked(id, request)) return this.changeLinkedFiles(id, request, context, 'upload', command, async files => {
      await validateModificationFile(request.name, request.bytes)
      const key = await this.business.blob(request.bytes)
      this.assertContext(context, true)
      const file: ModificationFile = { id: randomUUID(), name: request.name, checksum: key, size: request.bytes.length, savedAt: now(), archived: false }
      return { files: [...files, file], fileId: file.id }
    })
    return this.business.store.runWrite(async () => {
      this.assertContext(context); this.requireEnabled()
      await validateModificationFile(request.name, request.bytes)
      const key = await this.business.blob(request.bytes)
      this.assertContext(context)
      return this.independent(id, request, context, 'upload', command, [], (view, actor) => {
      this.requireEnabled()
      const file: ModificationFile = { id: randomUUID(), name: request.name, checksum: key, size: request.bytes.length, savedAt: now(), archived: false }
      this.business.write({ id, kind: 'modification', vehicleId: view.record.vehicleId, data: normalizeFields('modification', view.record.data), modificationAttachments: [...view.files, file], version: request.version, actor, reason: command.reason })
      return { ...this.receipt(request.requestId, 'fileUploaded', [id]), fileId: file.id }
      })
    })
  }
  async archiveFile(id: string, fileId: string, request: ArchiveRequest, context: ModificationContext): Promise<ModificationResult> {
    this.checkRequest(request)
    if (!uuid.test(fileId) || typeof request.archived !== 'boolean') throw new AppError('INVALID_INPUT')
    const command = { id, fileId, version: request.version, groupVersion: request.groupVersion ?? null, archived: request.archived, reason: reason(request.reason) }
    const update = (files: ModificationFile[]) => { if (!files.some(file => file.id === fileId)) throw new AppError('RECORD_NOT_FOUND', 404); return { files: files.map(file => file.id === fileId ? { ...file, archived: request.archived } : file), fileId } }
    if (this.linked(id, request)) return this.changeLinkedFiles(id, request, context, 'archiveFile', command, update, true)
    return this.independent(id, request, context, 'archiveFile', command, [], (view, actor) => {
      if (actor.role !== 'admin') throw new AppError('ADMIN_REQUIRED', 403)
      this.business.write({ id, kind: 'modification', vehicleId: view.record.vehicleId, data: normalizeFields('modification', view.record.data), modificationAttachments: update(view.files).files, version: request.version, actor, reason: command.reason })
      return this.receipt(request.requestId, 'fileArchived', [id])
    })
  }
  private changeLinkedFiles(id: string, request: ModificationMutation, context: ModificationContext, kind: string, command: unknown, update: (files: ModificationFile[]) => { files: ModificationFile[]; fileId: string } | Promise<{ files: ModificationFile[]; fileId: string }>, admin = false): Promise<ModificationResult> {
    return this.canonical(context, request.requestId, kind, command, admin, async (snapshot, actor) => {
      this.requireEnabled(snapshot.head?.protocol)
      const records = rawRecords(snapshot), view = this.reviewed(snapshot, id, request)
      if (!view.groupId) stale()
      this.assertSettled([id, view.groupId!, ...view.linkedVehicles.map(vehicle => vehicle.id)])
      const group = records.find(row => row.id === view.groupId)!, changed = await update(view.files), next = { ...group, data: { ...group.data, attachments: changed.files }, version: group.version + 1, updated: now() }
      await this.filesToShare(snapshot, [next]); this.assertContext(context, true)
      this.writeCanonical(snapshot, next)
      for (const member of records.filter(row => row.kind === 'modification' && row.data.groupId === view.groupId)) this.audit(snapshot, actor, { ...member, data: { ...view.record.data, attachments: changed.files } }, modificationView(records, member.id).record, reason(request.reason), kind === 'upload' ? 'modification.fileUploaded' : 'modification.fileArchived')
      return { ...this.receipt(request.requestId, kind === 'upload' ? 'fileUploaded' : 'fileArchived', [id], view.groupId), fileId: changed.fileId }
    }, id)
  }
  async download(id: string, fileId: string, context: ModificationContext): Promise<{ name: string; bytes: Buffer }> {
    return this.business.store.runWrite(async () => {
      this.assertContext(context)
      const view = this.detail(id), file = view.files.find(entry => entry.id === fileId)
      if (!file) throw new AppError('RECORD_NOT_FOUND', 404)
      const bytes = await this.business.readBlob(file.checksum)
      await this.verifyLocal(context)
      const current = this.detail(id), actual = current.files.find(entry => entry.id === fileId)
      if (!actual || actual.checksum !== file.checksum || bytes.length !== actual.size) throw new AppError('FILE_MISSING', 404)
      this.business.store.event(context.actor.id, 'file.downloaded', { recordId: id, fileId })
      return { name: file.name, bytes }
    })
  }
  private targets(records: readonly BusinessRecord[], source: ModificationView, request: ModificationPopulateRequest): BusinessRecord[] {
    if (!Array.isArray(request.targets) || !request.targets.length || request.targets.length > MODIFICATION_MAX_TARGETS || request.targets.some(target => !target || !uuid.test(target.vehicleId) || typeof target.expectedVin !== 'string') || new Set(request.targets.map(target => target.vehicleId)).size !== request.targets.length) throw new AppError('INVALID_INPUT')
    return request.targets.map(target => {
      if (!target || !uuid.test(target.vehicleId) || typeof target.expectedVin !== 'string' || target.vehicleId === source.record.vehicleId) throw new AppError('INVALID_INPUT')
      const vehicle = this.requireVehicle(records, target.vehicleId)
      if (vehicle.data.vin !== target.expectedVin) stale()
      if (source.groupId && records.some(record => record.kind === 'modification' && record.vehicleId === vehicle.id && record.data.groupId === source.groupId)) throw new AppError('MODIFICATION_ALREADY_LINKED', 409)
      return vehicle
    })
  }
  async populate(id: string, request: ModificationPopulateRequest, context: ModificationContext): Promise<ModificationResult> {
    this.checkRequest(request)
    if (!['oneTime', 'linked'].includes(request.mode)) throw new AppError('INVALID_INPUT')
    const command = { id, version: request.version, groupVersion: request.groupVersion ?? null, mode: request.mode, targets: request.targets, reason: reason(request.reason) }
    if (request.mode === 'linked') return this.canonical(context, request.requestId, 'populate', command, false, async (snapshot, actor) => {
      this.requireEnabled(snapshot.head?.protocol)
      const records = rawRecords(snapshot), source = this.reviewed(snapshot, id, request), targets = this.targets(records, source, request)
      this.assertSettled([id, source.record.vehicleId!, ...(source.groupId ? [source.groupId] : []), ...targets.map(vehicle => vehicle.id)])
      let groupId = source.groupId
      const changed: BusinessRecord[] = [], targetIds: string[] = []
      if (!groupId) {
        groupId = randomUUID()
        const group: BusinessRecord = { id: groupId, kind: 'modificationGroup', vehicleId: null, archived: false, version: 1, updated: now(), data: { schema: 1, ...normalizeFields('modification', source.record.data), attachments: this.cloneFiles(source.files) } }
        const member = records.find(record => record.id === id)!, next = { ...member, data: { groupId }, version: member.version + 1, updated: now() }
        this.writeCanonical(snapshot, group); this.writeCanonical(snapshot, next); changed.push(group)
        this.audit(snapshot, actor, { ...source.record, data: { ...source.record.data, groupId } }, source.record, command.reason, 'modification.linked')
      } else this.advanceGroupScope(snapshot, groupId)
      for (const vehicle of targets) {
        const target: BusinessRecord = { id: randomUUID(), kind: 'modification', vehicleId: vehicle.id, data: { groupId }, archived: false, version: 1, updated: now() }
        this.writeCanonical(snapshot, target); targetIds.push(target.id)
        this.audit(snapshot, actor, { ...target, data: { ...source.record.data, groupId } }, null, command.reason, 'modification.linked')
      }
      await this.filesToShare(snapshot, changed)
      return this.receipt(request.requestId, 'populated', targetIds, groupId)
    })
    return this.business.store.runWrite(async () => {
      this.assertContext(context)
      const recovered = this.localReceipt(context, request.requestId, 'populate', command)
      if (recovered) return recovered
      const source = this.requireView(this.business.list(), id), targetRows = this.targets(this.business.list(), source, request)
      this.assertVersions(source, request)
      const files = this.cloneFiles(source.files, true)
      if (files.length) this.requireEnabled()
      await this.ensureFiles(files)
      const actor = await this.verifyLocal(context)
      let receipt!: ModificationResult
      this.business.store.transaction(() => {
        const retry = this.localReceipt(context, request.requestId, 'populate', command, actor)
        if (retry) { receipt = retry; return }
        const current = this.requireView(this.business.list(), id); this.assertVersions(current, request)
        this.targets(this.business.list(), current, request)
        const created = targetRows.map(vehicle => this.business.write({ kind: 'modification', vehicleId: vehicle.id, data: normalizeFields('modification', current.record.data), ...(files.length ? { modificationAttachments: this.cloneFiles(files) } : {}), actor, reason: command.reason }).id)
        receipt = { ...this.receipt(request.requestId, 'populated', created), localSynced: true }
        this.rememberLocal(context, actor, 'populate', command, receipt)
      })
      return receipt
    })
  }
  async unlink(id: string, request: ModificationMutation, context: ModificationContext): Promise<ModificationResult> {
    this.checkRequest(request)
    const command = { id, version: request.version, groupVersion: request.groupVersion ?? null, reason: reason(request.reason) }
    return this.canonical(context, request.requestId, 'unlink', command, false, async (snapshot, actor) => {
      this.requireEnabled(snapshot.head?.protocol)
      const records = rawRecords(snapshot), view = this.reviewed(snapshot, id, request)
      if (!view.groupId) stale()
      this.assertSettled([id, view.record.vehicleId!, view.groupId!])
      const member = records.find(record => record.id === id)!, next = { ...member, data: { ...normalizeFields('modification', view.record.data), attachments: this.cloneFiles(view.files) }, version: member.version + 1, updated: now() }
      this.writeCanonical(snapshot, next); this.audit(snapshot, actor, next, view.record, command.reason, 'modification.unlinked')
      this.advanceGroupScope(snapshot, view.groupId!)
      return this.receipt(request.requestId, 'unlinked', [id])
    }, id)
  }
  async archiveMember(id: string, request: ArchiveRequest, context: ModificationContext): Promise<ModificationResult> {
    this.checkRequest(request)
    if (typeof request.archived !== 'boolean') throw new AppError('INVALID_INPUT')
    const command = { id, version: request.version, groupVersion: request.groupVersion ?? null, archived: request.archived, reason: reason(request.reason) }
    if (this.linked(id, request)) return this.canonical(context, request.requestId, 'archiveMember', command, true, async (snapshot, actor) => {
      const records = rawRecords(snapshot), view = this.reviewed(snapshot, id, request)
      if (!request.archived || !view.groupId) stale()
      this.assertSettled([id, view.record.vehicleId!, view.groupId!])
      const member = records.find(record => record.id === id)!, next = { ...member, data: { ...normalizeFields('modification', view.record.data), attachments: this.cloneFiles(view.files) }, archived: true, version: member.version + 1, updated: now() }
      this.writeCanonical(snapshot, next); this.audit(snapshot, actor, next, view.record, command.reason, 'archived')
      this.advanceGroupScope(snapshot, view.groupId!)
      return this.receipt(request.requestId, 'archived', [id])
    }, id)
    return this.independent(id, request, context, 'archiveMember', command, [], (view, actor) => {
      if (actor.role !== 'admin') throw new AppError('ADMIN_REQUIRED', 403)
      this.business.write({ id, kind: 'modification', vehicleId: view.record.vehicleId, data: normalizeFields('modification', view.record.data), version: request.version, archived: request.archived, actor, reason: command.reason })
      return this.receipt(request.requestId, request.archived ? 'archived' : 'restored', [id])
    })
  }
  async archiveVehicle(id: string, request: ArchiveRequest & { groupVersions?: Record<string, number> }, context: ModificationContext): Promise<ModificationResult> {
    this.checkRequest(request)
    if (request.archived !== true) throw new AppError('INVALID_INPUT')
    const localVehicle = this.business.get(id), captured = request.groupVersions || Object.fromEntries(this.business.list('modification', id).filter(record => modificationGroupId(record)).map(record => { const view = this.detail(record.id); return [view.groupId!, view.groupVersion!] }))
    const command = { id, version: request.version, archived: true, groupVersions: request.groupVersions ?? null, reason: reason(request.reason) }
    return this.canonical(context, request.requestId, 'archiveVehicle', command, true, async (snapshot, actor) => {
      const records = rawRecords(snapshot), vehicle = this.requireVehicle(records, id)
      if (this.business.get(id).version !== request.version || !same(this.business.get(id).data, vehicle.data) || localVehicle.vehicleId !== null) stale()
      const members = records.filter(record => record.kind === 'modification' && record.vehicleId === id && modificationGroupId(record))
      this.assertSettled([id, ...members.map(record => record.id), ...members.map(record => modificationGroupId(record)!)])
      if (Object.keys(captured).length !== new Set(members.map(record => modificationGroupId(record))).size) stale()
      for (const member of members) {
        const view = modificationView(records, member.id)
        if (captured[view.groupId!] !== view.groupVersion) stale()
        const frozen = { ...member, data: { ...normalizeFields('modification', view.record.data), attachments: this.cloneFiles(view.files) }, archived: true, version: member.version + 1, updated: now() }
        this.writeCanonical(snapshot, frozen); this.audit(snapshot, actor, frozen, view.record, command.reason, 'archived')
        this.advanceGroupScope(snapshot, view.groupId!)
      }
      const next = { ...vehicle, archived: true, version: vehicle.version + 1, updated: now() }
      this.writeCanonical(snapshot, next); this.audit(snapshot, actor, next, vehicle, command.reason, 'archived')
      return this.receipt(request.requestId, 'vehicleArchived', [id, ...members.map(record => record.id)])
    })
  }
}
