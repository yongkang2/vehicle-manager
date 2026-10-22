import express from 'express'
import type { Request, Express, RequestHandler } from 'express'
import multer from 'multer'
import path from 'node:path'
import { AppError, bindingFor, TeamDirectory } from './team.js'
import { Business, reason } from './business.js'
import { BusinessSync } from './sync.js'
import { DoveService, compareReports } from './dove.js'
import { createBackup, restoreBackup } from './backup.js'
import { LocalStore } from './store.js'
import type { Identity, LocalUser, TeamDocument } from '../shared/types.js'
import { configurationFields, controllerRecordId, doveRecordedTime, keyControllerName, validControllerValue, DOVE_BATCH_LIMIT, DOVE_MAX_FILE_BYTES } from '../shared/business.js'
import type { Actor, BusinessRecord, Controller, DoveBatchPreviewResult, DoveBatchSaveResult, Fields, RecordKind, ReportData } from '../shared/business.js'

type Config = { sharedPath: string; teamId: string }
type Context = { actor: Actor; identity: Identity; configuration: Config; online: boolean }
type BusinessRequest = Request & { localUser?: LocalUser; businessContext?: Context }
const recordKinds = ['vehicle', 'part', 'modification', 'equipment', 'report', 'attachment']
export function installBusinessRoutes(app: Express, store: LocalStore, teams: TeamDirectory, cache: (team: TeamDocument) => void) {
  const business = new Business(store), synchronization = new BusinessSync(business, teams), dove = new DoveService(business)
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
    return { actor: { id: member.id, name: member.name, role: member.role, deviceId: store.deviceId }, identity, configuration, online }
  }
  const sync = async (context: Context) => synchronization.synchronize(context.configuration.sharedPath, context.configuration.teamId, context.identity)
  const router = express.Router()
  router.use(async (req: BusinessRequest, res, next) => {
    try {
      req.businessContext = await access(req)
      if (req.method === 'GET' && req.path !== '/sync') {
        const state = await sync(req.businessContext)
        if (state.error === 'ACCESS_DISABLED' || state.error === 'ADMIN_REQUIRED') throw new AppError(state.error, 403)
        res.set('X-Sync-State', state.phase)
      }
      if (['POST', 'PUT', 'DELETE'].includes(req.method)) res.once('finish', () => { if (res.statusCode < 400 && synchronization.status().pending > 0) void sync(req.businessContext!) })
      next()
    } catch (error) { next(error) }
  })
  router.get('/records', (req, res) => {
    const kind = req.query.kind ? String(req.query.kind) : undefined
    if (kind && !recordKinds.includes(kind)) throw new AppError('INVALID_INPUT')
    res.json(business.list(kind as RecordKind | undefined, req.query.vehicleId ? String(req.query.vehicleId) : undefined))
  })
  router.post('/records', (req: BusinessRequest, res) => {
    if (!['vehicle', 'part', 'modification', 'equipment'].includes(req.body?.kind)) throw new AppError('INVALID_INPUT')
    res.status(201).json(business.write({ kind: req.body.kind, vehicleId: req.body.vehicleId || null, data: req.body.data, actor: req.businessContext!.actor, reason: req.body.reason }))
  })
  router.put('/records/:id', (req: BusinessRequest, res) => {
    const current = business.get(String(req.params.id))
    if (['report', 'attachment'].includes(current.kind)) throw new AppError('IMMUTABLE_REPORT', 409)
    res.json(business.write({ id: current.id, kind: current.kind, vehicleId: current.vehicleId, data: req.body.data, version: req.body.version, actor: req.businessContext!.actor, reason: req.body.reason }))
  })
  router.post('/records/:id/archive', async (req: BusinessRequest, res, next) => {
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
  router.get('/audit', (req: BusinessRequest, res) => {
    if (req.businessContext!.actor.role !== 'admin') throw new AppError('ADMIN_REQUIRED', 403)
    const team = store.get<TeamDocument>('cachedTeam')
    res.json(store.db.prepare('SELECT * FROM local_events ORDER BY created DESC,rowid DESC LIMIT 1000').all().map(row => ({ id: row.id, created: row.created, action: row.action, detail: JSON.parse(row.detail as string), actor: team?.members.find(member => member.id === row.actor_id)?.name || store.db.prepare('SELECT display_name FROM accounts WHERE id=?').get(row.actor_id)?.display_name || row.actor_id })))
  })
  router.get('/sync', (req, res) => res.json(synchronization.status()))
  router.post('/sync', async (req: BusinessRequest, res) => res.json(await sync(req.businessContext!)))
  router.post('/sync/:id/resolve', async (req: BusinessRequest, res) => {
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
  router.post('/vehicles/:id/attachments', upload.single('file'), async (req: BusinessRequest, res) => {
    if (!req.file) throw new AppError('FILE_REQUIRED')
    const car = business.get(String(req.params.id))
    if (car.kind !== 'vehicle' || car.archived) throw new AppError('PARENT_ARCHIVED', 409)
    const name = filename(req.file), extension = path.extname(name).toLowerCase(), bytes = req.file.buffer
    const valid = extension === '.xlsx' ? bytes.subarray(0, 4).equals(Buffer.from([80, 75, 3, 4])) : extension === '.xls' ? bytes.subarray(0, 8).equals(Buffer.from([208, 207, 17, 224, 161, 177, 26, 225])) : extension === '.pdf' ? bytes.subarray(0, 5).toString() === '%PDF-' : extension === '.png' ? bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) : ['.jpg', '.jpeg'].includes(extension) && bytes.subarray(0, 3).equals(Buffer.from([255, 216, 255]))
    if (!valid) throw new AppError('FILE_TYPE_NOT_ALLOWED', 422)
    const key = await business.blob(bytes)
    res.status(201).json(business.write({ kind: 'attachment', vehicleId: car.id, data: { name, checksum: key, size: bytes.length, savedAt: new Date().toISOString() }, actor: req.businessContext!.actor, reason: 'Attachment uploaded', internal: true }))
  })
  router.get('/files/:id', async (req: BusinessRequest, res) => {
    const record = business.get(String(req.params.id))
    if (!['report', 'attachment'].includes(record.kind)) throw new AppError('INVALID_INPUT')
    const bytes = await business.readBlob(String(record.data.checksum))
    store.event(req.businessContext!.actor.id, 'file.downloaded', { recordId: record.id })
    res.attachment(String(record.data.name)).type('application/octet-stream').send(bytes)
  })
  router.post('/dove/preview', upload.single('file'), async (req: BusinessRequest, res) => {
    if (!req.file) throw new AppError('FILE_REQUIRED')
    await sync(req.businessContext!)
    res.json(await dove.preview(req.file.buffer, filename(req.file), req.localUser!.id))
  })
  router.post('/dove/save', async (req: BusinessRequest, res) => {
    await sync(req.businessContext!)
    res.status(201).json(await dove.save(String(req.body?.draftId || ''), req.localUser!.id, req.businessContext!.actor, req.body?.confirmation))
  })
  router.post('/dove/preview-batch', batchFiles, async (req: BusinessRequest, res) => {
    const files = req.files as Express.Multer.File[] | undefined
    if (!files?.length) throw new AppError('FILE_REQUIRED')
    await sync(req.businessContext!)
    const results: DoveBatchPreviewResult[] = []
    for (const [index, file] of files.entries()) {
      const name = filename(file)
      try { results.push({ index, filename: name, preview: await dove.preview(file.buffer, name, req.localUser!.id) }) }
      catch (error) { results.push({ index, filename: name, error: error instanceof AppError ? error.code : 'DOVE_PARSE_FAILED' }) }
    }
    res.json(results)
  })
  router.post('/dove/save-batch', async (req: BusinessRequest, res) => {
    const draftIds: unknown = req.body?.draftIds
    if (!Array.isArray(draftIds) || !draftIds.length || draftIds.length > DOVE_BATCH_LIMIT || draftIds.some(id => typeof id !== 'string' || !id.trim()) || new Set(draftIds).size !== draftIds.length) throw new AppError('INVALID_INPUT')
    await sync(req.businessContext!)
    const results: DoveBatchSaveResult[] = []
    for (const draftId of draftIds as string[]) {
      try { results.push({ draftId, record: await dove.save(draftId, req.localUser!.id, req.businessContext!.actor, req.body?.confirmations?.[draftId]) }) }
      catch (error) { results.push({ draftId, error: error instanceof AppError ? error.code : 'DOVE_PARSE_FAILED' }) }
    }
    res.status(201).json(results)
  })
  router.get('/reports/compare', (req, res) => res.json(compareReports(business.get(String(req.query.left || '')), business.get(String(req.query.right || '')))))
  router.post('/reports/:id/configuration', (req: BusinessRequest, res) => {
    const report = business.get(String(req.params.id)), explanation = reason(req.body?.reason)
    if (report.kind !== 'report' || report.archived || report.version !== req.body.reportVersion) throw new AppError('VERSION_CONFLICT', 409)
    const selections = req.body?.selections as { controllerIndex: number; partId: string | null; version?: number; fields: string[] }[]
    if (!Array.isArray(selections) || !selections.length || selections.length > 100 || selections.some(item => !item || typeof item !== 'object')) throw new AppError('INVALID_INPUT')
    const targets = selections.map(item => item.partId || `new:${item.controllerIndex}`)
    if (new Set(targets).size !== targets.length) throw new AppError('INVALID_INPUT')
    const parsed = (report.data as unknown as ReportData).parsed, updated: BusinessRecord[] = []
    if (business.get(report.vehicleId!).data.vin !== parsed.vin) throw new AppError('REPORT_VIN_MISMATCH', 409)
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
        updated.push(business.write({ id: part?.id || controllerRecordId(report.vehicleId!, name), version: part ? selection.version : undefined, kind: 'part', vehicleId: report.vehicleId, data, actor: req.businessContext!.actor, reason: explanation, sourceId: report.id }))
      }
    })
    res.json(updated)
  })
  router.get('/export', (req: BusinessRequest, res) => {
    store.event(req.businessContext!.actor.id, 'business.exported', {})
    res.attachment('vehicle-data.json').json({ exportedAt: new Date().toISOString(), records: business.list() })
  })
  router.get('/backup', async (req: BusinessRequest, res) => {
    const context = await access(req, true)
    const bytes = await teams.withAccess(context.configuration.sharedPath, context.configuration.teamId, context.identity, true, async team => createBackup(business, context.configuration.teamId, team))
    store.event(context.actor.id, 'backup.created', {})
    res.attachment(`vehicle-backup-${new Date().toISOString().slice(0, 10)}.zip`).type('application/zip').send(bytes)
  })
  const backupUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 200 * 1024 * 1024, files: 1, fields: 3 } })
  router.post('/restore', backupUpload.single('file'), async (req: BusinessRequest, res) => {
    if (!req.file || req.body?.confirmation !== 'RESTORE') throw new AppError('RESTORE_CONFIRMATION_REQUIRED')
    const context = await access(req, true), explanation = reason(req.body.reason)
    const changed = await teams.withAccess(context.configuration.sharedPath, context.configuration.teamId, context.identity, true, async () => restoreBackup(business, req.file!.buffer, context.configuration.teamId, context.actor, explanation))
    res.json({ changed })
  })
  app.use('/api/business', router)
  async function tick() {
    const configuration = store.get<Config>('configuration')
    if (!configuration) return
    try {
      const team = await teams.read(configuration.sharedPath, configuration.teamId); cache(team)
      const binding = team.bindings.find(item => item.deviceId === store.deviceId && item.enabled && team.members.some(member => member.id === item.memberId && member.enabled) && store.db.prepare('SELECT id FROM accounts WHERE id=?').get(item.localUserId))
      if (binding) await synchronization.synchronize(configuration.sharedPath, configuration.teamId, { deviceId: store.deviceId, deviceName: store.deviceName, localUserId: binding.localUserId, displayName: '' })
    } catch { return }
  }
  return { business, synchronization, tick }
}
