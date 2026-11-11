import { test } from 'node:test'
import assert from 'node:assert/strict'
import { WorkspaceLoader } from '../src/workspace-loader.js'
import type { WorkspaceSnapshot } from '../shared/workspace.js'

const snapshot = (revision: string, data = true): WorkspaceSnapshot => ({ revision, ...(data ? { data: { historyRevision: 0, records: [], catalog: { enabled: false, types: [] }, revisionSummaries: [], audit: [], quarantined: [] } } : {}), sync: { phase: 'ready', pending: 0, error: null, conflicts: [], quarantined: 0, revision: 'shared', lastSync: null } })
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done }); return { promise, resolve } }

test('shows local data before a slow shared refresh and requests only changes on later polls', async () => {
  const loader = new WorkspaceLoader(), shared = deferred<WorkspaceSnapshot>(), calls: string[] = [], accepted: WorkspaceSnapshot[] = []
  const job = loader.load(async <T>(url: string) => { calls.push(url); return (url.includes('local=1') ? snapshot('local') : await shared.promise) as T }, result => accepted.push(result), { localFirst: true })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(accepted[0].revision, 'local'); assert.equal(loader.busy, true)
  assert.match(calls[1], /known=local/)
  shared.resolve(snapshot('local', false)); await job
  assert.equal(accepted[1].data, undefined, 'unchanged response does not replace displayed arrays')
  assert.equal(loader.busy, false)
  await loader.load(async <T>(url: string) => { assert.match(url, /known=local/); return snapshot('local', false) as T }, result => accepted.push(result))
})

test('late responses cannot overwrite a newer save or a different workspace', async () => {
  const loader = new WorkspaceLoader(), slow = deferred<WorkspaceSnapshot>(), accepted: string[] = []
  const old = loader.load(async <T>() => await slow.promise as T, value => accepted.push(value.revision))
  await loader.load(async <T>() => snapshot('after-save') as T, value => accepted.push(value.revision), { localOnly: true })
  slow.resolve(snapshot('before-save')); await old
  assert.deepEqual(accepted, ['after-save'])
  const previous = deferred<WorkspaceSnapshot>()
  const switching = loader.load(async <T>() => await previous.promise as T, value => accepted.push(value.revision))
  loader.invalidate(); previous.resolve(snapshot('previous-team')); await switching
  assert.deepEqual(accepted, ['after-save'])
  await loader.load(async <T>(url: string) => { assert.ok(!url.includes('known=')); return snapshot('new-team') as T }, value => accepted.push(value.revision))
})

test('refresh failures retain local data and manual refresh requests full validation', async () => {
  const loader = new WorkspaceLoader(), accepted: string[] = [], calls: string[] = []
  await assert.rejects(loader.load(async <T>(url: string) => {
    calls.push(url)
    if (url.includes('local=1')) return snapshot('local') as T
    throw new Error('NETWORK_ERROR')
  }, value => accepted.push(value.revision), { localFirst: true, full: true }), /NETWORK_ERROR/)
  assert.deepEqual(accepted, ['local']); assert.match(calls[1], /full=1/); assert.equal(loader.busy, false)
})

test('delta refresh replaces changed records, removes deleted records and falls back on a mismatched baseline', async () => {
  const loader = new WorkspaceLoader(), first = snapshot('first'), accepted: WorkspaceSnapshot[] = []
  const record = (id: string, owner: string) => ({ id, kind: 'vehicle' as const, vehicleId: null, data: { owner }, archived: false, version: 1, updated: '2026-11-11T00:00:00Z' })
  first.data!.records = [record('a', 'Before'), record('b', 'Removed')]
  await loader.load(async <T>() => first as T, value => accepted.push(value), { localOnly: true })
  const { records: _records, ...metadata } = first.data!
  await loader.load(async <T>(url: string) => {
    assert.match(url, /delta=1/)
    return { ...snapshot('second', false), patch: { baseRevision: 'first', upsert: [record('a', 'After'), record('c', 'New')], removed: ['b'], data: metadata } } as T
  }, value => accepted.push(value), { localOnly: true })
  assert.deepEqual(accepted.at(-1)!.data!.records.map(item => [item.id, item.data.owner]), [['a', 'After'], ['c', 'New']])
  let requests = 0
  await loader.load(async <T>(url: string) => {
    if (++requests === 1) return { ...snapshot('third', false), patch: { baseRevision: 'wrong', upsert: [], removed: [], data: metadata } } as T
    assert.doesNotMatch(url, /known=|delta=/)
    return snapshot('third') as T
  }, value => accepted.push(value), { localOnly: true })
  assert.equal(requests, 2)
  assert.equal(accepted.at(-1)!.revision, 'third')
})
