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
export async function download(url: string, filename: string): Promise<void> {
  const response = await fetch(url, { headers: headersFor() }).catch(() => { throw new ApiError('NETWORK_ERROR') })
  if (!response.ok) { const result = await response.json().catch(() => ({ error: 'SERVER_ERROR' })); throw new ApiError(result.error) }
  const blob = await response.blob(), address = URL.createObjectURL(blob), anchor = document.createElement('a')
  anchor.href = address; anchor.download = filename; anchor.click()
  setTimeout(() => URL.revokeObjectURL(address), 1000)
}