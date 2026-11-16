type Registration = { token: string; pageId: string; generation: number; canClose: boolean }
type DocumentState = { pageId: string; pageToken: string; generation: number; closed: boolean; registration?: Registration }
type Attempt = { generation: number; controller: AbortController; timer: number; promise: Promise<void>; resolve: () => void; reject: (cause: Error) => void; socket?: WebSocket }

const deadlineMs = 5000
let documentState: DocumentState | undefined
let activeTracker: PresenceTracker | undefined
const cancelled = () => new DOMException('Presence repair cancelled', 'AbortError')
const failed = () => new Error('NETWORK_ERROR')

function identity(): DocumentState {
  if (documentState) return documentState
  const meta = document.querySelector('meta[name="vehicle-manager-presence"]')
  let pageId = meta?.getAttribute('content') || '', pageToken = meta?.getAttribute('data-token') || ''
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(pageId) || !/^[a-f0-9]{64}$/.test(pageToken)) {
    pageId = crypto.randomUUID()
    pageToken = Array.from(crypto.getRandomValues(new Uint8Array(32)), byte => byte.toString(16).padStart(2, '0')).join('')
  }
  return documentState = { pageId, pageToken, generation: 0, closed: false }
}

/** Cancelling one caller does not disconnect this document's shared presence. */
function withSignal(promise: Promise<void>, signal?: AbortSignal): Promise<void> {
  if (!signal) return promise
  if (signal.aborted) return Promise.reject(cancelled())
  return new Promise((resolve, reject) => {
    const abort = () => { cleanup(); reject(cancelled()) }
    const cleanup = () => signal.removeEventListener('abort', abort)
    signal.addEventListener('abort', abort, { once: true })
    promise.then(() => { cleanup(); resolve() }, cause => { cleanup(); reject(cause) })
  })
}

class PresenceTracker {
  private readonly page: DocumentState
  private stopped = false
  private suspended = false
  private retryDelay = 1000
  private retryTimer: number | undefined
  private attempt: Attempt | undefined
  private socket: WebSocket | undefined

  constructor(page: DocumentState) { this.page = page }

  start(): void {
    window.addEventListener('pagehide', this.pageHide)
    window.addEventListener('pageshow', this.resume)
    window.addEventListener('online', this.resume)
    window.addEventListener('focus', this.focus)
    document.addEventListener('visibilitychange', this.visibility)
    document.addEventListener('freeze', this.freeze)
    document.addEventListener('resume', this.resume)
    void this.ensure(false).catch(() => {})
  }

  repair(): Promise<void> {
    if (this.stopped || this.page.closed) return Promise.reject(failed())
    this.suspended = false
    return this.ensure(true)
  }

  private clearRetry(): void {
    if (this.retryTimer !== undefined) window.clearTimeout(this.retryTimer)
    this.retryTimer = undefined
  }

  private scheduleRetry(): void {
    if (this.stopped || this.suspended || this.page.closed || this.retryTimer !== undefined) return
    const generation = this.page.generation
    const timer = window.setTimeout(() => {
      if (this.retryTimer !== timer || this.page.generation !== generation) return
      this.retryTimer = undefined; void this.ensure(false).catch(() => {})
    }, this.retryDelay)
    this.retryTimer = timer
    this.retryDelay = Math.min(this.retryDelay * 2, 15000)
  }

  private current(attempt: Attempt): boolean {
    return !this.stopped && !this.suspended && !this.page.closed && this.attempt === attempt && this.page.generation === attempt.generation
  }

  private retireSocket(): void {
    const socket = this.socket
    this.socket = undefined
    if (!socket) return
    socket.onopen = null; socket.onclose = null; socket.onerror = null
    if (socket.readyState < WebSocket.CLOSING) { try { socket.close() } catch { /* Losing a transport never certifies a closed document. */ } }
  }

  private rejectAttempt(attempt: Attempt, cause: Error): void {
    if (this.attempt !== attempt) return
    this.attempt = undefined
    window.clearTimeout(attempt.timer)
    attempt.controller.abort()
    if (this.socket === attempt.socket) this.retireSocket()
    attempt.reject(cause)
    this.scheduleRetry()
  }

  private ensure(force: boolean): Promise<void> {
    if (this.stopped || this.suspended || this.page.closed) return Promise.reject(failed())
    if (this.attempt) return this.attempt.promise
    if (!force && this.socket?.readyState === WebSocket.OPEN) return Promise.resolve()
    this.clearRetry()
    const generation = ++this.page.generation
    this.retireSocket()
    let resolve!: () => void, reject!: (cause: Error) => void
    const promise = new Promise<void>((done, fail) => { resolve = done; reject = fail })
    const attempt: Attempt = { generation, controller: new AbortController(), promise, resolve, reject, timer: 0 }
    this.attempt = attempt
    // One deadline covers headers, JSON body and WebSocket establishment.
    attempt.timer = window.setTimeout(() => this.rejectAttempt(attempt, new Error('PRESENCE_TIMEOUT')), deadlineMs)
    void this.register(attempt)
    return promise
  }

