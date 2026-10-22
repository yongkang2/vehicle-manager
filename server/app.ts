import express from 'express'
import type { Request, Response } from 'express'
import helmet from 'helmet'
import { rateLimit } from 'express-rate-limit'
import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { LocalStore } from './store.js'
import { AppError, bindingFor, TeamDirectory } from './team.js'
import type { Access, Identity, LocalUser, Role, Status, TeamDocument } from '../shared/types.js'
import { installBusinessRoutes } from './business-routes.js'
import { localOrigin } from './presence.js'

type Config = { sharedPath: string; teamId: string }
type Account = { id: string; username: string; display_name: string; salt: string; hash: string }
type AuthRequest = Request & { localUser?: LocalUser; sessionToken?: string }
function text(value: unknown, minimum = 1, maximum = 500): string {
  if (typeof value !== 'string' || value.trim().length < minimum || value.length > maximum) throw new AppError('INVALID_INPUT')
  return value.trim()
}
function role(value: unknown): Role {
  if (value !== 'admin' && value !== 'member') throw new AppError('INVALID_INPUT')
  return value
}

export function createApp({ dataDir, staticDir, controlToken, onShutdown, presenceToken }: { dataDir: string; staticDir?: string; controlToken?: string; onShutdown?: () => void; presenceToken?: () => string | null }) {
  const store = new LocalStore(dataDir)
  const teams = new TeamDirectory(store.get<TeamDocument>('cachedTeam'))
  const app = express()
  app.disable('x-powered-by')
  app.use(helmet({ contentSecurityPolicy: { directives: { 'upgrade-insecure-requests': null } } }))
  app.use((req, res, next) => {
    if (!['localhost', '127.0.0.1', '[::1]'].includes(req.hostname)) return next(new AppError('HOST_NOT_ALLOWED', 403))
    next()
  })
  app.use(express.json({ limit: '128kb' }))
  app.use('/api', (req, res, next) => {
    res.set('Cache-Control', 'no-store')
    if (!['GET', 'HEAD'].includes(req.method) && req.get('X-App-Request') !== 'vehicle-manager') return next(new AppError('INVALID_REQUEST', 403))
    next()
  })
  const limiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 40, legacyHeaders: false, standardHeaders: 'draft-8', message: { error: 'TOO_MANY_ATTEMPTS' } })
  function userOf(account: Account): LocalUser { return { id: account.id, username: account.username, displayName: account.display_name } }
  function session(res: Response, account: Account): void {
    const token = randomBytes(32).toString('hex')
    store.db.prepare('DELETE FROM sessions WHERE expires<?').run(Date.now())
    store.db.prepare('INSERT INTO sessions VALUES(?,?,?)').run(token, account.id, Date.now() + 8 * 60 * 60 * 1000)
    res.cookie('vdm_session', token, { httpOnly: true, sameSite: 'strict', path: '/', maxAge: 8 * 60 * 60 * 1000 })
  }
  app.use('/api', (req: AuthRequest, res, next) => {
    const token = /(?:^|;\s*)vdm_session=([a-f0-9]{64})(?:;|$)/.exec(req.get('Cookie') || '')?.[1]
    if (token) {
      const account = store.db.prepare('SELECT accounts.* FROM sessions JOIN accounts ON accounts.id=sessions.user_id WHERE token=? AND expires>?').get(token, Date.now()) as Account | undefined
      if (account) { req.localUser = userOf(account); req.sessionToken = token }
    }
    next()
  })
  const instanceId = createHash('sha256').update(path.resolve(dataDir).toLowerCase()).digest('hex')
  app.get('/api/bootstrap', (req: AuthRequest, res) => res.json({ version: '0.2.0', user: req.localUser || null, instanceId, pid: process.pid }))
  app.post('/api/local/presence-token', (req, res) => {
    if (!localOrigin(req)) throw new AppError('INVALID_REQUEST', 403)
    res.json({ token: presenceToken?.() || null })
  })
  app.post('/api/local/shutdown', (req, res) => {
    const supplied = req.get('X-Control-Token') || ''
    if (!controlToken || !/^[a-f0-9]{64}$/.test(supplied) || !timingSafeEqual(Buffer.from(supplied), Buffer.from(controlToken))) throw new AppError('INVALID_REQUEST', 403)
    res.once('finish', () => onShutdown?.())
    res.json({ ok: true })
  })
  app.post('/api/register', limiter, (req, res, next) => {
    try {
      const username = text(req.body?.username, 2, 24)
      if (!/^[\p{L}\p{N}_-]+$/u.test(username)) throw new AppError('INVALID_USERNAME')
      const displayName = text(req.body?.displayName, 1, 60)
      const password = req.body?.password
      if (typeof password !== 'string' || password.length < 10 || password.length > 128) throw new AppError('INVALID_PASSWORD')
      if (store.db.prepare('SELECT id FROM accounts WHERE username=?').get(username)) throw new AppError('USERNAME_EXISTS', 409)
      const salt = randomBytes(16).toString('hex'), id = crypto.randomUUID()
      const hash = scryptSync(password, salt, 64).toString('hex')
      store.transaction(() => {
        store.db.prepare('INSERT INTO accounts(id,username,display_name,salt,hash,created) VALUES(?,?,?,?,?,?)').run(id, username, displayName, salt, hash, new Date().toISOString())
        store.event(id, 'account.registered', {})
      })
      const account = { id, username, display_name: displayName, salt, hash }
      session(res, account); res.status(201).json(userOf(account))
    } catch (error) { next(error) }
  })
  app.post('/api/login', limiter, (req, res, next) => {
    try {
      const username = text(req.body?.username, 2, 24), password = req.body?.password
      if (typeof password !== 'string' || password.length > 128) throw new AppError('INVALID_CREDENTIALS', 401)
      const account = store.db.prepare('SELECT * FROM accounts WHERE username=?').get(username) as Account | undefined
      const candidate = scryptSync(password, account?.salt || 'unrecognized-user', 64)
      if (!account || !timingSafeEqual(candidate, Buffer.from(account.hash, 'hex'))) throw new AppError('INVALID_CREDENTIALS', 401)
      store.event(account.id, 'account.login', {}); session(res, account); res.json(userOf(account))
    } catch (error) { next(error) }
  })
  app.use('/api', (req: AuthRequest, res, next) => req.localUser ? next() : next(new AppError('LOGIN_REQUIRED', 401)))
  app.post('/api/logout', (req: AuthRequest, res) => {
    store.db.prepare('DELETE FROM sessions WHERE token=?').run(req.sessionToken || '')
    res.clearCookie('vdm_session', { path: '/' }); res.json({ ok: true })
  })
  const identity = (req: AuthRequest): Identity => ({ deviceId: store.deviceId, deviceName: store.deviceName, localUserId: req.localUser!.id, displayName: req.localUser!.displayName })
  const configuration = (): Config => {
    const config = store.get<Config>('configuration')
    if (!config) throw new AppError('NOT_CONFIGURED', 409)
    return config
  }
  function cache(team: TeamDocument): void {
    const previous = store.get<TeamDocument>('cachedTeam')
    if (previous?.id === team.id && (team.revision < previous.revision || (team.revision === previous.revision && JSON.stringify(team) !== JSON.stringify(previous)))) throw new AppError('TEAM_ROLLBACK', 409)
    teams.observe(team)
    store.transaction(() => { store.set('cachedTeam', team); store.set('lastChecked', new Date().toISOString()) })
  }
  async function status(req: AuthRequest): Promise<Status> {
    const config = store.get<Config>('configuration')
    let team = store.get<TeamDocument>('cachedTeam'), online = false, error: string | null = null
    if (config) {
      try { team = await teams.read(config.sharedPath, config.teamId); cache(team); online = true }
      catch (failure) { error = failure instanceof AppError ? failure.code : 'SHARE_IO_ERROR'; team = store.get<TeamDocument>('cachedTeam') }
    }
    const { member, binding } = team ? bindingFor(team, identity(req)) : {}
    const request = team?.requests.filter(item => item.identity.deviceId === store.deviceId && item.identity.localUserId === req.localUser!.id).at(-1)
    const access: Access = !config ? 'unconfigured' : binding ? (binding.enabled && member?.enabled ? 'approved' : 'disabled') : request?.status === 'pending' ? 'pending' : request?.status === 'rejected' ? 'rejected' : 'unbound'
    return { version: '0.2.0', user: req.localUser!, deviceId: store.deviceId, deviceName: store.deviceName, sharedPath: config?.sharedPath || null, teamName: team?.name || null, access, online, error, lastChecked: store.get<string>('lastChecked'), member: member || null }
  }
  app.get('/api/status', async (req: AuthRequest, res, next) => { try { res.json(await status(req)) } catch (error) { next(error) } })
  app.post('/api/setup/check', async (req, res, next) => { try { res.json(await teams.probe(req.body?.path)) } catch (error) { next(error) } })
  app.post('/api/setup/configure', async (req: AuthRequest, res, next) => {
    try {
      const check = await teams.probe(req.body?.path)
      const old = store.get<Config>('configuration')
      if (old && (check.teamId !== old.teamId || req.body?.mode === 'create')) throw new AppError('WRONG_TEAM', 409)
      let team: TeamDocument
      if (req.body?.mode === 'create') {
        if (check.kind !== 'empty' || req.body?.confirmed !== true) throw new AppError('CONFIRM_TEAM_CREATION', 409)
        team = await teams.create(check.path, text(req.body?.teamName, 1, 80), identity(req))
      } else if (req.body?.mode === 'join') {
        if (check.kind !== 'existing' || req.body?.teamId !== check.teamId) throw new AppError('TEAM_CHANGED', 409)
        team = await teams.join(check.path, check.teamId!, identity(req))
      } else throw new AppError('INVALID_INPUT')
      store.transaction(() => {
        store.set('configuration', { sharedPath: check.path, teamId: team.id })
        store.set('cachedTeam', team); store.set('lastChecked', new Date().toISOString())
        store.event(req.localUser!.id, 'workspace.configured', { teamId: team.id, mode: req.body.mode })
      })
      res.json(await status(req))
    } catch (error) { next(error) }
  })
  app.get('/api/team', async (req: AuthRequest, res, next) => {
    try {
      const config = configuration(), team = await teams.read(config.sharedPath, config.teamId)
      cache(team)
      const { member, binding } = bindingFor(team, identity(req))
      if (!member?.enabled || member.role !== 'admin' || !binding?.enabled) throw new AppError('ADMIN_REQUIRED', 403)
      res.json(team)
    } catch (error) { next(error) }
  })
  app.post('/api/team/requests/:id/approve', async (req: AuthRequest, res, next) => {
    try {
      const config = configuration()
      const team = await teams.approve(config.sharedPath, config.teamId, identity(req), String(req.params.id), role(req.body?.role), req.body?.memberId ? text(req.body.memberId) : null, text(req.body?.reason))
      cache(team); res.json(team)
    } catch (error) { next(error) }
  })
  app.post('/api/team/members/:id', async (req: AuthRequest, res, next) => {
    try {
      if (typeof req.body?.enabled !== 'boolean') throw new AppError('INVALID_INPUT')
      const config = configuration()
      const team = await teams.changeMember(config.sharedPath, config.teamId, identity(req), String(req.params.id), role(req.body?.role), req.body.enabled, text(req.body?.reason))
      cache(team); res.json(team)
    } catch (error) { next(error) }
  })
  app.post('/api/team/requests/:id/reject', async (req: AuthRequest, res, next) => {
    try {
      const config = configuration()
      const team = await teams.reject(config.sharedPath, config.teamId, identity(req), String(req.params.id), text(req.body?.reason))
      cache(team); res.json(team)
    } catch (error) { next(error) }
  })
  app.post('/api/team/devices/:id/revoke', async (req: AuthRequest, res, next) => {
    try {
      const config = configuration()
      const team = await teams.revokeDevice(config.sharedPath, config.teamId, identity(req), String(req.params.id), text(req.body?.reason))
      cache(team); res.json(team)
    } catch (error) { next(error) }
  })
  const businessServices = installBusinessRoutes(app, store, teams, cache)
  app.use('/api', (req, res, next) => next(new AppError('NOT_FOUND', 404)))
  if (staticDir && existsSync(path.join(staticDir, 'index.html'))) {
    app.use(express.static(staticDir))
    app.get('/', (req, res) => res.sendFile(path.join(staticDir, 'index.html')))
  }
  app.use((error: unknown, req: Request, res: Response, next: express.NextFunction) => {
    if (res.headersSent) return next(error)
    if (error instanceof AppError) return res.status(error.status).json({ error: error.code })
    if ((error as { code?: string }).code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: 'FILE_TOO_LARGE' })
    if (String((error as Error).message).includes('UNIQUE constraint')) return res.status(409).json({ error: 'VIN_EXISTS' })
    if ((error as { type?: string }).type === 'entity.parse.failed') return res.status(400).json({ error: 'INVALID_INPUT' })
    console.error('Request failed:', error instanceof Error ? error.name : 'Unknown error')
    res.status(500).json({ error: 'SERVER_ERROR' })
  })
  return { app, store, ...businessServices }
}