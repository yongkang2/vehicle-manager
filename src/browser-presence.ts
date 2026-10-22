export function trackBrowserPresence(): () => void {
  let stopped = false, suspended = false, generation = 0, retryDelay = 1000
  let retryTimer: number | undefined
  let request: AbortController | undefined
  let connection: WebSocket | undefined
  function clearRetry() {
    if (retryTimer !== undefined) window.clearTimeout(retryTimer)
    retryTimer = undefined
  }
  function retry() {
    if (stopped || suspended || retryTimer !== undefined) return
    retryTimer = window.setTimeout(() => { retryTimer = undefined; void connect() }, retryDelay)
    retryDelay = Math.min(retryDelay * 2, 15000)
  }
  async function connect() {
    if (stopped || suspended || connection || request) return
    const currentGeneration = ++generation, controller = new AbortController()
    request = controller
    try {
      const response = await fetch('/api/local/browser-presence-token', { method: 'POST', headers: { 'X-App-Request': 'vehicle-manager' }, signal: controller.signal })
      if (!response.ok) throw new Error('Browser presence unavailable')
      const result = await response.json() as { token?: unknown }
      if (typeof result.token !== 'string' || !result.token) throw new Error('Invalid browser presence response')
      if (stopped || suspended || generation !== currentGeneration) return
      const url = new URL('/api/local/browser-presence', window.location.href)
      url.protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
      url.searchParams.set('token', result.token)
      const socket = new WebSocket(url)
      connection = socket
      socket.onopen = () => { if (generation === currentGeneration && connection === socket) retryDelay = 1000 }
      socket.onclose = () => {
        if (generation !== currentGeneration || connection !== socket) return
        connection = undefined
        retry()
      }
      socket.onerror = () => { if (generation === currentGeneration && connection === socket) socket.close() }
    } catch {
      if (generation === currentGeneration && !controller.signal.aborted) retry()
    } finally { if (request === controller) request = undefined }
  }
  function disconnect() {
    generation++
    clearRetry()
    request?.abort(); request = undefined
    const socket = connection
    connection = undefined
    if (socket && socket.readyState < WebSocket.CLOSING) socket.close()
  }
  function hide() { suspended = true; disconnect() }
  function resume() {
    suspended = false
    if (connection?.readyState === WebSocket.CLOSED) { connection = undefined; generation++ }
    if (!connection && !request) { clearRetry(); void connect() }
  }
  // Hidden or minimized pages stay connected; pagehide means navigation/closing.
  window.addEventListener('pagehide', hide)
  window.addEventListener('pageshow', resume)
  window.addEventListener('online', resume)
  document.addEventListener('resume', resume)
  void connect()
  return () => {
    stopped = true
    window.removeEventListener('pagehide', hide)
    window.removeEventListener('pageshow', resume)
    window.removeEventListener('online', resume)
    document.removeEventListener('resume', resume)
    disconnect()
  }
}
