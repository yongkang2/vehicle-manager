import { test } from 'node:test'
import assert from 'node:assert/strict'
import { api, probeLocalService } from '../src/api.js'
import { WorkspaceRecovery } from '../src/workspace-recovery.js'
import { readWithDeadline } from '../src/read-deadline.js'

const turn = () => new Promise<void>(resolve => setImmediate(resolve))
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done }); return { promise, resolve } }

test('explicit recovery coalesces attempts and only performs health, presence and fresh reads in order', async () => {
  const recovery = new WorkspaceRecovery(), health = deferred(), calls: string[] = []
  const steps = {
    cancelReads: () => { calls.push('cancel') },
    probe: async () => { calls.push('health'); await health.promise },
    repair: async () => { calls.push('presence') },
    reload: async () => { calls.push('read') },
  }
  const first = recovery.run(steps), second = recovery.run(steps)
  assert.equal(first, second); assert.equal(recovery.busy, true)
  await turn(); assert.deepEqual(calls, ['cancel', 'health'])
  health.resolve(); await first
  assert.deepEqual(calls, ['cancel', 'health', 'presence', 'read']); assert.equal(recovery.busy, false)
})

test('stalled health and refresh reads stop at their deadlines even if transport ignores abort', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  for (const stage of ['health', 'presence', 'read']) {
    const recovery = new WorkspaceRecovery(), calls: string[] = [], signals: AbortSignal[] = []
    const step = (name: string) => async (signal: AbortSignal) => {
      calls.push(name); signals.push(signal)
      if (stage === name) await new Promise<void>(() => {})
    }
    const job = recovery.run({ cancelReads() {}, probe: step('health'), repair: step('presence'), reload: step('read') })
    const rejected = assert.rejects(job, new RegExp(stage === 'read' ? 'REFRESH_TIMEOUT' : 'LOCAL_SERVICE_UNAVAILABLE'))
    await turn(); t.mock.timers.tick(stage === 'read' ? 30000 : 5000); await rejected
    assert.equal(recovery.busy, false)
    assert.equal(signals.at(-1)?.aborted, true)
    assert.deepEqual(calls, ['health', 'presence', 'read'].slice(0, ['health', 'presence', 'read'].indexOf(stage) + 1))
  }
})

test('workspace disposal cancels recovery without starting later steps', async () => {
  const recovery = new WorkspaceRecovery(), calls: string[] = [], health = deferred()
  const job = recovery.run({ cancelReads() {}, probe: async () => { await health.promise }, repair: async () => { calls.push('presence') }, reload: async () => { calls.push('read') } })
  const rejected = assert.rejects(job, { name: 'AbortError' })
  recovery.cancel(); await rejected; health.resolve(); await turn()
  assert.deepEqual(calls, []); assert.equal(recovery.busy, false)
})

test('read deadline covers response-body stalls and prevents late completion from winning', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const late = deferred()
  let signal: AbortSignal | undefined
  const job = readWithDeadline(async current => { signal = current; await late.promise; return 'late' }, { timeoutMs: 5000, timeoutError: new Error('deadline') })
  const rejected = assert.rejects(job, /deadline/)
  await turn(); t.mock.timers.tick(5000); await rejected
  assert.equal(signal?.aborted, true)
  late.resolve(); await turn()
})

test('local recovery probe validates service, user and workspace without replacing the current scope', async t => {
  const original = globalThis.fetch, token = 'workspace-a', instanceId = 'isolated-service'
  const response = (data: unknown, workspace = token) => new Response(JSON.stringify(data), { headers: { 'x-workspace-token': workspace } })
  t.after(() => { globalThis.fetch = original })
  globalThis.fetch = async () => response({ instanceId, user: { id: 'member-a' } })
  await api('/api/bootstrap')
  const probe = () => probeLocalService('member-a', new AbortController().signal)
  let requested = ''
  globalThis.fetch = async (url, options) => { requested = String(url); assert.equal(options?.cache, 'no-store'); return response({ instanceId, user: { id: 'member-a' } }) }
  await probe(); assert.equal(requested, '/api/bootstrap', 'health must not touch shared-folder status')
  for (const data of [{ instanceId: 'different-service', user: { id: 'member-a' } }, { instanceId, user: null }, { instanceId, user: { id: 'member-b' } }]) {
    globalThis.fetch = async () => response(data)
    await assert.rejects(probe(), /RECOVERY_SESSION_CHANGED/)
  }
  globalThis.fetch = async () => response({ instanceId, user: { id: 'member-a' } }, 'workspace-b')
  await assert.rejects(probe(), /WORKSPACE_CHANGED/)
  globalThis.fetch = async () => response({ instanceId, user: { id: 'member-a' } })
  await probe()
  globalThis.fetch = async () => { throw new TypeError('connection refused') }
  await assert.rejects(probe(), /LOCAL_SERVICE_UNAVAILABLE/)
})
