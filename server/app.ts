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
import { Workspaces } from './workspaces.js'
import { Business } from './business.js'
import { appVersion } from '../shared/version.js'
import type { BrowserPresence } from './browser-presence.js'

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

export function createApp({ dataDir, staticDir, controlToken, onShutdown, browserPresence, presenceToken }: { dataDir: string; staticDir?: string; controlToken?: string; onShutdown?: () => void; browserPresence?: BrowserPresence; presenceToken?: string }) {
  const store = new LocalStore(dataDir)
  const teams = new TeamDirectory(store.get<TeamDocument>('cachedTeam'))
  const workspaces = new Workspaces(store)
  const active = new Map<string, number>(), switching = new Set<string>()
  const app = express()
  app.disable('x-powered-by')
  app.use(helmet({ contentSecurityPolicy: { directives: { 'upgrade-insecure-requests': null, 'img-src': ["'self'", 'data:', 'blob:'] } } }))
  app.use((req, res, next) => {
    if (!['localhost', '127.0.0.1', '[::1]'].includes(req.hostname)) return next(new AppError('HOST_NOT_ALLOWED', 403))
    next()
  })
  const normalJson = express.json({ limit: '128kb' }), exportJson = express.json({ limit: '4mb' })
  app.use((req, res, next) => {
    // Cross-page UUID selections and personal column/filter templates can exceed
    // the ordinary form limit. Keep that larger allowance scoped to these APIs.
    const localExport = /^\/api\/business\/export\/csv\/?$/i.test(req.path) || /^\/api\/business\/export-templates(?:\/[^/]+)?\/?$/i.test(req.path)
    if (!localExport) return normalJson(req, res, next)
    exportJson(req, res, error => {
      if (error?.type === 'entity.too.large') return next(new AppError('EXPORT_TOO_LARGE', 413))
      next(error)
    })
  })
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
    const preferred = store.get<string>(`preferredWorkspace:${account.id}`)
    const selected = preferred && store.db.prepare('SELECT 1 FROM account_workspaces WHERE user_id=? AND workspace_id=?').get(account.id, preferred) ? preferred : (store.db.prepare('SELECT workspace_id FROM account_workspaces WHERE user_id=? ORDER BY workspace_id LIMIT 1').get(account.id)?.workspace_id as string | undefined) || null
    const state = selected ? workspaces.get(selected).synchronization.status() : null
    store.db.prepare('INSERT INTO sessions(token,user_id,expires,workspace_id,sync_enabled) VALUES(?,?,?,?,?)').run(token, account.id, Date.now() + 8 * 60 * 60 * 1000, selected, state && !state.pending && !state.conflicts.length ? 1 : 0)
    res.set('X-Workspace-Token', workspaces.token(workspaces.session(token)))
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
  app.get('/api/bootstrap', (req: AuthRequest, res) => res.json({ version: appVersion, user: req.localUser || null, instanceId, pid: process.pid }))
  if (browserPresence && presenceToken) app.post('/api/local/browser-presence-token', (req, res) => res.json({ token: presenceToken }))
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
  app.use('/api', (req: AuthRequest, res, next) => {
    const token = req.sessionToken!, session = workspaces.session(token)
    res.set('X-Workspace-Token', workspaces.token(session))
    const protectedPath = /^\/(setup\/configure|workspaces\/(select|disconnect|cancel-request|resume)|team(?:\/|$)|business(?:\/|$))/.test(req.path)
    if (!protectedPath) return next()
    if (req.get('X-Workspace-Token') !== workspaces.token(session)) return next(new AppError('WORKSPACE_CHANGED', 409))
    const exclusive = /^\/(setup\/configure|workspaces\/)/.test(req.path)
    if (switching.has(token) || (exclusive && active.get(token))) return next(new AppError('WORKSPACE_BUSY', 409))
    active.set(token, (active.get(token) || 0) + 1)
    if (exclusive) switching.add(token)
    let released = false
    const release = () => { if (!released) { released = true; active.set(token, (active.get(token) || 1) - 1); switching.delete(token) } }
    res.once('finish', release); res.once('close', release)
    next()
  })
  const identity = (req: AuthRequest): Identity => ({ deviceId: store.deviceId, deviceName: store.deviceName, localUserId: req.localUser!.id, displayName: req.localUser!.displayName })
  const current = (req: AuthRequest) => {
    const id = workspaces.session(req.sessionToken!).workspace_id
    if (!id) throw new AppError('NOT_CONFIGURED', 409)
    return workspaces.get(id)
  }
  const configuration = (req: AuthRequest): Config => {
    const config = current(req).store.get<Config>('configuration')
    if (!config) throw new AppError('NOT_CONFIGURED', 409)
    return config
  }
  async function status(req: AuthRequest): Promise<Status> {
    const session = workspaces.session(req.sessionToken!), workspace = session.workspace_id ? workspaces.get(session.workspace_id) : null
    const readStatus = async (): Promise<Status> => {
      const config = workspace?.store.get<Config>('configuration')
      let team = workspace?.store.get<TeamDocument>('cachedTeam') || null, online = false, error: string | null = null
      if (config && workspace) {
        try { team = await workspace.teams.read(config.sharedPath, config.teamId); workspace.cache(team); online = true }
        catch (failure) { error = failure instanceof AppError ? failure.code : 'SHARE_IO_ERROR'; team = workspace.store.get<TeamDocument>('cachedTeam') }
      }
      const { member, binding } = team ? bindingFor(team, identity(req)) : {}
      const request = team?.requests.filter(item => item.identity.deviceId === store.deviceId && item.identity.localUserId === req.localUser!.id).at(-1)
      const access: Access = !config ? 'unconfigured' : binding ? (binding.enabled && member?.enabled ? 'approved' : 'disabled') : request?.status === 'pending' ? 'pending' : request?.status === 'rejected' ? 'rejected' : 'unbound'
      return { version: appVersion, user: req.localUser!, deviceId: store.deviceId, deviceName: store.deviceName, sharedPath: config?.sharedPath || null, teamId: config?.teamId || null, workspaceToken: workspaces.token(session), syncPaused: !session.sync_enabled, teamName: team?.name || null, access, online, error, lastChecked: workspace?.store.get<string>('lastChecked') || null, member: member || null }
    }
    return workspace ? workspace.store.runWrite(readStatus) : readStatus()
  }
  app.get('/api/status', async (req: AuthRequest, res, next) => { try { res.json(await status(req)) } catch (error) { next(error) } })
  app.post('/api/setup/check', async (req, res, next) => { try { res.json(await teams.probe(req.body?.path)) } catch (error) { next(error) } })
  app.post('/api/setup/configure', async (req: AuthRequest, res, next) => {
    try {
      const check = await teams.probe(req.body?.path)
      await prepareSwitch(req)
      let team: TeamDocument
      if (req.body?.mode === 'create') {
        if (check.kind !== 'empty' || req.body?.confirmed !== true) throw new AppError('CONFIRM_TEAM_CREATION', 409)
        team = await teams.create(check.path, text(req.body?.teamName, 1, 80), identity(req))
      } else if (req.body?.mode === 'join') {
        if (check.kind !== 'existing' || req.body?.teamId !== check.teamId) throw new AppError('TEAM_CHANGED', 409)
        team = await teams.join(check.path, check.teamId!, identity(req))
      } else throw new AppError('INVALID_INPUT')
      const workspace = workspaces.connect(team, check.path, req.localUser!.id)
      const state = workspace.synchronization.status()
      select(req, team.id, !state.pending && !state.conflicts.length)
      workspace.store.event(req.localUser!.id, 'workspace.configured', { teamId: team.id, mode: req.body.mode })
      res.set('X-Workspace-Token', workspaces.token(workspaces.session(req.sessionToken!)))
      res.json(await status(req))
    } catch (error) { next(error) }
  })
  app.get('/api/team', async (req: AuthRequest, res, next) => {
    try {
      const { teams, cache } = current(req)
      const config = configuration(req), team = await teams.read(config.sharedPath, config.teamId)
      cache(team)
      const { member, binding } = bindingFor(team, identity(req))
      if (!member?.enabled || member.role !== 'admin' || !binding?.enabled) throw new AppError('ADMIN_REQUIRED', 403)
      res.json(team)
    } catch (error) { next(error) }
  })
  app.post('/api/team/upgrade-gate', async (req: AuthRequest, res, next) => {
    try {
      const { teams, cache } = current(req), config = configuration(req)
      const reason = text(req.body?.reason)
      const team = await teams.enableUpgradeGate(config.sharedPath, config.teamId, identity(req), reason)
      cache(team); res.json(team)
    } catch (error) { next(error) }
  })
  app.post('/api/team/requests/:id/approve', async (req: AuthRequest, res, next) => {
    try {
      const { teams, cache } = current(req), config = configuration(req)
      const team = await teams.approve(config.sharedPath, config.teamId, identity(req), String(req.params.id), role(req.body?.role), req.body?.memberId ? text(req.body.memberId) : null, text(req.body?.reason))
      cache(team); res.json(team)
    } catch (error) { next(error) }
  })
  app.post('/api/team/members/:id', async (req: AuthRequest, res, next) => {
    try {
      if (typeof req.body?.enabled !== 'boolean') throw new AppError('INVALID_INPUT')
      const { teams, cache } = current(req), config = configuration(req)
      const profile = req.body?.name !== undefined || req.body?.nickname !== undefined ? { name: text(req.body?.name, 1, 60), nickname: text(req.body?.nickname ?? '', 0, 60) } : undefined
      const team = await teams.changeMember(config.sharedPath, config.teamId, identity(req), String(req.params.id), role(req.body?.role), req.body.enabled, text(req.body?.reason), profile)
      cache(team); res.json(team)
    } catch (error) { next(error) }
  })
  app.post('/api/team/requests/:id/reject', async (req: AuthRequest, res, next) => {
    try {
      const { teams, cache } = current(req), config = configuration(req)
      const team = await teams.reject(config.sharedPath, config.teamId, identity(req), String(req.params.id), text(req.body?.reason))
      cache(team); res.json(team)
    } catch (error) { next(error) }
  })
  app.post('/api/team/devices/:id/revoke', async (req: AuthRequest, res, next) => {
    try {
      const { teams, cache } = current(req), config = configuration(req)
      const team = await teams.revokeDevice(config.sharedPath, config.teamId, identity(req), String(req.params.id), text(req.body?.reason))
      cache(team); res.json(team)
    } catch (error) { next(error) }
  })
  async function prepareSwitch(req: AuthRequest): Promise<void> {
    const session = workspaces.session(req.sessionToken!)
    if (!session.workspace_id) return
    const workspace = current(req)
    await workspace.synchronization.settle()
    const state = workspace.synchronization.status()
    if ((state.pending || state.conflicts.length) && req.body?.retainPending !== true) throw new AppError('PENDING_BEFORE_SWITCH', 409)
  }
  function select(req: AuthRequest, id: string | null, resume: boolean): void {
    workspaces.select(req.sessionToken!, req.localUser!.id, id, resume)
    if (id) store.set(`preferredWorkspace:${req.localUser!.id}`, id)
  }
  app.get('/api/workspaces', (req: AuthRequest, res) => {
    const session = workspaces.session(req.sessionToken!)
    const rows = store.db.prepare('SELECT workspace_id FROM account_workspaces WHERE user_id=? ORDER BY workspace_id').all(req.localUser!.id)
    res.json(rows.map(row => {
      const workspace = workspaces.get(row.workspace_id as string), team = workspace.store.get<TeamDocument>('cachedTeam')
      const { member, binding } = team ? bindingFor(team, identity(req)) : {}
      const request = team?.requests.filter(item => item.identity.deviceId === store.deviceId && item.identity.localUserId === req.localUser!.id).at(-1)
      const access = binding ? member?.enabled && binding.enabled ? 'approved' : 'disabled' : request?.status === 'pending' ? 'pending' : request?.status === 'rejected' ? 'rejected' : 'unbound'
      const state = workspace.synchronization.status(), config = workspace.store.get<Config>('configuration')!
      return { id: config.teamId, name: team?.name || workspace.row.name, sharedPath: config.sharedPath, access, pending: state.pending, conflicts: state.conflicts.length, selected: session.workspace_id === config.teamId }
    }))
  })
  app.post('/api/workspaces/select', async (req: AuthRequest, res, next) => {
    try {
      const id = text(req.body?.teamId)
      if (!store.db.prepare('SELECT 1 FROM account_workspaces WHERE user_id=? AND workspace_id=?').get(req.localUser!.id, id)) throw new AppError('WORKSPACE_NOT_FOUND', 404)
      await prepareSwitch(req)
      const state = workspaces.get(id).synchronization.status()
      select(req, id, !state.pending && !state.conflicts.length)
      res.set('X-Workspace-Token', workspaces.token(workspaces.session(req.sessionToken!)))
      res.json(await status(req))
    } catch (error) { next(error) }
  })
  app.post('/api/workspaces/disconnect', async (req: AuthRequest, res, next) => {
    try {
      if (req.body?.confirmed !== true) throw new AppError('CONFIRM_DISCONNECT', 409)
      await prepareSwitch(req); select(req, null, false)
      res.set('X-Workspace-Token', workspaces.token(workspaces.session(req.sessionToken!)))
      res.json(await status(req))
    } catch (error) { next(error) }
  })
  app.post('/api/workspaces/cancel-request', async (req: AuthRequest, res, next) => {
    try {
      if (req.body?.confirmed !== true) throw new AppError('CONFIRM_DISCONNECT', 409)
      const workspace = current(req), config = configuration(req)
      workspace.cache(await workspace.teams.cancelRequest(config.sharedPath, config.teamId, identity(req)))
      res.json(await status(req))
    } catch (error) { next(error) }
  })
  app.post('/api/workspaces/resume', async (req: AuthRequest, res, next) => {
    try {
      if (req.body?.confirmed !== true) throw new AppError('CONFIRM_RESUME', 409)
      const workspace = current(req), config = configuration(req)
      await workspace.teams.withAccess(config.sharedPath, config.teamId, identity(req), false, async team => workspace.cache(team))
      store.db.prepare('UPDATE sessions SET sync_enabled=1 WHERE token=?').run(req.sessionToken!)
      res.json(await status(req))
    } catch (error) { next(error) }
  })
  app.use((req: AuthRequest & { syncEnabled?: boolean }, res, next) => {
    if (!req.path.startsWith('/api/business/')) return next()
    try {
      req.syncEnabled = Boolean(workspaces.session(req.sessionToken!).sync_enabled)
      current(req).router(req, res, next)
    } catch (error) { next(error) }
  })
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
  return { app, store, business: new Business(store), workspaces, tick: () => workspaces.tick(), synchronization: { settle: () => workspaces.settle() }, close: () => workspaces.close() }
}
