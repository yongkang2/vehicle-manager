import { PublicClientApplication, ResponseMode } from '@azure/msal-node'
import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'
import { createRemoteJWKSet, decodeJwt, jwtVerify, type JWTVerifyGetKey } from 'jose'
import type { Express, Request, Response } from 'express'
import type { LocalStore } from './store.js'
import { AppError } from './team.js'

type Account = { id: string; username: string; display_name: string; salt: string; hash: string }
type AuthRequest = Request & { localUser?: { id: string }; sessionToken?: string }
export type MicrosoftIdentity = { tenantId: string; objectId: string; label: string; verifiedAt: string }
const guid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i
const keys = createRemoteJWKSet(new URL('https://login.microsoftonline.com/common/discovery/v2.0/keys'))

export function resolveMicrosoftAccount(store: LocalStore, identity: MicrosoftIdentity, binding?: { userId: string; sessionToken: string }): Account {
  let resolved!: Account
  store.transaction(() => {
    const all = store.get<Record<string, { userId: string; identity: MicrosoftIdentity }>>('microsoftBindings') || {}
    const id = `${identity.tenantId}:${identity.objectId}`
    if (binding) {
      const live = store.db.prepare('SELECT user_id FROM sessions WHERE token=? AND expires>?').get(binding.sessionToken, Date.now())
      if (live?.user_id !== binding.userId || all[id] || Object.values(all).some(item => item.userId === binding.userId)) throw new Error('Binding changed')
      all[id] = { userId: binding.userId, identity }
    }
    const current = all[id] && store.db.prepare('SELECT * FROM accounts WHERE id=?').get(all[id].userId) as Account | undefined
    if (!current) throw new AppError('MICROSOFT_NOT_BOUND', 403)
    all[id].identity = identity
    store.set('microsoftBindings', all)
    store.event({ id: current.id, username: current.username, displayName: current.display_name }, binding ? 'account.microsoft.bound' : 'account.microsoft.login', { tenantId: identity.tenantId, objectId: identity.objectId })
    resolved = current
  })
  return resolved
}

export async function verifyMicrosoftIdentity(token: string, clientId: string, nonce: string, tenantId?: string, key: JWTVerifyGetKey = keys): Promise<MicrosoftIdentity> {
  const decoded = decodeJwt(token)
  if (typeof decoded.tid !== 'string' || !guid.test(decoded.tid) || decoded.tid === '9188040d-6c67-4c5b-b112-36a304b66dad' || tenantId && decoded.tid !== tenantId) throw new Error('Invalid tenant')
  const { payload } = await jwtVerify(token, key, { algorithms: ['RS256'], audience: clientId, issuer: `https://login.microsoftonline.com/${decoded.tid}/v2.0`, requiredClaims: ['exp', 'iat', 'nonce', 'oid', 'tid', 'sub'] })
  if (payload.nonce !== nonce || typeof payload.oid !== 'string' || !guid.test(payload.oid)) throw new Error('Invalid identity')
  return { tenantId: decoded.tid, objectId: payload.oid, label: String(payload.preferred_username || payload.name || payload.oid).slice(0, 254), verifiedAt: new Date().toISOString() }
}

