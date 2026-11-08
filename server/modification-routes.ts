import type express from 'express'
import multer from 'multer'
import { AppError } from './team.js'
import { Modifications } from './modifications.js'
import type { ModificationContext } from './modifications.js'
import { MODIFICATION_MAX_FILE_BYTES } from '../shared/modifications.js'

type ContextFactory = (req: express.Request, res: express.Response, admin?: boolean) => Promise<ModificationContext>
/** No outer runWrite around canonical actions: their maintenance gate must drain other writes. */
export function installModificationRoutes(router: express.Router, modifications: Modifications, context: ContextFactory): void {
  router.get('/modifications/status', async (req, res) => {
    const active = await context(req, res)
    active.assertCurrent?.()
    res.json({ enabled: (modifications.business.store.get<number>('businessProtocol') || 1) >= 5 })
  })
  router.post('/modifications/enable', async (req, res) => res.json(await modifications.enable(await context(req, res, true), req.body)))
  router.get('/modifications/:id', async (req, res) => {
    const active = await context(req, res)
    active.assertCurrent?.()
    res.json(modifications.detail(String(req.params.id)))
  })
  router.put('/modifications/:id', async (req, res) => res.json(await modifications.edit(String(req.params.id), req.body, await context(req, res))))
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MODIFICATION_MAX_FILE_BYTES, files: 1, fields: 4 } })
  router.post('/modifications/:id/files', upload.single('file'), async (req, res) => {
    if (!req.file) throw new AppError('FILE_REQUIRED')
    const fields = req.body || {}, version = Number(fields.version), groupVersion = fields.groupVersion === undefined || fields.groupVersion === '' || fields.groupVersion === 'null' ? null : Number(fields.groupVersion)
    if (Object.keys(fields).some(field => !['version', 'groupVersion', 'reason', 'requestId'].includes(field))) throw new AppError('INVALID_INPUT')
    let name = req.file.originalname
    if ([...name].every(character => character.charCodeAt(0) <= 255)) {
      try { name = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(name, 'latin1')) } catch { /* Legacy Latin-1 filenames keep their original spelling. */ }
    }
    res.status(201).json(await modifications.upload(String(req.params.id), { version, groupVersion, reason: fields.reason, requestId: fields.requestId, name, bytes: req.file.buffer }, await context(req, res)))
  })
  router.get('/modifications/:id/files/:fileId', async (req, res) => {
    const file = await modifications.download(String(req.params.id), String(req.params.fileId), await context(req, res))
    res.attachment(file.name).type('application/octet-stream').send(file.bytes)
  })
  router.post('/modifications/:id/files/:fileId/archive', async (req, res) => res.json(await modifications.archiveFile(String(req.params.id), String(req.params.fileId), req.body, await context(req, res, true))))
  router.post('/modifications/:id/populate', async (req, res) => res.status(201).json(await modifications.populate(String(req.params.id), req.body, await context(req, res))))
  router.post('/modifications/:id/unlink', async (req, res) => res.json(await modifications.unlink(String(req.params.id), req.body, await context(req, res))))
  router.post('/modifications/:id/archive', async (req, res) => res.json(await modifications.archiveMember(String(req.params.id), req.body, await context(req, res, true))))
}
