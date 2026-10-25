import { test } from 'node:test'
import assert from 'node:assert/strict'
import { api, createWorkspaceScope } from '../src/api.js'

test('scoped requests keep JSON and photo bytes bound to the initiating authenticated workspace', async context => {
  const originalFetch = globalThis.fetch
  const tokenA = 'isolated-session:workspace-a:1', tokenB = 'isolated-session:workspace-b:2'
  const response = (value: unknown = {}, token = tokenA, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json', 'X-Workspace-Token': token } })
  async function login(token = tokenA) { globalThis.fetch = async () => response({}, token); await api('/api/login', { method: 'POST' }) }
  async function logout() { globalThis.fetch = async () => new Response('{}'); await api('/api/logout', { method: 'POST' }) }
  try {
    await context.test('JSON and FormData use captured private headers and honor the supplied signal', async () => {
      await login()
      const scope = createWorkspaceScope(), controller = new AbortController(), calls: RequestInit[] = []
      globalThis.fetch = async (_url, options) => { calls.push(options!); return response({ saved: true }) }
      const body = { version: 7, reason: 'Fictional change' }
      assert.deepEqual(await scope.request('/api/example', { method: 'PUT', body, signal: controller.signal }), { saved: true })
      assert.equal(calls[0].method, 'PUT'); assert.equal(calls[0].signal, controller.signal)
      assert.deepEqual(calls[0].headers, { 'X-App-Request': 'vehicle-manager', 'X-Workspace-Token': tokenA, 'Content-Type': 'application/json' })
      assert.deepEqual(JSON.parse(calls[0].body as string), body)
      const form = new FormData(); form.append('file', new Blob(['fictional']), 'qa.png')
      await scope.request('/api/example/photo', { method: 'POST', body: form })
      assert.equal(calls[1].body, form)
      assert.equal(new Headers(calls[1].headers).get('content-type'), null)
      await scope.request('/api/example', { method: 'PUT', body: null })
      assert.equal(calls[2].body, 'null')
    })
    await context.test('an unauthenticated scope never acquires a later login or sends a request', async () => {
      await logout(); const scope = createWorkspaceScope(); await login()
      let calls = 0; globalThis.fetch = async () => { calls++; return response() }
      await assert.rejects(scope.request('/api/example'), { message: 'WORKSPACE_CHANGED' })
      await assert.rejects(scope.blob('/api/example/photo'), { message: 'WORKSPACE_CHANGED' })
      assert.equal(calls, 0)
    })
    await context.test('old queued requests fail before fetch after a workspace switch', async () => {
      await login(); const scope = createWorkspaceScope(); await login(tokenB)
      let calls = 0; globalThis.fetch = async () => { calls++; return response({}, tokenB) }
      await assert.rejects(scope.request('/api/example', { method: 'PUT', body: { width: 120 } }), { message: 'WORKSPACE_CHANGED' })
      assert.equal(calls, 0)
    })
    await context.test('a response arriving after logout is rejected before its body is read', async () => {
      await login(); const scope = createWorkspaceScope()
      let release!: (value: Response) => void, reads = 0
      globalThis.fetch = async () => new Promise<Response>(resolve => { release = resolve })
      const pending = scope.request('/api/example')
      await logout()
      release({ ok: true, headers: new Headers({ 'X-Workspace-Token': tokenA }), json: async () => { reads++; return {} } } as Response)
      await assert.rejects(pending, { message: 'WORKSPACE_CHANGED' }); assert.equal(reads, 0)
    })
    for (const header of [undefined, tokenB]) {
      await context.test(`${header ? 'mismatching' : 'missing'} response tokens reject JSON and bytes without being adopted`, async () => {
        await login(); const scope = createWorkspaceScope()
        globalThis.fetch = async () => new Response('{}', { headers: header ? { 'X-Workspace-Token': header } : {} })
        await assert.rejects(scope.request('/api/example'), { message: 'WORKSPACE_CHANGED' })
        await assert.rejects(scope.blob('/api/example/photo'), { message: 'WORKSPACE_CHANGED' })
        globalThis.fetch = async (_url, options) => { assert.equal(new Headers(options?.headers).get('x-workspace-token'), tokenA); return response({ stillOriginal: true }) }
        assert.deepEqual(await scope.request('/api/example'), { stillOriginal: true })
      })
    }
    for (const method of ['request', 'blob'] as const) {
      for (const change of ['workspace switch', 'logout', 'logout and login with the same token'] as const) {
        await context.test(`${method} discards a completed body after ${change}`, async () => {
          await login(); const scope = createWorkspaceScope()
          let release!: (value: unknown) => void, entered!: () => void
          const reading = new Promise<void>(resolve => { entered = resolve })
          const body = () => { entered(); return new Promise(resolve => { release = resolve }) }
          globalThis.fetch = async () => ({ ok: true, headers: new Headers({ 'X-Workspace-Token': tokenA }), json: body, blob: body }) as Response
          const pending = scope[method]('/api/example')
          await reading
          if (change === 'workspace switch') await login(tokenB)
          else { await logout(); if (change === 'logout and login with the same token') await login() }
          release(method === 'blob' ? new Blob(['photo bytes']) : { saved: true })
          await assert.rejects(pending, { message: 'WORKSPACE_CHANGED' })
        })
      }
      await context.test(`${method} honors cancellation before fetch`, async () => {
        await login(); const scope = createWorkspaceScope(), controller = new AbortController(); controller.abort()
        let calls = 0; globalThis.fetch = async () => { calls++; return response() }
        await assert.rejects(scope[method]('/api/example', { signal: controller.signal }), { name: 'AbortError' })
        assert.equal(calls, 0)
      })
      await context.test(`${method} forwards cancellation during fetch`, async () => {
        await login(); const scope = createWorkspaceScope(), controller = new AbortController()
        globalThis.fetch = async (_url, options) => new Promise<Response>((_resolve, reject) => options!.signal!.addEventListener('abort', () => reject(new DOMException('Cancelled', 'AbortError')), { once: true }))
        const pending = scope[method]('/api/example', { signal: controller.signal }); controller.abort()
        await assert.rejects(pending, { name: 'AbortError' })
      })
      await context.test(`${method} checks cancellation after body bytes arrive even if transport ignores it`, async () => {
        await login(); const scope = createWorkspaceScope(), controller = new AbortController()
        let release!: (value: unknown) => void, entered!: () => void
        const reading = new Promise<void>(resolve => { entered = resolve })
        const body = () => { entered(); return new Promise(resolve => { release = resolve }) }
        globalThis.fetch = async () => ({ ok: true, headers: new Headers({ 'X-Workspace-Token': tokenA }), json: body, blob: body }) as Response
        const pending = scope[method]('/api/example', { signal: controller.signal }); await reading; controller.abort()
        release(method === 'blob' ? new Blob(['photo bytes']) : {})
        await assert.rejects(pending, { name: 'AbortError' })
      })
    }
    await context.test('API errors remain explicit, malformed JSON fails, and network errors are normalized', async () => {
      await login(); const scope = createWorkspaceScope()
      globalThis.fetch = async () => response({ error: 'PHOTO_NOT_FOUND' }, tokenA, 404)
      await assert.rejects(scope.blob('/api/example/photo'), { message: 'PHOTO_NOT_FOUND' })
      globalThis.fetch = async () => response({ error: 'VERSION_CONFLICT' }, tokenA, 409)
      await assert.rejects(scope.request('/api/example'), { message: 'VERSION_CONFLICT' })
      globalThis.fetch = async () => new Response('invalid JSON', { headers: { 'X-Workspace-Token': tokenA } })
      await assert.rejects(scope.request('/api/example'), { message: 'SERVER_ERROR' })
      globalThis.fetch = async () => { throw new TypeError('Disconnected') }
      await assert.rejects(scope.request('/api/example'), { message: 'NETWORK_ERROR' })
    })
  } finally { globalThis.fetch = originalFetch }
})
