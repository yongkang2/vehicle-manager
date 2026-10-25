import express from 'express'
import type { Request, RequestHandler } from 'express'
import multer from 'multer'
import path from 'node:path'
import { AppError, bindingFor, TeamDirectory } from './team.js'
import { Business, reason, validateManualPartFields } from './business.js'
import { BusinessSync } from './sync.js'
import { DoveService, compareReports } from './dove.js'
import { createBackup, restoreBackup } from './backup.js'
import { LocalStore } from './store.js'
import { buildCsvExport } from './csv-export.js'
import { ExportTemplates } from './export-templates.js'
import { VehicleTablePreferencesStore } from './vehicle-table-preferences.js'
import { VehiclePhotos } from './vehicle-photos.js'
import { MAX_EXPORT_ID_LENGTH, MAX_EXPORT_VEHICLES, matchesExportVehicle, parseExportConfiguration } from '../shared/csv-export.js'
import type { Identity, LocalUser, TeamDocument } from '../shared/types.js'
import { configurationFields, controllerRecordId, doveRecordedTime, keyControllerName, reportMatchesVehicle, validControllerValue, DOVE_BATCH_LIMIT, DOVE_MAX_FILE_BYTES } from '../shared/business.js'
import type { Actor, BusinessRecord, Controller, DoveBatchPreviewResult, DoveBatchSaveResult, Fields, RecordKind, ReportData, VehicleDeleteRequest } from '../shared/business.js'

