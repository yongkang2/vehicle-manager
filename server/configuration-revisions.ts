import { randomBytes, randomUUID } from 'node:crypto'
import path from 'node:path'
import { Business, checksum, fromRow, now, reason } from './business.js'
import type { RecordRow } from './business.js'
import { SharedBusinessSnapshot } from './deletions.js'
import { atomicFile, BusinessSync } from './sync.js'
import { AppError, TeamDirectory } from './team.js'
import type { Actor, BusinessRecord, Change } from '../shared/business.js'
import type { Identity, Member, TeamDocument } from '../shared/types.js'
import { componentTypeDefinitions, configurationRevisionLabel, configurationRevisionSummaries, configurationSections, configurationSnapshot, configurationSourceFingerprint, isProtectedKind, pendingComponentTypeView, validateConfigurationRecords, validateConfigurationRevisionRecord } from '../shared/configuration-revisions.js'
import type { ComponentTypeCatalog, ComponentTypeData, ComponentTypeDefinition, ConfigurationImport, ConfigurationPreview, ConfigurationPublishRequest, ConfigurationPublicationReceipt, ConfigurationRevisionData, ConfigurationRevisionRecord, ConfigurationRevisionSummary, ConfigurationWorkingView } from '../shared/configuration-revisions.js'

export type ConfigurationContext = { directory: string; teamId: string; identity: Identity; actor: Actor; assertCurrent?: () => void; scopeKey?: string; syncEnabled?: boolean }
type PreviewState = { actorKey: string; vehicleId: string; guard: string; previousRevisionId: string | null; expires: number }
type StoredReceipt = { actorKey: string; commandDigest: string; kind: string; receipt: Record<string, unknown> }
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/
const plain = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
const normalizedText = (value: unknown, maximum: number, required = false): string => {
  if (typeof value !== 'string' || value.length > maximum || required && !value.trim()) throw new AppError('INVALID_INPUT')
  return value.trim()
}
const protectedRecords = (snapshot: SharedBusinessSnapshot) => (snapshot.db.prepare('SELECT * FROM records ORDER BY kind,id').all() as RecordRow[]).map(fromRow)
function safe<T>(work: () => T): T {
  try { return work() } catch (error) { if (error instanceof AppError) throw error; throw new AppError(error instanceof Error && 'code' in error ? String(error.code) : 'CONFIGURATION_CORRUPTED', 409) }
}

