import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage, Server } from 'node:http'
import type { Duplex } from 'node:stream'
import { WebSocket, WebSocketServer } from 'ws'
import { AppError } from './team.js'

export type BrowserPresenceState = { documents: number; pendingPages: number; openPages: number; uncertainPages: number; closedPages: number; sockets: number; legacyPages: number }
type Options = { onEmpty: (state: BrowserPresenceState) => void; onStateChange?: (state: BrowserPresenceState) => void; now?: () => number; intervalMs?: number; reconnectGraceMs?: number; pongTimeoutMs?: number }
export type PresenceDocument = { pageId: string; pageToken: string; generation: number }
type Page = PresenceDocument & { state: 'pending' | 'open' | 'uncertain' | 'closed'; canClose: boolean; registered: boolean }
type Connection = { document?: PresenceDocument; pongTimer?: ReturnType<typeof setTimeout>; close: () => void; pong: () => void }
const pageId = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i

export function presenceTokenMatches(supplied: unknown, expected: string): boolean {
  return typeof supplied === 'string' && /^[a-f0-9]{64}$/.test(supplied) && /^[a-f0-9]{64}$/.test(expected) && timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))
}
export function presenceOriginAllowed(request: Pick<IncomingMessage, 'headers'>): boolean {
  try {
    const origin = new URL(request.headers.origin || '')
    return origin.protocol === 'http:' && origin.origin === request.headers.origin && ['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname) && origin.host === request.headers.host?.toLowerCase()
  } catch { return false }
}
function documentInput(input: unknown): PresenceDocument {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new AppError('INVALID_INPUT')
  const value = input as Record<string, unknown>
  if (typeof value.pageId !== 'string' || !pageId.test(value.pageId) || typeof value.pageToken !== 'string' || !/^[a-f0-9]{64}$/.test(value.pageToken) || !Number.isSafeInteger(value.generation) || Number(value.generation) < 0) throw new AppError('INVALID_INPUT')
  return { pageId: value.pageId, pageToken: value.pageToken, generation: Number(value.generation) }
}

/** Logical documents outlive their transports. Uncertainty never proves closure. */
export class BrowserPresence {
  private readonly clients = new Map<WebSocket, Connection>()
  private readonly pages = new Map<string, Page>()
  private readonly now: () => number
  private readonly intervalMs: number
  private readonly reconnectGraceMs: number
  private readonly pongTimeoutMs: number
  private readonly onEmpty: Options['onEmpty']
  private readonly onStateChange: Options['onStateChange']
  private interval?: ReturnType<typeof setInterval>
  private emptyTimer?: ReturnType<typeof setTimeout>
  private emptySince?: number
  private legacy = false
  private stopped = false
  private lastState = ''

  constructor(options: Options) {
    this.onEmpty = options.onEmpty; this.onStateChange = options.onStateChange
    this.now = options.now || Date.now
    this.intervalMs = options.intervalMs ?? 5 * 60 * 1000
    this.reconnectGraceMs = options.reconnectGraceMs ?? 5000
    this.pongTimeoutMs = options.pongTimeoutMs ?? 10000
  }
  get count(): number { return this.clients.size }
  get state(): BrowserPresenceState {
    const pages = [...this.pages.values()]
    return { documents: pages.length, pendingPages: pages.filter(page => page.state === 'pending').length, openPages: pages.filter(page => page.state === 'open').length, uncertainPages: pages.filter(page => page.state === 'uncertain').length, closedPages: pages.filter(page => page.state === 'closed').length, sockets: this.clients.size, legacyPages: Number(this.legacy) }
  }
  createDocument(): Pick<PresenceDocument, 'pageId' | 'pageToken'> {
    this.assertOpen()
    const page = { pageId: randomUUID(), pageToken: randomBytes(32).toString('hex'), generation: -1, state: 'pending', canClose: true, registered: false } satisfies Page
    this.pages.set(page.pageId, page); this.changed()
    return { pageId: page.pageId, pageToken: page.pageToken }
  }
  registerDocument(input: unknown): { pageId: string; generation: number; canClose: boolean } {
    this.assertOpen()
    const document = documentInput(input)
    let page = this.pages.get(document.pageId)
    if (!page) {
      // A cached document after restart has no witnessed HTML lifecycle.
      // Reconnect it, but never let it authorize automatic shutdown.
      page = { ...document, state: 'uncertain', canClose: false, registered: true }
      this.pages.set(page.pageId, page)
    } else {
      if (!presenceTokenMatches(document.pageToken, page.pageToken)) throw new AppError('INVALID_REQUEST', 403)
      if (page.state === 'closed' || document.generation < page.generation) throw new AppError('INVALID_REQUEST', 409)
      if (document.generation > page.generation) {
        this.removeDocumentSockets(page.pageId)
        page.generation = document.generation; page.state = 'uncertain'
      }
      page.registered = true
    }
    this.changed()
    return { pageId: page.pageId, generation: page.generation, canClose: page.canClose }
  }
  markLegacy(): void { this.assertOpen(); this.legacy = true; this.changed() }
  canAttach(document: PresenceDocument): boolean {
    const page = this.pages.get(document.pageId)
    return !this.stopped && Boolean(page && page.registered && page.state !== 'closed' && page.generation === document.generation && presenceTokenMatches(document.pageToken, page.pageToken))
  }
  confirmClosed(input: unknown): boolean {
    this.assertOpen()
    const document = documentInput(input), page = this.pages.get(document.pageId)
    if (!page || !presenceTokenMatches(document.pageToken, page.pageToken) || !page.canClose || !page.registered) throw new AppError('INVALID_REQUEST', 403)
    if (document.generation !== page.generation) return false
    if (page.state === 'closed') return true
    page.state = 'closed'; this.removeDocumentSockets(page.pageId); this.changed()
    return true
  }
  attach(socket: WebSocket, document?: PresenceDocument): void {
    if (this.stopped || socket.readyState !== WebSocket.OPEN || document && !this.canAttach(document)) { socket.terminate(); return }
    if (this.clients.has(socket)) return
    if (!document) this.markLegacy()
    else this.pages.get(document.pageId)!.state = 'open'
    const connection: Connection = {
      document,
      close: () => this.remove(socket),
      pong: () => { clearTimeout(connection.pongTimer); connection.pongTimer = undefined },
    }
    this.clients.set(socket, connection)
    socket.on('close', connection.close); socket.on('error', connection.close); socket.on('pong', connection.pong)
    this.changed()
  }
  start(): void {
    if (this.stopped || this.interval) return
    this.interval = setInterval(() => this.check(), this.intervalMs); this.interval.unref(); this.changed()
  }
  check(): void {
    if (this.stopped) return
    for (const [socket, connection] of this.clients) {
      if (socket.readyState !== WebSocket.OPEN) { this.remove(socket); continue }
      if (connection.pongTimer) continue
      const deadline = this.now() + this.pongTimeoutMs
      connection.pongTimer = setTimeout(() => {
        if (this.stopped || !this.clients.has(socket)) return
        connection.pongTimer = undefined
        if (this.now() - deadline > this.reconnectGraceMs) { this.check(); return }
        this.remove(socket); socket.terminate()
      }, this.pongTimeoutMs)
      connection.pongTimer.unref()
      try { socket.ping((error?: Error) => { if (error && this.clients.has(socket)) { this.remove(socket); socket.terminate() } }) }
      catch { this.remove(socket); socket.terminate() }
    }
    this.checkEmpty()
  }
  stop(): void {
    if (this.stopped) return
    this.stopped = true; clearInterval(this.interval); this.interval = undefined
    clearTimeout(this.emptyTimer); this.emptyTimer = undefined
    for (const socket of this.clients.keys()) { this.remove(socket, false); socket.terminate() }
    this.pages.clear()
  }
  private assertOpen(): void { if (this.stopped) throw new AppError('MAINTENANCE_IN_PROGRESS', 503) }
  private allClosed(): boolean { return !this.legacy && this.pages.size > 0 && [...this.pages.values()].every(page => page.registered && page.state === 'closed') }
  private changed(): void {
    if (this.stopped) return
    if (this.allClosed()) this.emptySince ??= this.now()
    else { this.emptySince = undefined; clearTimeout(this.emptyTimer); this.emptyTimer = undefined }
    const state = this.state, signature = JSON.stringify(state)
    if (signature !== this.lastState) { this.lastState = signature; this.onStateChange?.(state) }
  }
  private removeDocumentSockets(id: string): void {
    for (const [socket, connection] of this.clients) if (connection.document?.pageId === id) { this.remove(socket, false); socket.terminate() }
  }
  private remove(socket: WebSocket, uncertain = true): void {
    const connection = this.clients.get(socket)
    if (!connection) return
    clearTimeout(connection.pongTimer)
    socket.off('close', connection.close); socket.off('error', connection.close); socket.off('pong', connection.pong)
    this.clients.delete(socket)
    if (uncertain && connection.document) {
      const page = this.pages.get(connection.document.pageId)
      if (page && page.generation === connection.document.generation && page.state !== 'closed' && ![...this.clients.values()].some(client => client.document?.pageId === page.pageId && client.document.generation === page.generation)) page.state = 'uncertain'
    }
    this.changed()
  }
  private checkEmpty(): void {
    if (this.stopped || !this.allClosed() || this.emptySince === undefined) return
    const remaining = this.reconnectGraceMs - (this.now() - this.emptySince)
    if (remaining > 0) {
      if (!this.emptyTimer) { this.emptyTimer = setTimeout(() => { this.emptyTimer = undefined; this.checkEmpty() }, remaining); this.emptyTimer.unref() }
      return
    }
    const state = this.state
    this.stop(); this.onEmpty(state)
  }
}

/** Bind only this loopback origin and matching service/document capabilities. */
export function installBrowserPresence(server: Server, monitor: BrowserPresence, { token }: { token: string }): () => void {
  const sockets = new WebSocketServer({ noServer: true, maxPayload: 1024, perMessageDeflate: false })
  const upgrade = (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    const onSocketError = () => socket.destroy()
    socket.on('error', onSocketError)
    let document: PresenceDocument | undefined
    let accepted = false
    try {
      const url = new URL(request.url || '', 'http://127.0.0.1')
      if (url.pathname === '/api/local/browser-presence' && presenceOriginAllowed(request) && url.searchParams.getAll('token').length === 1 && presenceTokenMatches(url.searchParams.get('token'), token)) {
        const keys = [...url.searchParams.keys()]
        if (keys.length === 1) accepted = true
        else if (keys.length === 4 && ['pageId', 'pageToken', 'generation'].every(key => url.searchParams.getAll(key).length === 1) && /^(?:0|[1-9]\d{0,15})$/.test(url.searchParams.get('generation') || '')) {
          document = documentInput({ pageId: url.searchParams.get('pageId'), pageToken: url.searchParams.get('pageToken'), generation: Number(url.searchParams.get('generation')) })
          accepted = monitor.canAttach(document)
        }
      }
    } catch { accepted = false }
    if (!accepted) { socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n', () => socket.destroy()); return }
    sockets.handleUpgrade(request, socket, head, client => { socket.off('error', onSocketError); monitor.attach(client, document) })
  }
  server.on('upgrade', upgrade)
  let disposed = false
  return () => {
    if (disposed) return
    disposed = true; server.off('upgrade', upgrade)
    for (const socket of sockets.clients) socket.terminate()
    sockets.close()
  }
}