  private async register(attempt: Attempt): Promise<void> {
    try {
      const { pageId, pageToken } = this.page
      const response = await fetch('/api/local/browser-presence-token', { method: 'POST', credentials: 'same-origin', cache: 'no-store', headers: { 'X-App-Request': 'vehicle-manager', 'Content-Type': 'application/json' }, body: JSON.stringify({ pageId, pageToken, generation: attempt.generation }), signal: attempt.controller.signal })
      if (!response.ok) throw failed()
      const result = await response.json() as Partial<Registration>
      if (!this.current(attempt)) return
      if (typeof result.token !== 'string' || !/^[a-f0-9]{64}$/.test(result.token) || result.pageId !== pageId || result.generation !== attempt.generation || typeof result.canClose !== 'boolean') throw failed()
      this.page.registration = { token: result.token, pageId, generation: attempt.generation, canClose: result.canClose }
      const url = new URL('/api/local/browser-presence', window.location.href)
      url.protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
      for (const [key, value] of Object.entries({ token: result.token, pageId, pageToken, generation: String(attempt.generation) })) url.searchParams.set(key, value)
      const socket = new WebSocket(url)
      this.socket = socket; attempt.socket = socket
      socket.onopen = () => {
        if (!this.current(attempt) || this.socket !== socket) return
        window.clearTimeout(attempt.timer)
        this.attempt = undefined; this.retryDelay = 1000
        attempt.resolve()
      }
      const lost = () => {
        if (this.socket !== socket || this.page.generation !== attempt.generation) return
        if (this.attempt === attempt) this.rejectAttempt(attempt, failed())
        else { this.retireSocket(); this.scheduleRetry() }
      }
      socket.onclose = lost
      socket.onerror = lost
    } catch {
      if (this.current(attempt)) this.rejectAttempt(attempt, failed())
    }
  }

  private disconnect(): void {
    this.clearRetry()
    if (this.attempt) this.rejectAttempt(this.attempt, cancelled())
    this.retireSocket()
  }

  private pageHide = (event: PageTransitionEvent): void => {
    if (this.stopped) return
    this.suspended = true
    const registration = this.page.registration
    const close = event.persisted === false && !this.page.closed
    if (close) this.page.closed = true
    this.disconnect()
    if (!close || !registration?.canClose) return
    // Unload delivery is best-effort; a missing notification leaves uncertainty.
    // Do not share the connection controller: cleanup must not abort this request.
    void fetch('/api/local/browser-presence/close', { method: 'POST', credentials: 'same-origin', cache: 'no-store', keepalive: true, headers: { 'X-App-Request': 'vehicle-manager', 'Content-Type': 'application/json' }, body: JSON.stringify({ token: registration.token, pageId: this.page.pageId, pageToken: this.page.pageToken, generation: registration.generation }) }).catch(() => {})
  }

  private freeze = (): void => { this.suspended = true; this.disconnect() }
  private resume = (): void => { if (this.stopped || this.page.closed) return; this.suspended = false; void this.ensure(true).catch(() => {}) }
  private visibility = (): void => { if (document.visibilityState === 'visible') this.resume() }
  private focus = (): void => { if (document.visibilityState === 'visible') this.resume() }

  dispose(): void {
    if (this.stopped) return
    this.stopped = true
    window.removeEventListener('pagehide', this.pageHide)
    window.removeEventListener('pageshow', this.resume)
    window.removeEventListener('online', this.resume)
    window.removeEventListener('focus', this.focus)
    document.removeEventListener('visibilitychange', this.visibility)
    document.removeEventListener('freeze', this.freeze)
    document.removeEventListener('resume', this.resume)
    this.disconnect()
  }
}

export function trackBrowserPresence(): () => void {
  activeTracker?.dispose()
  const tracker = new PresenceTracker(identity())
  activeTracker = tracker
  tracker.start()
  return () => { tracker.dispose(); if (activeTracker === tracker) activeTracker = undefined }
}

/** Reconnect only page presence; this never starts processes or replays business writes. */
export function repairBrowserPresence(options: { signal?: AbortSignal } = {}): Promise<void> {
  if (options.signal?.aborted) return Promise.reject(cancelled())
  return activeTracker ? withSignal(activeTracker.repair(), options.signal) : Promise.reject(failed())
}