export function registerMicrosoftAuth(app: Express, store: LocalStore, session: (res: Response, account: Account) => void) {
  const clientId = process.env.VEHICLE_MANAGER_MICROSOFT_CLIENT_ID || ''
  const tenantId = process.env.VEHICLE_MANAGER_MICROSOFT_TENANT_ID || ''
  if (clientId && !guid.test(clientId) || tenantId && !guid.test(tenantId)) throw new Error('Invalid Microsoft identity configuration')
  const client = clientId ? new PublicClientApplication({ auth: { clientId, authority: `https://login.microsoftonline.com/${tenantId || 'organizations'}` } }) : null
  type Flow = { nonce: string; verifier: string; redirectUri: string; expires: number; userId?: string; sessionToken?: string }
  const flows = new Map<string, Flow>()
  const bindings = () => store.get<Record<string, { userId: string; identity: MicrosoftIdentity }>>('microsoftBindings') || {}
  const account = (id: string) => store.db.prepare('SELECT * FROM accounts WHERE id=?').get(id) as Account | undefined
  app.get('/api/microsoft/status', (req: AuthRequest, res) => {
    const bound = req.localUser ? Object.values(bindings()).find(item => item.userId === req.localUser!.id) : undefined
    res.json({ configured: Boolean(client), identity: bound?.identity || null })
  })
  app.post('/api/microsoft/start', async (req: AuthRequest, res, next) => {
    try {
      if (!client) throw new AppError('MICROSOFT_NOT_CONFIGURED', 503)
      // Pin the browser origin and loopback callback; never accept a return URL.
      const origin = new URL(`http://${req.hostname}:${req.socket.localPort}`).origin
      if (!['localhost', '127.0.0.1'].includes(req.hostname) || req.get('Origin') !== origin) throw new AppError('INVALID_REQUEST', 403)
      const bind = req.body?.mode === 'bind'
      if (!bind && req.body?.mode !== 'login') throw new AppError('INVALID_INPUT')
      if (bind) {
        const current = req.localUser && account(req.localUser.id)
        const password = req.body?.password
        if (!current || typeof password !== 'string' || password.length > 128 || !timingSafeEqual(scryptSync(password, current.salt, 64), Buffer.from(current.hash, 'hex'))) throw new AppError('INVALID_CREDENTIALS', 401)
        if (Object.values(bindings()).some(item => item.userId === current.id)) throw new AppError('MICROSOFT_ALREADY_BOUND', 409)
      } else if (req.localUser) throw new AppError('INVALID_REQUEST', 409)
      for (const [id, flow] of flows) if (flow.expires < Date.now()) flows.delete(id)
      if (flows.size >= 50) throw new AppError('TOO_MANY_ATTEMPTS', 429)
      const state = randomBytes(32).toString('hex'), nonce = randomBytes(32).toString('hex'), verifier = randomBytes(32).toString('base64url')
      const redirectUri = `${origin}/api/microsoft/callback`
      const url = await client.getAuthCodeUrl({ scopes: ['openid', 'profile'], redirectUri, state, nonce, codeChallenge: createHash('sha256').update(verifier).digest('base64url'), codeChallengeMethod: 'S256', prompt: 'select_account', responseMode: ResponseMode.QUERY })
      flows.set(state, { nonce, verifier, redirectUri, expires: Date.now() + 5 * 60_000, ...(bind ? { userId: req.localUser!.id, sessionToken: req.sessionToken } : {}) })
      res.cookie('vm_microsoft_flow', state, { httpOnly: true, sameSite: 'lax', path: '/api/microsoft', maxAge: 5 * 60_000 })
      res.json({ url })
    } catch (error) { next(error) }
  })
  app.get('/api/microsoft/callback', async (req, res) => {
    res.set('Referrer-Policy', 'no-referrer')
    const state = typeof req.query.state === 'string' ? req.query.state : ''
    const cookie = /(?:^|;\s*)vm_microsoft_flow=([a-f0-9]{64})(?:;|$)/.exec(req.get('Cookie') || '')?.[1]
    const flow = flows.get(state)
    if (!flow || cookie !== state || flow.expires < Date.now()) { res.redirect('/?microsoft=failed'); return }
    flows.delete(state)
    res.clearCookie('vm_microsoft_flow', { path: '/api/microsoft' })
    try {
      if (req.query.error || typeof req.query.code !== 'string' || req.query.code.length > 8192) throw new Error('Authorization failed')
      // A short-lived client avoids retaining refresh/access tokens between logins.
      const tokenClient = new PublicClientApplication({ auth: { clientId, authority: `https://login.microsoftonline.com/${tenantId || 'organizations'}` } })
      const result = await tokenClient.acquireTokenByCode({ code: req.query.code, codeVerifier: flow.verifier, redirectUri: flow.redirectUri, scopes: ['openid', 'profile'] })
      const identity = await verifyMicrosoftIdentity(result.idToken, clientId, flow.nonce, tenantId || undefined)
      const current = resolveMicrosoftAccount(store, identity, flow.userId ? { userId: flow.userId, sessionToken: flow.sessionToken! } : undefined)
      session(res, current)
      res.redirect('/?microsoft=success')
    } catch (error) {
      res.redirect(error instanceof AppError && error.code === 'MICROSOFT_NOT_BOUND' ? '/?microsoft=unbound' : '/?microsoft=failed')
    }
  })
}
