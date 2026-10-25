export class ApiError extends Error {}
let workspaceToken: string | null = null
let workspaceGeneration = 0
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
    if (!workspaceToken || ['/api/login', '/api/register', '/api/setup/configure', '/api/workspaces/select', '/api/workspaces/disconnect'].includes(url)) { workspaceToken = token; workspaceGeneration += 1 }
    else if (token !== workspaceToken) throw new ApiError('WORKSPACE_CHANGED')
  }
  if (url === '/api/logout') { workspaceToken = null; workspaceGeneration += 1 }
  return result as T
}
type WorkspaceRequestOptions = { method?: string; body?: unknown; signal?: AbortSignal }
export function createWorkspaceScope() {
  const initiatingToken = workspaceToken, initiatingGeneration = workspaceGeneration
  const assertCurrent = (signal?: AbortSignal) => {
    if (signal?.aborted) throw signal.reason ?? new DOMException('Request cancelled', 'AbortError')
    if (!initiatingToken || workspaceToken !== initiatingToken || workspaceGeneration !== initiatingGeneration) throw new ApiError('WORKSPACE_CHANGED')
  }
  async function responseFor(url: string, options: WorkspaceRequestOptions = {}) {
    assertCurrent(options.signal)
    const form = options.body instanceof FormData
    const headers = { 'X-App-Request': 'vehicle-manager', 'X-Workspace-Token': initiatingToken!, ...(options.body !== undefined && !form ? { 'Content-Type': 'application/json' } : {}) }
    let response: Response
    try { response = await fetch(url, { method: options.method || 'GET', headers, body: options.body === undefined ? undefined : form ? options.body as FormData : JSON.stringify(options.body), signal: options.signal }) }
    catch (error) {
      assertCurrent(options.signal)
      if (error instanceof Error && error.name === 'AbortError') throw error
      throw new ApiError('NETWORK_ERROR')
    }
    assertCurrent(options.signal)
    if (response.headers.get('x-workspace-token') !== initiatingToken) throw new ApiError('WORKSPACE_CHANGED')
    return response
  }
  async function jsonFor<T>(response: Response, signal?: AbortSignal): Promise<T> {
    let result: unknown
    try { result = await response.json() }
    catch (error) {
      assertCurrent(signal)
      if (error instanceof Error && error.name === 'AbortError') throw error
      throw new ApiError('SERVER_ERROR')
    }
    assertCurrent(signal)
    if (!response.ok) throw new ApiError(typeof result === 'object' && result !== null && 'error' in result && typeof result.error === 'string' ? result.error : 'SERVER_ERROR')
    return result as T
  }
  return {
    async request<T>(url: string, options: WorkspaceRequestOptions = {}): Promise<T> {
      return jsonFor<T>(await responseFor(url, options), options.signal)
    },
    async blob(url: string, options: { signal?: AbortSignal } = {}): Promise<Blob> {
      const response = await responseFor(url, options)
      if (!response.ok) return jsonFor<never>(response, options.signal)
      let blob: Blob
      try { blob = await response.blob() }
      catch (error) {
        assertCurrent(options.signal)
        if (error instanceof Error && error.name === 'AbortError') throw error
        throw new ApiError('NETWORK_ERROR')
      }
      assertCurrent(options.signal)
      return blob
    },
  }
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
