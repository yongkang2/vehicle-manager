import { test } from 'node:test'
import assert from 'node:assert/strict'
import { api, ApiError, createWorkspaceScope, download } from '../src/api.js'

test('request IDs survive JSON, scoped and download failures without changing error codes', async () => {
  const previous = globalThis.fetch, requestId = '123e4567-e89b-12d3-a456-426614174000'
  try {
    globalThis.fetch = async () => new Response('{}', { headers: { 'X-Workspace-Token': 'diagnostic-workspace' } })
    await api('/api/login', { method: 'POST' })
    const scope = createWorkspaceScope()
    globalThis.fetch = async () => new Response('{"error":"SHARE_UNAVAILABLE"}', { status: 409, headers: { 'X-Request-Id': requestId, 'X-Workspace-Token': 'diagnostic-workspace' } })
    for (const operation of [() => api('/api/status'), () => scope.request('/api/business/workspace'), () => scope.blob('/api/business/files/test'), () => download('/api/business/backup', 'unused.zip')]) {
      await assert.rejects(operation(), error => error instanceof ApiError && error.message === 'SHARE_UNAVAILABLE' && error.requestId === requestId)
    }
  } finally { globalThis.fetch = previous }
})