type Config = { sharedPath: string; teamId: string }
type Context = { actor: Actor; identity: Identity; configuration: Config; online: boolean; syncEnabled: boolean }
type BusinessRequest = Request & { localUser?: LocalUser; sessionToken?: string; businessContext?: Context; syncEnabled?: boolean }
const recordKinds = ['vehicle', 'part', 'modification', 'equipment', 'report', 'attachment']
export function installBusinessRoutes(app: Pick<express.Router, 'use'>, store: LocalStore, teams: TeamDirectory, cache: (team: TeamDocument) => void, accounts = store, backgroundSyncAllowed = () => true) {
  const business = new Business(store), synchronization = new BusinessSync(business, teams), dove = new DoveService(business), exportTemplates = new ExportTemplates(store)
  const tablePreferences = new VehicleTablePreferencesStore(store), photos = new VehiclePhotos(business)
  function sessionGuard(req: BusinessRequest): () => void {
    const current = () => accounts.db.prepare('SELECT workspace_id,workspace_epoch FROM sessions WHERE token=? AND user_id=? AND expires>?').get(req.sessionToken || '', req.localUser!.id, Date.now()) as { workspace_id: string | null; workspace_epoch: number } | undefined
    const before = current()
    if (!before) throw new AppError('LOGIN_REQUIRED', 401)
    return () => {
      const after = current()
      if (!after) throw new AppError('LOGIN_REQUIRED', 401)
      if (after.workspace_id !== before.workspace_id || after.workspace_epoch !== before.workspace_epoch) throw new AppError('WORKSPACE_CHANGED', 409)
    }
  }
  async function access(req: BusinessRequest, admin = false): Promise<Context> {
    const configuration = store.get<Config>('configuration')
    if (!configuration) throw new AppError('NOT_CONFIGURED', 409)
    const identity: Identity = { deviceId: store.deviceId, deviceName: store.deviceName, localUserId: req.localUser!.id, displayName: req.localUser!.displayName }
    let team: TeamDocument | null = null, online = false
    try { team = await teams.read(configuration.sharedPath, configuration.teamId); cache(team); online = true }
    catch (error) {
      if (admin || !(error instanceof AppError) || !['SHARE_UNAVAILABLE', 'SHARE_IO_ERROR', 'SHARE_ACCESS_DENIED'].includes(error.code)) throw error
      team = store.get<TeamDocument>('cachedTeam')
    }
    const { member, binding } = team ? bindingFor(team, identity) : {}
    if (!member?.enabled || !binding?.enabled) throw new AppError('ACCESS_DISABLED', 403)
    if (admin && member.role !== 'admin') throw new AppError('ADMIN_REQUIRED', 403)
    return { actor: { id: member.id, name: member.name, role: member.role, deviceId: store.deviceId }, identity, configuration, online, syncEnabled: req.syncEnabled !== false }
  }
  function finalAccess(req: BusinessRequest, res: express.Response): () => Promise<Actor> {
    const assertSession = sessionGuard(req)
    return async () => {
      assertSession()
      const context = await access(req)
      assertSession()
      if (res.destroyed) throw new AppError('REQUEST_CANCELLED', 409)
      return context.actor
    }
  }
  const sync = async (context: Context) => context.syncEnabled ? synchronization.synchronize(context.configuration.sharedPath, context.configuration.teamId, context.identity) : synchronization.status()
  const router = express.Router()
  function writeRoute(method: 'post' | 'put' | 'get' | 'delete', route: string, ...handlers: RequestHandler[]) {
    const action = handlers.pop()!
    router[method](route, ...handlers, (req, res, next) => {
      void store.runWrite(() => action(req, res, next)).catch(next)
    })
  }
  router.use(async (req: BusinessRequest, res, next) => {
    try {
      // An aborted connection must not hide access/cache work from switch/close.
      await store.runWrite(async () => {
        req.businessContext = await access(req)
        const localPath = req.path.toLowerCase()
        const localExport = localPath.startsWith('/export/') || localPath === '/export-templates' || localPath.startsWith('/export-templates/') || localPath === '/vehicle-table-preferences' || localPath === '/vehicle-table-preferences/'
        const photoRead = req.method === 'GET' && /^\/vehicles\/[^/]+\/photo\/?$/.test(localPath)
        const localDraftBinding = req.method === 'POST' && /^\/dove\/[^/]+\/vehicle\/?$/.test(localPath)
        const deletePreview = req.method === 'GET' && /^\/vehicles\/[^/]+\/delete-preview$/.test(req.path)
        const canonicalMaintenance = deletePreview || (req.method === 'DELETE' && /^\/vehicles\/[^/]+$/.test(req.path)) || (req.method === 'POST' && req.path === '/restore')
        if (!req.businessContext.syncEnabled && (canonicalMaintenance || (req.method !== 'GET' && req.path.startsWith('/sync')))) throw new AppError('CONFIRM_RESUME', 409)
        if (req.method === 'GET' && req.path !== '/sync' && !deletePreview && !localExport && !photoRead) {
          const state = await sync(req.businessContext)
          if (state.error === 'ACCESS_DISABLED' || state.error === 'ADMIN_REQUIRED') throw new AppError(state.error, 403)
          res.set('X-Sync-State', state.phase)
        }
        if (!localExport && !localDraftBinding && ['POST', 'PUT', 'DELETE'].includes(req.method)) res.once('finish', () => {
          // An admitted upload may finish its HTTP response after shutdown has
          // drained its write. Do not reopen synchronization on a closing store.
          if (res.statusCode < 400 && backgroundSyncAllowed() && store.db.isOpen && synchronization.status().pending > 0) void sync(req.businessContext!)
        })
      })
      // Maintenance handlers must start outside the normal-write context.
      next()
    } catch (error) { next(error) }
  })
  router.get('/records', (req, res) => {
    const kind = req.query.kind ? String(req.query.kind) : undefined
    if (kind && !recordKinds.includes(kind)) throw new AppError('INVALID_INPUT')
    res.json(business.list(kind as RecordKind | undefined, req.query.vehicleId ? String(req.query.vehicleId) : undefined))
  })
  writeRoute('post', '/records', (req: BusinessRequest, res) => {
    if (!['vehicle', 'part', 'modification', 'equipment'].includes(req.body?.kind)) throw new AppError('INVALID_INPUT')
    validateManualPartFields(req.body.kind, req.body.data)
    res.status(201).json(business.write({ kind: req.body.kind, vehicleId: req.body.vehicleId || null, data: req.body.data, actor: req.businessContext!.actor, reason: req.body.reason }))
  })
  writeRoute('put', '/records/:id', (req: BusinessRequest, res) => {
    const current = business.get(String(req.params.id))
    if (['report', 'attachment'].includes(current.kind)) throw new AppError('IMMUTABLE_REPORT', 409)
    validateManualPartFields(current.kind, req.body.data, current)
    res.json(business.write({ id: current.id, kind: current.kind, vehicleId: current.vehicleId, data: req.body.data, version: req.body.version, actor: req.businessContext!.actor, reason: req.body.reason }))
  })
  writeRoute('post', '/records/:id/archive', async (req: BusinessRequest, res, next) => {
    try {
      if (typeof req.body?.archived !== 'boolean') throw new AppError('INVALID_INPUT')
      const context = await access(req, true)
      const record = await teams.withAccess(context.configuration.sharedPath, context.configuration.teamId, context.identity, true, async (_, member) => {
        const current = business.get(String(req.params.id))
        return business.write({ id: current.id, kind: current.kind, vehicleId: current.vehicleId, data: current.data, version: req.body.version, archived: req.body.archived, actor: { ...context.actor, role: member.role }, reason: req.body.reason, internal: ['report', 'attachment'].includes(current.kind) })
      })
      res.json(record)
    } catch (error) { next(error) }
  })
  router.get('/history', (req, res) => res.json(business.history(req.query.vehicleId ? String(req.query.vehicleId) : undefined)))
  router.get('/vehicles/:id/delete-preview', async (req: BusinessRequest, res) => {
    const context = await store.runWrite(() => access(req, true))
    res.json(await synchronization.deletePreview(context.configuration.sharedPath, context.configuration.teamId, context.identity, context.actor, String(req.params.id)))
  })
  router.delete('/vehicles/:id', async (req: BusinessRequest, res) => {
    const context = await store.runWrite(() => access(req, true))
    res.json(await synchronization.deleteVehicle(context.configuration.sharedPath, context.configuration.teamId, context.identity, context.actor, String(req.params.id), req.body as VehicleDeleteRequest))
  })
  router.get('/audit', (req: BusinessRequest, res) => {
    if (req.businessContext!.actor.role !== 'admin') throw new AppError('ADMIN_REQUIRED', 403)
    const team = store.get<TeamDocument>('cachedTeam')
    res.json(store.db.prepare('SELECT * FROM local_events ORDER BY created DESC,rowid DESC LIMIT 1000').all().map(row => ({ id: row.id, created: row.created, action: row.action, detail: JSON.parse(row.detail as string), actor: team?.members.find(member => member.id === row.actor_id)?.name || accounts.db.prepare('SELECT display_name FROM accounts WHERE id=?').get(row.actor_id)?.display_name || row.actor_id })))
  })
  router.get('/sync', (req, res) => res.json(synchronization.status()))
  router.get('/sync/quarantined', (req, res) => res.json(store.quarantineRows()))
  router.get('/sync/quarantined/export', (req, res) => res.attachment('quarantined-operations.json').json({ exportedAt: new Date().toISOString(), operations: store.quarantineRows() }))
  writeRoute('post', '/sync', async (req: BusinessRequest, res) => res.json(await sync(req.businessContext!)))
  writeRoute('post', '/sync/:id/resolve', async (req: BusinessRequest, res) => {
    const context = req.businessContext!
    if (typeof req.body.token !== 'string' || !req.body.choices || typeof req.body.choices !== 'object') throw new AppError('INVALID_INPUT')
    res.json(await synchronization.resolve(context.configuration.sharedPath, context.configuration.teamId, context.identity, context.actor, String(req.params.id), req.body.token, req.body.choices, reason(req.body.reason)))
  })
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: DOVE_MAX_FILE_BYTES, files: 1, fields: 4 } })
  const batchUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: DOVE_MAX_FILE_BYTES, files: DOVE_BATCH_LIMIT, fields: 4 } }).array('files', DOVE_BATCH_LIMIT)
  const batchFiles: RequestHandler = (req, res, next) => batchUpload(req, res, error => {
    if (error instanceof multer.MulterError && (error.code === 'LIMIT_FILE_COUNT' || (error.code === 'LIMIT_UNEXPECTED_FILE' && error.field === 'files'))) return next(new AppError('DOVE_BATCH_LIMIT'))
    if (error instanceof multer.MulterError && error.code !== 'LIMIT_FILE_SIZE') return next(new AppError('INVALID_INPUT'))
    next(error)
  })
  const filename = (file: Express.Multer.File) => {
    const decoded = Buffer.from(file.originalname, 'latin1').toString('utf8')
    return path.basename(decoded.includes('\ufffd') ? file.originalname : decoded).slice(0, 240)
  }
  writeRoute('get', '/vehicles/:id/photo', async (req: BusinessRequest, res) => {
    const assertSession = sessionGuard(req)
    const photo = await photos.read(String(req.params.id), async () => {
      assertSession()
      await access(req)
      assertSession()
      if (res.destroyed) throw new AppError('REQUEST_CANCELLED', 409)
    })
    res.set('Content-Disposition', 'inline').type(photo.mime).send(photo.bytes)
  })
  writeRoute('post', '/vehicles/:id/photo', upload.single('file'), async (req: BusinessRequest, res) => {
    if (!req.file) throw new AppError('FILE_REQUIRED')
    if (Object.keys(req.body || {}).some(key => !['version', 'reason'].includes(key)) || typeof req.body.version !== 'string' || !/^[1-9]\d*$/.test(req.body.version) || !Number.isSafeInteger(Number(req.body.version))) throw new AppError('INVALID_INPUT')
    const assertSession = sessionGuard(req)
    const result = await photos.upload(String(req.params.id), { name: filename(req.file), bytes: req.file.buffer }, Number(req.body.version), req.body.reason, req.businessContext!.actor, async () => {
      assertSession()
      const context = await access(req)
      assertSession()
      if (res.destroyed) throw new AppError('REQUEST_CANCELLED', 409)
      return context.actor
    })
    res.status(201).json(result)
  })
  writeRoute('delete', '/vehicles/:id/photo', async (req: BusinessRequest, res) => {
    if (!req.body || Object.keys(req.body).some(key => !['version', 'reason'].includes(key)) || !Number.isSafeInteger(req.body.version) || req.body.version < 1) throw new AppError('INVALID_INPUT')
    const assertSession = sessionGuard(req)
    const context = await access(req)
    assertSession()
    if (res.destroyed) throw new AppError('REQUEST_CANCELLED', 409)
    res.json(photos.remove(String(req.params.id), req.body.version, req.body.reason, context.actor))
  })
  writeRoute('post', '/vehicles/:id/attachments', upload.single('file'), async (req: BusinessRequest, res) => {
    if (!req.file) throw new AppError('FILE_REQUIRED')
    const car = business.get(String(req.params.id))
    if (car.kind !== 'vehicle' || car.archived) throw new AppError('PARENT_ARCHIVED', 409)
    const name = filename(req.file), extension = path.extname(name).toLowerCase(), bytes = req.file.buffer
    const valid = extension === '.xlsx' ? bytes.subarray(0, 4).equals(Buffer.from([80, 75, 3, 4])) : extension === '.xls' ? bytes.subarray(0, 8).equals(Buffer.from([208, 207, 17, 224, 161, 177, 26, 225])) : extension === '.pdf' ? bytes.subarray(0, 5).toString() === '%PDF-' : extension === '.png' ? bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) : ['.jpg', '.jpeg'].includes(extension) && bytes.subarray(0, 3).equals(Buffer.from([255, 216, 255]))
    if (!valid) throw new AppError('FILE_TYPE_NOT_ALLOWED', 422)
    const key = await business.blob(bytes)
    res.status(201).json(business.write({ kind: 'attachment', vehicleId: car.id, data: { name, checksum: key, size: bytes.length, savedAt: new Date().toISOString() }, actor: req.businessContext!.actor, reason: 'Attachment uploaded', internal: true }))
  })
  writeRoute('get', '/files/:id', async (req: BusinessRequest, res) => {
    const record = business.get(String(req.params.id))
    if (!['report', 'attachment'].includes(record.kind)) throw new AppError('INVALID_INPUT')
    const bytes = await business.readBlob(String(record.data.checksum))
    store.event(req.businessContext!.actor.id, 'file.downloaded', { recordId: record.id })
    res.attachment(String(record.data.name)).type('application/octet-stream').send(bytes)
  })
  writeRoute('post', '/dove/preview', upload.single('file'), async (req: BusinessRequest, res) => {
    if (!req.file) throw new AppError('FILE_REQUIRED')
    const verify = finalAccess(req, res)
    await sync(req.businessContext!)
    await verify()
    const preview = await dove.preview(req.file.buffer, filename(req.file), req.localUser!.id)
    await verify()
    res.json(preview)
  })
  writeRoute('post', '/dove/:draftId/vehicle', async (req: BusinessRequest, res) => {
    if (!req.body || Array.isArray(req.body) || Object.keys(req.body).some(key => !['vehicleId', 'expectedVin'].includes(key)) || typeof req.body.vehicleId !== 'string' || typeof req.body.expectedVin !== 'string') throw new AppError('INVALID_INPUT')
    await finalAccess(req, res)()
    res.json(dove.bind(String(req.params.draftId), req.localUser!.id, req.body.vehicleId, req.body.expectedVin))
  })
  writeRoute('post', '/dove/save', async (req: BusinessRequest, res) => {
    const verify = finalAccess(req, res)
    await sync(req.businessContext!)
    const actor = await verify()
    res.status(201).json(await dove.save(String(req.body?.draftId || ''), req.localUser!.id, actor, req.body?.confirmation, verify))
  })
  writeRoute('post', '/dove/preview-batch', batchFiles, async (req: BusinessRequest, res) => {
    const files = req.files as Express.Multer.File[] | undefined
    if (!files?.length) throw new AppError('FILE_REQUIRED')
    const verify = finalAccess(req, res)
    await sync(req.businessContext!)
    const results: DoveBatchPreviewResult[] = []
    for (const [index, file] of files.entries()) {
      const name = filename(file)
      try {
        await verify()
        const preview = await dove.preview(file.buffer, name, req.localUser!.id)
        await verify()
        results.push({ index, filename: name, preview })
      }
      catch (error) { results.push({ index, filename: name, error: error instanceof AppError ? error.code : 'DOVE_PARSE_FAILED' }) }
    }
    res.json(results)
  })
  writeRoute('post', '/dove/save-batch', async (req: BusinessRequest, res) => {
    const draftIds: unknown = req.body?.draftIds
    if (!Array.isArray(draftIds) || !draftIds.length || draftIds.length > DOVE_BATCH_LIMIT || draftIds.some(id => typeof id !== 'string' || !id.trim()) || new Set(draftIds).size !== draftIds.length) throw new AppError('INVALID_INPUT')
    const verify = finalAccess(req, res)
    await sync(req.businessContext!)
    const results: DoveBatchSaveResult[] = []
    for (const draftId of draftIds as string[]) {
      try { results.push({ draftId, record: await dove.save(draftId, req.localUser!.id, await verify(), req.body?.confirmations?.[draftId], verify) }) }
      catch (error) { results.push({ draftId, error: error instanceof AppError ? error.code : 'DOVE_PARSE_FAILED' }) }
    }
    res.status(201).json(results)
  })
  router.get('/reports/compare', (req, res) => res.json(compareReports(business.get(String(req.query.left || '')), business.get(String(req.query.right || '')))))
  writeRoute('post', '/reports/:id/configuration', async (req: BusinessRequest, res) => {
    const actor = await finalAccess(req, res)()
    const report = business.get(String(req.params.id)), explanation = reason(req.body?.reason)
    if (report.kind !== 'report' || report.archived || report.version !== req.body.reportVersion) throw new AppError('VERSION_CONFLICT', 409)
    const selections = req.body?.selections as { controllerIndex: number; partId: string | null; version?: number; fields: string[] }[]
    if (!Array.isArray(selections) || !selections.length || selections.length > 100 || selections.some(item => !item || typeof item !== 'object')) throw new AppError('INVALID_INPUT')
    const targets = selections.map(item => item.partId || `new:${item.controllerIndex}`)
    if (new Set(targets).size !== targets.length) throw new AppError('INVALID_INPUT')
    const parsed = (report.data as unknown as ReportData).parsed, updated: BusinessRecord[] = []
    if (!reportMatchesVehicle(report, business.get(report.vehicleId!))) throw new AppError('REPORT_VIN_MISMATCH', 409)
    store.transaction(() => {
      for (const selection of selections) {
        const controller = Number.isInteger(selection.controllerIndex) ? parsed.controllers[selection.controllerIndex] : undefined
        if (!controller || !Array.isArray(selection.fields) || !selection.fields.length || selection.fields.some(field => !configurationFields.includes(field as typeof configurationFields[number]) || !validControllerValue(controller[field as keyof Controller]))) throw new AppError('INVALID_COMPONENT_MATCH', 409)
        const name = keyControllerName(controller.name)
        if (!name) throw new AppError('INVALID_COMPONENT_MATCH', 409)
        const part = selection.partId ? business.get(selection.partId) : null
        if (part && (part.kind !== 'part' || part.vehicleId !== report.vehicleId || part.data.category !== 'controller' || part.archived || part.data.removedAt || (name && keyControllerName(part.data.name) !== name))) throw new AppError('INVALID_COMPONENT_MATCH', 409)
        if (!part && business.list('part', report.vehicleId!).some(item => !item.archived && item.data.category === 'controller' && keyControllerName(item.data.name) === name)) throw new AppError('VERSION_CONFLICT', 409)
        if (part && doveRecordedTime(parsed.recordedAt) < doveRecordedTime(part.data.reportRecordedAt) && req.body?.allowOlder !== true) throw new AppError('OLDER_REPORT_CONFIRMATION_REQUIRED', 409)
        const data: Fields = { ...(part?.data || { name, category: 'controller' }), sourceName: controller.name, reportId: report.id, reportRecordedAt: parsed.recordedAt }
        if (name) data.name = name
        for (const field of selection.fields) data[field] = controller[field as keyof Controller]
        updated.push(business.write({ id: part?.id || controllerRecordId(report.vehicleId!, name), version: part ? selection.version : undefined, kind: 'part', vehicleId: report.vehicleId, data, actor, reason: explanation, sourceId: report.id }))
      }
    })
    res.json(updated)
  })
  router.get('/export', (req: BusinessRequest, res) => {
    store.event(req.businessContext!.actor.id, 'business.exported', {})
    res.attachment('vehicle-data.json').json({ exportedAt: new Date().toISOString(), records: business.list() })
  })
  writeRoute('get', '/export/records', (_req, res) => res.json(business.list()))
  writeRoute('post', '/export/csv', async (req: BusinessRequest, res) => {
    const input = req.body
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['vehicleIds', 'configuration'].includes(key))) throw new AppError('INVALID_INPUT')
    const configuration = parseExportConfiguration(input.configuration)
    if (!configuration || !Array.isArray(input.vehicleIds) || !input.vehicleIds.length || input.vehicleIds.length > MAX_EXPORT_VEHICLES || input.vehicleIds.some((id: unknown) => typeof id !== 'string' || !id || id.length > MAX_EXPORT_ID_LENGTH) || new Set(input.vehicleIds).size !== input.vehicleIds.length) throw new AppError('INVALID_INPUT')
    const vehicleIds = input.vehicleIds as string[]
    const currentSession = () => accounts.db.prepare('SELECT workspace_id,workspace_epoch FROM sessions WHERE token=? AND user_id=? AND expires>?').get(req.sessionToken || '', req.localUser!.id, Date.now()) as { workspace_id: string; workspace_epoch: number } | undefined
    const sessionBefore = currentSession()
    if (!sessionBefore) throw new AppError('LOGIN_REQUIRED', 401)
    // Capture once before asynchronous ZIP creation; never resolve selected VINs.
    const { bytes, counts } = await buildCsvExport(business.list(), { vehicleIds, configuration })
    if (res.destroyed) return
    const sessionAfter = currentSession()
    if (!sessionAfter) throw new AppError('LOGIN_REQUIRED', 401)
    if (sessionAfter.workspace_id !== sessionBefore.workspace_id || sessionAfter.workspace_epoch !== sessionBefore.workspace_epoch) throw new AppError('WORKSPACE_CHANGED', 409)
    // Data remains from the captured snapshot, but a deletion, archive or filter-changing
    // write during ZIP creation must require a fresh selection rather than return stale matches.
    const currentVehicles = new Map(business.list('vehicle').map(record => [record.id, record]))
    if (vehicleIds.some(id => { const current = currentVehicles.get(id); return !current || !matchesExportVehicle(current, configuration) })) throw new AppError('EXPORT_SELECTION_CHANGED', 409)
    store.event(req.businessContext!.actor.id, 'business.exported', { format: 'csv', vehicles: vehicleIds.length, columns: configuration.columns, counts, language: configuration.language })
    res.attachment(`vehicle-data-${new Date().toISOString().slice(0, 10)}.zip`).type('application/zip').send(bytes)
  })
  writeRoute('get', '/export-templates', (req: BusinessRequest, res) => res.json(exportTemplates.list(req.localUser!.id)))
  writeRoute('get', '/vehicle-table-preferences', (req: BusinessRequest, res) => {
    sessionGuard(req)()
    res.json(tablePreferences.get(req.localUser!.id))
  })
  writeRoute('put', '/vehicle-table-preferences', (req: BusinessRequest, res) => {
    sessionGuard(req)()
    res.json(tablePreferences.put(req.localUser!.id, req.body))
  })
  writeRoute('post', '/export-templates', (req: BusinessRequest, res) => res.status(201).json(exportTemplates.create(req.localUser!.id, req.body)))
  writeRoute('put', '/export-templates/:id', (req: BusinessRequest, res) => res.json(exportTemplates.update(req.localUser!.id, String(req.params.id), req.body)))
  writeRoute('delete', '/export-templates/:id', (req: BusinessRequest, res) => {
    exportTemplates.remove(req.localUser!.id, String(req.params.id))
    res.json({ ok: true })
  })
  writeRoute('get', '/backup', async (req: BusinessRequest, res) => {
    const context = await access(req, true)
    const bytes = await teams.withAccess(context.configuration.sharedPath, context.configuration.teamId, context.identity, true, async team => createBackup(business, context.configuration.teamId, team))
    store.event(context.actor.id, 'backup.created', {})
    res.attachment(`vehicle-backup-${new Date().toISOString().slice(0, 10)}.zip`).type('application/zip').send(bytes)
  })
  const backupUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 200 * 1024 * 1024, files: 1, fields: 3 } })
  router.post('/restore', backupUpload.single('file'), async (req: BusinessRequest, res) => {
    if (!req.file || req.body?.confirmation !== 'RESTORE') throw new AppError('RESTORE_CONFIRMATION_REQUIRED')
    const context = await store.runWrite(() => access(req, true)), explanation = reason(req.body.reason)
    const result = await store.withMaintenance(() => teams.withAccess(context.configuration.sharedPath, context.configuration.teamId, context.identity, true, async (team, member) => {
      const state = await synchronization.refreshLocked(context.configuration.sharedPath, team)
      if (state.error) throw new AppError(state.error, 409)
      const restored = await restoreBackup(business, req.file!.buffer, context.configuration.teamId, { ...context.actor, role: member.role }, explanation)
      // Publish imported deletion markers before releasing the same canonical lock.
      // If publication fails, the durable import queue and ordinary outbox retry it.
      try {
        const current = await synchronization.refreshLocked(context.configuration.sharedPath, team)
        return { ...restored, ...(current.error ? { syncError: current.error } : {}) }
      } catch (error) { return { ...restored, syncError: error instanceof AppError ? error.code : 'SHARE_IO_ERROR' } }
    }))
    res.json(result)
  })
  app.use('/api/business', router)
  async function tick() {
    const configuration = store.get<Config>('configuration')
    if (!configuration) return
    try {
      const team = await teams.read(configuration.sharedPath, configuration.teamId); cache(team)
      const binding = team.bindings.find(item => item.deviceId === store.deviceId && item.enabled && team.members.some(member => member.id === item.memberId && member.enabled) && accounts.db.prepare('SELECT 1 FROM sessions WHERE user_id=? AND workspace_id=? AND sync_enabled=1 AND expires>?').get(item.localUserId, configuration.teamId, Date.now()))
      if (binding) await synchronization.synchronize(configuration.sharedPath, configuration.teamId, { deviceId: store.deviceId, deviceName: store.deviceName, localUserId: binding.localUserId, displayName: '' })
    } catch { return }
  }
  return { business, synchronization, tick }
}
