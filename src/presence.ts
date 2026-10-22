export function startPresence() {
  let socket: WebSocket | undefined
  let retry: ReturnType<typeof setTimeout> | undefined
  let suspended = false
  function reconnect() {
    if (!suspended) retry = setTimeout(() => { void connect() }, 2000)
  }
  async function connect() {
    try {
      const response = await fetch('/api/local/presence-token', { method: 'POST', headers: { 'X-App-Request': 'vehicle-manager' } })
      if (!response.ok) throw new Error('Presence unavailable')
      const { token } = await response.json() as { token: string | null }
      if (!token || suspended) return
      const url = new URL('/api/local/presence', location.href)
      url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
      const current = new WebSocket(url, ['vehicle-manager', token])
      socket = current
      current.onclose = () => { if (socket === current) { socket = undefined; reconnect() } }
      current.onerror = () => { current.close() }
    } catch { reconnect() }
  }
  window.addEventListener('pagehide', () => {
    suspended = true; clearTimeout(retry)
    socket?.close(); socket = undefined
  })
  window.addEventListener('pageshow', event => { if (event.persisted) { suspended = false; void connect() } })
  void connect()
}