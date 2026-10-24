import { test } from 'node:test'
import assert from 'node:assert/strict'
import { api, download } from '../src/api.js'

test('downloads keep POST payloads workspace-bound and discard changed, logged-out or cancelled responses', async context => {
  const originalFetch = globalThis.fetch, originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document')
  const originalCreate = Object.getOwnPropertyDescriptor(URL, 'createObjectURL')!, originalRevoke = Object.getOwnPropertyDescriptor(URL, 'revokeObjectURL')!
  const clicks: { href: string; download: string }[] = []
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { createElement: () => {
    const anchor = { href: '', download: '', click: () => clicks.push({ href: anchor.href, download: anchor.download }) }
    return anchor
  } } })
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: () => 'blob:isolated-csv-test' })
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: () => {} })
  async function login(token: string) {
    globalThis.fetch = async () => new Response('{}', { headers: { 'Content-Type': 'application/json', 'X-Workspace-Token': token } })
    await api('/api/login', { method: 'POST', body: { username: 'isolated' } })
  }
  const zip = (token: string) => new Response('zip bytes', { headers: { 'Content-Type': 'application/zip', 'X-Workspace-Token': token } })
  try {
    await context.test('POST download includes JSON selection and the initiating workspace token; GET remains supported', async () => {
      await login('session-a:workspace-a:1')
      let captured: RequestInit | undefined
      globalThis.fetch = async (_url, options) => { captured = options; return zip('session-a:workspace-a:1') }
      const body = { vehicleIds: ['vehicle-a'], configuration: { language: 'zh' } }
      await download('/api/business/export/csv', 'selection.zip', { method: 'POST', body })
      assert.equal(captured!.method, 'POST')
      assert.equal((captured!.headers as Record<string, string>)['X-Workspace-Token'], 'session-a:workspace-a:1')
      assert.equal((captured!.headers as Record<string, string>)['Content-Type'], 'application/json')
      assert.deepEqual(JSON.parse(captured!.body as string), body)
      assert.equal(clicks.at(-1)!.download, 'selection.zip')
      await download('/api/business/export', 'legacy.json')
      assert.equal(captured!.method, 'GET'); assert.equal(captured!.body, undefined)
      assert.equal(clicks.at(-1)!.download, 'legacy.json')
    })
    await context.test('response headers for a different workspace cannot trigger a download', async () => {
      await login('session-a:workspace-a:1')
      const before = clicks.length
      globalThis.fetch = async () => zip('session-a:workspace-b:2')
      await assert.rejects(download('/api/business/export/csv', 'blocked.zip'), { message: 'WORKSPACE_CHANGED' })
      assert.equal(clicks.length, before)
    })
    for (const change of ['workspace switch', 'logout']) {
      await context.test(`${change} while ZIP bytes arrive discards the completed blob`, async () => {
        await login('session-a:workspace-a:1')
        const before = clicks.length
        let release!: (blob: Blob) => void, entered!: () => void
        const reading = new Promise<void>(resolve => { entered = resolve })
        globalThis.fetch = async () => ({ ok: true, headers: new Headers({ 'X-Workspace-Token': 'session-a:workspace-a:1' }), blob: () => { entered(); return new Promise<Blob>(resolve => { release = resolve }) } }) as Response
        const pending = download('/api/business/export/csv', 'blocked.zip')
        await reading
        if (change === 'workspace switch') await login('session-b:workspace-b:1')
        else {
          globalThis.fetch = async () => new Response('{}')
          await api('/api/logout', { method: 'POST' })
        }
        release(new Blob(['zip bytes']))
        await assert.rejects(pending, { message: 'WORKSPACE_CHANGED' })
        assert.equal(clicks.length, before)
      })
    }
    await context.test('unmount cancellation aborts the fetch without creating a download', async () => {
      await login('session-a:workspace-a:1')
      const controller = new AbortController(), before = clicks.length
      globalThis.fetch = async (_url, options) => new Promise<Response>((_resolve, reject) => options!.signal!.addEventListener('abort', () => reject(new DOMException('Cancelled', 'AbortError')), { once: true }))
      const pending = download('/api/business/export/csv', 'blocked.zip', { signal: controller.signal })
      controller.abort()
      await assert.rejects(pending, { name: 'AbortError' })
      assert.equal(clicks.length, before)
    })
  } finally {
    globalThis.fetch = originalFetch
    if (originalDocument) Object.defineProperty(globalThis, 'document', originalDocument)
    else Reflect.deleteProperty(globalThis, 'document')
    Object.defineProperty(URL, 'createObjectURL', originalCreate)
    Object.defineProperty(URL, 'revokeObjectURL', originalRevoke)
  }
})
