export class ApiError extends Error {}
let workspaceToken: string | null = null
const headersFor = () => ({ 'X-App-Request': 'vehicle-manager', ...(workspaceToken ? { 'X-Workspace-Token': workspaceToken } : {}) })
export async function api<T>(url: string, options: { method?: string; body?: unknown } = {}): Promise<T> {
  let response: Response
  const form = options.body instanceof FormData
  try { response = await fetch(url, { method: options.method || 'GET', headers: { ...headersFor(), ...(options.body && !form ? { 'Content-Type': 'application/json' } : {}) }, body: options.body ? form ? options.body as FormData : JSON.stringify(options.body) : undefined }) }
  catch { throw new ApiError('NETWORK_ERROR') }
  const result = await response.json().catch(() => ({ error: 'SERVER_ERROR' }))
  if (!response.ok) throw new ApiError(result.error || 'SERVER_ERROR')
  const token = response.headers.get('x-workspace-token')
  if (token) {
    if (!workspaceToken || ['/api/login', '/api/register', '/api/setup/configure', '/api/workspaces/select', '/api/workspaces/disconnect'].includes(url)) workspaceToken = token
    else if (token !== workspaceToken) throw new ApiError('WORKSPACE_CHANGED')
  }
  if (url === '/api/logout') workspaceToken = null
  return result as T
}
export async function download(url: string, filename: string, options: { method?: string; body?: unknown; signal?: AbortSignal } = {}): Promise<void> {
  const initiatingToken = workspaceToken
  const assertCurrent = () => {
    if (options.signal?.aborted) throw new DOMException('Download cancelled', 'AbortError')
    if (workspaceToken !== initiatingToken) throw new ApiError('WORKSPACE_CHANGED')
  }
  assertCurrent()
  const response = await fetch(url, { method: options.method || 'GET', headers: { ...headersFor(), ...(options.body ? { 'Content-Type': 'application/json' } : {}) }, body: options.body ? JSON.stringify(options.body) : undefined, signal: options.signal }).catch(error => {
    assertCurrent()
    if (error instanceof Error && error.name === 'AbortError') throw error
    throw new ApiError('NETWORK_ERROR')
  })
  assertCurrent()
  if (!response.ok) { const result = await response.json().catch(() => ({ error: 'SERVER_ERROR' })); assertCurrent(); throw new ApiError(result.error || 'SERVER_ERROR') }
  if (initiatingToken && response.headers.get('x-workspace-token') !== initiatingToken) throw new ApiError('WORKSPACE_CHANGED')
  const blob = await response.blob()
  assertCurrent()
  const address = URL.createObjectURL(blob), anchor = document.createElement('a')
  anchor.href = address; anchor.download = filename; anchor.click()
  setTimeout(() => URL.revokeObjectURL(address), 1000)
}