/** Canonical mutations are maintenance jobs, never ordinary business outbox operations. */
export class ConfigurationRevisions {
  private previews = new Map<string, PreviewState>()
  constructor(readonly business: Business, readonly synchronization: BusinessSync, readonly teams: TeamDirectory = synchronization.teams) {}
  private localRecords(): BusinessRecord[] {
    const all = this.business.list(), ids = new Set(all.map(record => record.id))
    const names = new Set(componentTypeDefinitions(all).flatMap(type => [type.name, ...type.label]).map(name => name.toLocaleLowerCase()))
    // A durable restore can leave working rows referring to a not-yet-published
    // catalog. Expose its definitions, but never its uncommitted R numbers.
    for (const entry of this.business.store.get<ConfigurationImport[]>('pendingConfigurationImports') || []) for (const record of entry.records) if (record.kind === 'componentType' && !ids.has(record.id)) { all.push(pendingComponentTypeView(record, names)); ids.add(record.id) }
    return all
  }
  private localCatalog(records: BusinessRecord[]): ComponentTypeCatalog {
    const committed = new Set(this.business.list().filter(record => record.kind === 'componentType').map(record => record.id))
    const pending = new Map((this.business.store.get<ConfigurationImport[]>('pendingConfigurationImports') || []).flatMap(entry => entry.records).filter(record => record.kind === 'componentType' && !committed.has(record.id)).map(record => [record.id, record]))
    return { enabled: (this.business.store.get<number>('businessProtocol') || 1) >= 3, types: componentTypeDefinitions(records).map(type => {
      const source = pending.get(type.id)
      if (!source) return type
      const name = String(source.data.name), suffix = type.id.slice(0, 8)
      return { ...type, name, label: [`${name} (pending restore ${suffix})`, `${name}（待恢复 ${suffix}）`], disabled: true, pendingRestore: true }
    }) }
  }
  exportRecords(): BusinessRecord[] { return this.localRecords() }
  catalog(): ComponentTypeCatalog { return safe(() => this.localCatalog(this.localRecords())) }
  workingView(): ConfigurationWorkingView {
    return safe(() => {
      const all = this.localRecords()
      return { records: all.filter(record => !isProtectedKind(record.kind)), catalog: this.localCatalog(all), revisionSummaries: configurationRevisionSummaries(all) }
    })
  }
  history(vehicleId: string): ConfigurationRevisionSummary[] {
    return safe(() => {
      this.vehicle(this.localRecords(), vehicleId, false)
      const all = this.localRecords(); validateConfigurationRecords(all)
      return (all.filter(record => record.kind === 'configurationRevision' && record.vehicleId === vehicleId) as ConfigurationRevisionRecord[]).sort((left, right) => right.data.number - left.data.number).map(record => ({ vehicleId, revisionId: record.id, number: record.data.number, label: record.data.label, publishedAt: record.data.publishedAt, actor: record.data.actor, title: record.data.title, summary: record.data.summary, hasChanges: false }))
    })
  }
  detail(vehicleId: string, revisionId: string): ConfigurationRevisionRecord {
    return safe(() => {
      this.vehicle(this.localRecords(), vehicleId, false)
      const all = this.localRecords(); validateConfigurationRecords(all)
      const record = all.find(row => row.id === revisionId && row.kind === 'configurationRevision' && row.vehicleId === vehicleId)
      if (!record) throw new AppError('RECORD_NOT_FOUND', 404)
      validateConfigurationRevisionRecord(record)
      return record as ConfigurationRevisionRecord
    })
  }
  private vehicle(records: readonly BusinessRecord[], vehicleId: string, writable = true): BusinessRecord {
    this.business.store.assertNotDeleted(vehicleId)
    const vehicle = records.find(record => record.id === vehicleId && record.kind === 'vehicle')
    if (!vehicle) throw new AppError('RECORD_NOT_FOUND', 404)
    if (writable && vehicle.archived) throw new AppError('PARENT_ARCHIVED', 409)
    return vehicle
  }
  private assertContext(context: ConfigurationContext): void { if (context.syncEnabled === false) throw new AppError('CONFIRM_RESUME', 409); context.assertCurrent?.() }
  private actor(context: ConfigurationContext, member: Member): Actor { return { id: member.id, name: member.name, role: member.role, deviceId: context.identity.deviceId } }
  private actorKey(context: ConfigurationContext, actor: Actor): string { return JSON.stringify([context.identity.deviceId, context.identity.localUserId, actor.id]) }
  private previewActorKey(context: ConfigurationContext, actor: Actor): string { return JSON.stringify([this.actorKey(context, actor), context.scopeKey || '']) }
  private assertSettled(vehicleId: string, records: readonly BusinessRecord[]): void {
    const store = this.business.store, ids = new Set(records.filter(record => record.id === vehicleId || record.vehicleId === vehicleId || record.kind === 'componentType').map(record => record.id))
    const pending = store.db.prepare("SELECT payload FROM outbox WHERE state='pending'").all()
    if (pending.some(row => { const operation = JSON.parse(String(row.payload)); return ids.has(operation.recordId) || operation.vehicleId === vehicleId }) || store.db.prepare('SELECT record_id FROM conflicts').all().some(row => ids.has(String(row.record_id))) || (store.get<unknown[]>('pendingConfigurationImports') || []).length) throw new AppError('REVISION_PENDING_CHANGES', 409)
  }
  private sourceGuard(records: readonly BusinessRecord[], vehicleId: string): string {
    const vehicle = this.vehicle(records, vehicleId)
    const components = records.filter(record => record.kind === 'part' && record.vehicleId === vehicleId).sort((left, right) => left.id.localeCompare(right.id))
    const types = records.filter(record => record.kind === 'componentType').sort((left, right) => left.id.localeCompare(right.id))
    const previous = configurationRevisionSummaries(records).find(row => row.vehicleId === vehicleId)
    return checksum(JSON.stringify({ identity: [vehicle.id, vehicle.data.vin, vehicle.archived, vehicle.data.thermal || ''], components, types, previous: previous?.revisionId || null }))
  }
  private async locked<T>(context: ConfigurationContext, admin: boolean, work: (snapshot: SharedBusinessSnapshot, actor: Actor, team: TeamDocument) => Promise<T>, refresh = true): Promise<T> {
    this.assertContext(context)
    try {
      return await this.business.store.withMaintenance(() => this.teams.withAccess(context.directory, context.teamId, context.identity, admin, async (team, member) => {
        this.assertContext(context)
        if (refresh) await this.synchronization.refreshLocked(context.directory, team)
        this.assertContext(context)
        const writer = (destination: string, bytes: Buffer | string) => atomicFile(destination, bytes, path.basename(destination) === 'HEAD.json' ? () => this.assertContext(context) : undefined)
        const snapshot = await SharedBusinessSnapshot.open(this.business, context.directory, context.teamId, writer)
        try { return await work(snapshot, this.actor(context, member), team) } finally { await snapshot.close() }
      }))
    } catch (error) { if (error instanceof AppError) throw error; throw new AppError(error instanceof Error && 'code' in error ? String(error.code) : 'SHARE_IO_ERROR', 409) }
  }
  private requireEnabled(snapshot: SharedBusinessSnapshot): void { if ((snapshot.head?.protocol || 1) < 3) throw new AppError('CONFIGURATION_NOT_ENABLED', 409) }
  private receipt<T>(snapshot: SharedBusinessSnapshot, context: ConfigurationContext, actor: Actor, requestId: string, kind: string, command: unknown): T | null {
    if (!uuid.test(requestId)) throw new AppError('INVALID_INPUT')
    const row = snapshot.db.prepare('SELECT value FROM metadata WHERE key=?').get(`configurationRequest:${requestId}`)
    if (!row) return null
    const stored = JSON.parse(String(row.value)) as StoredReceipt
    if (stored.actorKey !== this.actorKey(context, actor) || stored.kind !== kind || stored.commandDigest !== checksum(JSON.stringify(command))) throw new AppError('REVISION_REQUEST_MISMATCH', 409)
    return stored.receipt as T
  }
  private remember(snapshot: SharedBusinessSnapshot, context: ConfigurationContext, actor: Actor, requestId: string, kind: string, command: unknown, receipt: Record<string, unknown>): void {
    snapshot.db.prepare('INSERT INTO metadata VALUES(?,?)').run(`configurationRequest:${requestId}`, JSON.stringify({ actorKey: this.actorKey(context, actor), commandDigest: checksum(JSON.stringify(command)), kind, receipt }))
  }
  private audit(snapshot: SharedBusinessSnapshot, actor: Actor, record: BusinessRecord | null, action: string, explanation: string, previous: Record<string, unknown> | null = null): void {
    const id = randomUUID(), created = now(), recordId = record?.id || 'configuration-activation'
    const change: Change = { id, recordId, vehicleId: record?.vehicleId || recordId, kind: record?.kind || 'componentType', before: previous, after: record?.data || { enabled: true }, archivedBefore: record ? false : null, archivedAfter: false, actor, reason: explanation, action, sourceId: null, created }
    snapshot.db.prepare('INSERT INTO changes VALUES(?,?,?,?,?)').run(id, recordId, change.vehicleId, JSON.stringify(change), created)
  }
  async enable(context: ConfigurationContext, input: { requestId?: string; reason?: string } = {}): Promise<ComponentTypeCatalog> {
    return this.locked(context, true, async (snapshot, actor) => {
      if ((snapshot.head?.protocol || 1) < 3) {
        const requestId = input.requestId || randomUUID()
        if (!uuid.test(requestId)) throw new AppError('INVALID_INPUT')
        this.assertContext(context)
        snapshot.db.exec('BEGIN IMMEDIATE')
        try { this.audit(snapshot, actor, null, 'configuration.enabled', input.reason ? reason(input.reason) : 'Enabled configuration revisions after upgrading the team'); this.remember(snapshot, context, actor, requestId, 'enable', {}, { requestId, enabled: true }); snapshot.db.exec('COMMIT') } catch (error) { snapshot.db.exec('ROLLBACK'); throw error }
        await snapshot.publish(context.teamId, 3)
      }
      await this.synchronization.ingestLocked(snapshot)
      return { enabled: true, types: componentTypeDefinitions(protectedRecords(snapshot)) }
    })
  }
  async createType(context: ConfigurationContext, input: { name: string; description?: string; requestId?: string; reason?: string }): Promise<ComponentTypeDefinition> {
    const name = normalizedText(input?.name, 120, true), description = normalizedText(input.description || '', 4000), requestId = input.requestId || randomUUID(), explanation = input.reason === undefined ? `Added component type ${name}` : reason(input.reason), command = { name, description, reason: explanation }
    return this.locked(context, true, async (snapshot, actor) => {
      this.requireEnabled(snapshot)
      const existing = this.receipt<{ requestId: string; type: ComponentTypeDefinition }>(snapshot, context, actor, requestId, 'createType', command)
      if (existing) { await this.synchronization.ingestLocked(snapshot); return existing.type }
      const records = protectedRecords(snapshot), id = randomUUID(), created = now(), data: ComponentTypeData = { schema: 1, name, description, disabled: false, definitionVersion: 1 }
      const record: BusinessRecord = { id, kind: 'componentType', vehicleId: null, archived: false, version: 1, updated: created, data }
      const definition = safe(() => componentTypeDefinitions([...records, record]).find(type => type.id === id)!)
      this.assertContext(context)
      snapshot.db.exec('BEGIN IMMEDIATE')
      try {
        snapshot.db.prepare('INSERT INTO records VALUES(?,?,?,?,?,?,?,?)').run(id, record.kind, null, null, JSON.stringify(data), 0, 1, created)
        this.audit(snapshot, actor, record, 'componentType.created', explanation)
        this.remember(snapshot, context, actor, requestId, 'createType', command, { requestId, type: definition })
        snapshot.db.exec('COMMIT')
      } catch (error) { snapshot.db.exec('ROLLBACK'); throw error }
      await snapshot.publish(context.teamId, 3); await this.synchronization.ingestLocked(snapshot)
      return definition
    }, false)
  }
  async updateType(context: ConfigurationContext, id: string, input: { version: number; name: string; description?: string; disabled: boolean; requestId?: string; reason?: string }): Promise<ComponentTypeDefinition> {
    const name = normalizedText(input?.name, 120, true), description = normalizedText(input.description || '', 4000), requestId = input.requestId || randomUUID(), explanation = input.reason === undefined ? `Updated component type ${name}` : reason(input.reason), command = { id, version: input.version, name, description, disabled: input.disabled, reason: explanation }
    if (typeof input.disabled !== 'boolean' || !Number.isSafeInteger(input.version)) throw new AppError('INVALID_INPUT')
    return this.locked(context, true, async (snapshot, actor) => {
      this.requireEnabled(snapshot)
      const existingReceipt = this.receipt<{ requestId: string; type: ComponentTypeDefinition }>(snapshot, context, actor, requestId, 'updateType', command)
      if (existingReceipt) { await this.synchronization.ingestLocked(snapshot); return existingReceipt.type }
      const records = protectedRecords(snapshot), current = records.find(record => record.id === id && record.kind === 'componentType')
      if (!current) throw new AppError('COMPONENT_TYPE_NOT_FOUND', 404)
      if (current.data.definitionVersion !== input.version) { await this.synchronization.ingestLocked(snapshot); throw new AppError('VERSION_CONFLICT', 409) }
      const data: ComponentTypeData = { schema: 1, name, description, disabled: input.disabled, definitionVersion: input.version + 1 }, updated = now(), record = { ...current, data, updated }
      const definition = safe(() => componentTypeDefinitions(records.map(row => row.id === id ? record : row)).find(type => type.id === id)!)
      this.assertContext(context)
      snapshot.db.exec('BEGIN IMMEDIATE')
      try {
        snapshot.db.prepare('UPDATE records SET data=?,version=version+1,updated=? WHERE id=?').run(JSON.stringify(data), updated, id)
        this.audit(snapshot, actor, record, 'componentType.updated', explanation, current.data)
        this.remember(snapshot, context, actor, requestId, 'updateType', command, { requestId, type: definition })
        snapshot.db.exec('COMMIT')
      } catch (error) { snapshot.db.exec('ROLLBACK'); throw error }
      await snapshot.publish(context.teamId, 3); await this.synchronization.ingestLocked(snapshot)
      return definition
    }, false)
  }
  async preview(context: ConfigurationContext, vehicleId: string): Promise<ConfigurationPreview> {
    return this.locked(context, false, async (snapshot, actor) => {
      this.requireEnabled(snapshot)
      const records = protectedRecords(snapshot), vehicle = this.vehicle(records, vehicleId)
      safe(() => validateConfigurationRecords(records)); this.assertSettled(vehicleId, records)
      const previous = configurationRevisionSummaries(records).find(row => row.vehicleId === vehicleId)
      const previousRecord = records.find(row => row.id === previous?.revisionId) as ConfigurationRevisionRecord | undefined
      for (const [key, value] of this.previews) if (value.expires < Date.now()) this.previews.delete(key)
      if (this.previews.size >= 100) this.previews.delete(this.previews.keys().next().value!)
      const token = randomBytes(32).toString('hex'), expires = Date.now() + 15 * 60 * 1000
      this.previews.set(token, { actorKey: this.previewActorKey(context, actor), vehicleId, guard: this.sourceGuard(records, vehicleId), previousRevisionId: previous?.revisionId || null, expires })
      return { token, expires, vehicleId, vin: String(vehicle.data.vin), previousRevisionId: previous?.revisionId || null, previousNumber: previous?.number || 0, sections: configurationSections(records, vehicleId, componentTypeDefinitions(records), previousRecord?.data) }
    })
  }
  async publish(context: ConfigurationContext, vehicleId: string, request: ConfigurationPublishRequest): Promise<ConfigurationPublicationReceipt> {
    if (!request || !uuid.test(request.requestId) || typeof request.previewToken !== 'string' || !plain(request.decisions)) throw new AppError('INVALID_INPUT')
    const title = normalizedText(request.title || '', 120), summary = reason(request.summary), command = { vehicleId, ...request, title, summary }
    return this.locked(context, false, async (snapshot, actor) => {
      this.requireEnabled(snapshot)
      const already = this.receipt<ConfigurationPublicationReceipt>(snapshot, context, actor, request.requestId, 'publish', command)
      if (already) return { ...already, localSynced: await this.synchronization.ingestLocked(snapshot) }
      const preview = this.previews.get(request.previewToken)
      if (!preview || preview.expires < Date.now()) throw new AppError('REVISION_PREVIEW_EXPIRED', 409)
      if (preview.vehicleId !== vehicleId || preview.actorKey !== this.previewActorKey(context, actor)) throw new AppError('REVISION_PREVIEW_CHANGED', 409)
      const records = protectedRecords(snapshot), vehicle = this.vehicle(records, vehicleId)
      safe(() => validateConfigurationRecords(records)); this.assertSettled(vehicleId, records)
      if (this.sourceGuard(records, vehicleId) !== preview.guard) throw new AppError('REVISION_PREVIEW_CHANGED', 409)
      const previous = configurationRevisionSummaries(records).find(row => row.vehicleId === vehicleId)
      if ((previous?.revisionId || null) !== preview.previousRevisionId) throw new AppError('REVISION_PREVIEW_CHANGED', 409)
      const previousRecord = records.find(row => row.id === previous?.revisionId) as ConfigurationRevisionRecord | undefined
      const sections = configurationSections(records, vehicleId, componentTypeDefinitions(records), previousRecord?.data), captured = safe(() => configurationSnapshot(sections, request.decisions))
      const number = (previous?.number || 0) + 1, id = randomUUID(), publishedAt = now(), label = configurationRevisionLabel(number)
      const data: ConfigurationRevisionData = { schema: 1, name: label, vehicleId, vin: String(vehicle.data.vin), number, label, title, summary, publishedAt, actor, previousRevisionId: previous?.revisionId || null, sourceFingerprint: configurationSourceFingerprint(sections), snapshot: captured }
      const record: ConfigurationRevisionRecord = { id, kind: 'configurationRevision', vehicleId, data, archived: false, version: 1, updated: publishedAt }
      safe(() => validateConfigurationRecords([...records, record]))
      const receipt: ConfigurationPublicationReceipt = { requestId: request.requestId, revisionId: id, vehicleId, number, label, publishedAt, localSynced: false }
      this.assertContext(context)
      snapshot.db.exec('BEGIN IMMEDIATE')
      try {
        snapshot.db.prepare('INSERT INTO records VALUES(?,?,?,?,?,?,?,?)').run(id, record.kind, vehicleId, null, JSON.stringify(data), 0, 1, publishedAt)
        this.audit(snapshot, actor, record, 'configuration.published', summary)
        this.remember(snapshot, context, actor, request.requestId, 'publish', command, receipt)
        snapshot.db.exec('COMMIT')
      } catch (error) { snapshot.db.exec('ROLLBACK'); throw error }
      this.assertContext(context)
      await snapshot.publish(context.teamId, 3)
      this.previews.delete(request.previewToken)
      return { ...receipt, localSynced: await this.synchronization.ingestLocked(snapshot) }
    })
  }
}
