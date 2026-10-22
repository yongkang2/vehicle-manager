import { randomBytes, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage, Server } from 'node:http'
import { WebSocket, WebSocketServer } from 'ws'

export function localOrigin(request: IncomingMessage): boolean {
  try {
    const host = request.headers.host || ''
    const origin = new URL(request.headers.origin || '')
    return origin.protocol === 'http:' && origin.host === host &&
      ['127.0.0.1', 'localhost', '[::1]'].includes(origin.hostname)
  } catch { return false }
}

export function createPresence(server: Server, onIdle: () => void, options: {
  intervalMs?: number; graceMs?: number; startupMs?: number; now?: () => number
} = {}) {
  const token = randomBytes(32).toString('hex')
  const now = options.now || Date.now
  const intervalMs = options.intervalMs ?? 30000
  const graceMs = options.graceMs ?? 60000
  const startupMs = options.startupMs ?? 300000
  const started = now()
  let lastCheck = started, emptySince = started, connected = false, stopped = false
  const clients = new Map<WebSocket, boolean>()
  const sockets = new WebSocketServer({ noServer: true, maxPayload: 1024, perMessageDeflate: false, handleProtocols: () => 'vehicle-manager' })
  function check() {
    if (stopped) return
    const current = now()
    const resumed = current - lastCheck > intervalMs * 2 || current < lastCheck
    lastCheck = current
    if (resumed) emptySince = current
    for (const [socket, alive] of clients) {
      if (!alive && !resumed) { socket.terminate(); continue }
      clients.set(socket, false)
      if (socket.readyState === WebSocket.OPEN) socket.ping()
    }
    if (!clients.size && current - emptySince >= graceMs && (connected || current - started >= startupMs)) {
      stop()
      onIdle()
    }
  }
  const timer = setInterval(check, intervalMs).unref()
  const onUpgrade = (request: IncomingMessage, socket: import('node:stream').Duplex, head: Buffer) => {
    const protocols = (request.headers['sec-websocket-protocol'] || '').split(',').map(value => value.trim())
    const supplied = protocols[1] || ''
    if (stopped || request.url !== '/api/local/presence' || !localOrigin(request) || protocols[0] !== 'vehicle-manager' ||
      !/^[a-f0-9]{64}$/.test(supplied) || !timingSafeEqual(Buffer.from(supplied), Buffer.from(token))) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); return
    }
    sockets.handleUpgrade(request, socket, head, client => {
      connected = true
      clients.set(client, true)
      client.on('pong', () => { clients.set(client, true) })
      client.on('error', () => { client.terminate() })
      client.on('close', () => { clients.delete(client); if (!clients.size) emptySince = now() })
    })
  }
  server.on('upgrade', onUpgrade)
  function stop() {
    if (stopped) return
    stopped = true
    clearInterval(timer)
    server.off('upgrade', onUpgrade)
    for (const socket of clients.keys()) socket.terminate()
    clients.clear()
    sockets.close()
  }
  return { token, check, stop, get connections() { return clients.size } }
}