import { timingSafeEqual } from 'node:crypto'
import type { IncomingMessage, Server } from 'node:http'
import type { Duplex } from 'node:stream'
import { WebSocket, WebSocketServer } from 'ws'

type Options = {
  onEmpty: () => void
  now?: () => number
  intervalMs?: number
  reconnectGraceMs?: number
  pongTimeoutMs?: number
}
type Connection = { pongTimer?: ReturnType<typeof setTimeout>; close: () => void; pong: () => void }

/** An open transport counts as a page, including a hidden or JavaScript-frozen page. */
export class BrowserPresence {
  private readonly clients = new Map<WebSocket, Connection>()
  private readonly now: () => number
  private readonly intervalMs: number
  private readonly reconnectGraceMs: number
  private readonly pongTimeoutMs: number
  private readonly onEmpty: () => void
  private interval?: ReturnType<typeof setInterval>
  private emptyTimer?: ReturnType<typeof setTimeout>
  private emptySince?: number
  private stopped = false

  constructor(options: Options) {
    this.onEmpty = options.onEmpty
    this.now = options.now || Date.now
    this.intervalMs = options.intervalMs ?? 5 * 60 * 1000
    this.reconnectGraceMs = options.reconnectGraceMs ?? 5000
    this.pongTimeoutMs = options.pongTimeoutMs ?? 10000
  }

  get count(): number { return this.clients.size }

  attach(socket: WebSocket): void {
    if (this.stopped || socket.readyState !== WebSocket.OPEN) { socket.terminate(); return }
    if (this.clients.has(socket)) return
    clearTimeout(this.emptyTimer); this.emptyTimer = undefined; this.emptySince = undefined
    const connection: Connection = {
      close: () => {
        // A failed heartbeat may close before its deadline; finish this check now.
        const checking = connection.pongTimer !== undefined
        this.remove(socket)
        if (checking) this.checkEmpty()
      },
      pong: () => { clearTimeout(connection.pongTimer); connection.pongTimer = undefined },
    }
    this.clients.set(socket, connection)
    socket.on('close', connection.close)
    socket.on('error', connection.close)
    socket.on('pong', connection.pong)
  }

  start(): void {
    if (this.stopped || this.interval) return
    this.interval = setInterval(() => this.check(), this.intervalMs)
    this.interval.unref()
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
        // After system sleep, queued pong events need a fresh response window.
        if (this.now() - deadline > this.reconnectGraceMs) { this.check(); return }
        this.remove(socket)
        socket.terminate()
        this.checkEmpty()
      }, this.pongTimeoutMs)
      connection.pongTimer.unref()
      try {
        // Browsers answer protocol pings without page timers or user activity.
        socket.ping((error?: Error) => { if (error && this.clients.has(socket)) { connection.close(); socket.terminate() } })
      } catch { connection.close(); socket.terminate() }
    }
    this.checkEmpty()
  }

  stop(): void {
    if (this.stopped) return
    this.stopped = true
    clearInterval(this.interval); this.interval = undefined
    clearTimeout(this.emptyTimer); this.emptyTimer = undefined
    for (const socket of this.clients.keys()) { this.remove(socket); socket.terminate() }
  }

  private remove(socket: WebSocket): void {
    const connection = this.clients.get(socket)
    if (!connection) return
    clearTimeout(connection.pongTimer)
    socket.off('close', connection.close)
    socket.off('error', connection.close)
    socket.off('pong', connection.pong)
    this.clients.delete(socket)
    if (!this.clients.size) this.emptySince = this.now()
  }

  private checkEmpty(): void {
    if (this.stopped || this.clients.size) return
    const remaining = this.emptySince === undefined ? 0 : this.reconnectGraceMs - (this.now() - this.emptySince)
    if (remaining > 0) {
      if (!this.emptyTimer) {
        this.emptyTimer = setTimeout(() => { this.emptyTimer = undefined; this.checkEmpty() }, remaining)
        this.emptyTimer.unref()
      }
      return
    }
    this.stop()
    this.onEmpty()
  }
}

function allowed(request: IncomingMessage, token: string): boolean {
  try {
    const url = new URL(request.url || '', 'http://127.0.0.1')
    const origin = new URL(request.headers.origin || '')
    const supplied = url.searchParams.get('token') || ''
    return url.pathname === '/api/local/browser-presence' && url.searchParams.getAll('token').length === 1 &&
      origin.protocol === 'http:' && origin.origin === request.headers.origin &&
      ['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname) &&
      origin.host === request.headers.host?.toLowerCase() &&
      /^[a-f0-9]{64}$/.test(token) && /^[a-f0-9]{64}$/.test(supplied) &&
      timingSafeEqual(Buffer.from(supplied), Buffer.from(token))
  } catch { return false }
}

/** Bind only the private page-presence endpoint; cleanup precedes HTTP shutdown. */
export function installBrowserPresence(server: Server, monitor: BrowserPresence, { token }: { token: string }): () => void {
  const sockets = new WebSocketServer({ noServer: true, maxPayload: 1024, perMessageDeflate: false })
  const upgrade = (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    const onSocketError = () => socket.destroy()
    socket.on('error', onSocketError)
    if (!allowed(request, token)) { socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n', () => socket.destroy()); return }
    sockets.handleUpgrade(request, socket, head, client => { socket.off('error', onSocketError); monitor.attach(client) })
  }
  server.on('upgrade', upgrade)
  let disposed = false
  return () => {
    if (disposed) return
    disposed = true
    server.off('upgrade', upgrade)
    for (const socket of sockets.clients) socket.terminate()
    sockets.close()
  }
}
