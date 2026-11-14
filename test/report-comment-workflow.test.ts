import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { BusinessRecord, ReportCommentRequest } from '../shared/business.js'
import { ApiError } from '../src/api.js'
import type { createWorkspaceScope } from '../src/api.js'
import { ReportCommentWorkflow } from '../src/report-comment-workflow.js'

type Scope = ReturnType<typeof createWorkspaceScope>
type Request = { url: string; method?: string; body?: unknown; signal?: AbortSignal }
const report = (id = 'report-a', version = 1, comment = ''): BusinessRecord => ({ id, kind: 'report', vehicleId: 'vehicle-a', archived: false, version, updated: '2026-11-14T00:00:00Z', data: { name: 'Fictional report.xlsx', comment, checksum: 'original-file', parsed: { vin: 'TEST0000000000001' } } })
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done }); return { promise, resolve } }
function fixture(options: { record?: BusinessRecord; request?: (request: Request) => Promise<unknown>; saved?: (record: BusinessRecord) => Promise<void>; inspected?: (record: BusinessRecord) => void; busy?: (busy: boolean) => void } = {}) {
  const requests: Request[] = [], confirmed: BusinessRecord[] = [], inspected: BusinessRecord[] = [], busy: boolean[] = []
  let current = true
  const scope: Scope = {
    assertCurrent(signal) { signal?.throwIfAborted(); if (!current) throw new ApiError('WORKSPACE_CHANGED') },
    async request<T>(url: string, request = {}) {
      const call = { url, ...request }
      requests.push(call)
      return await (options.request?.(call) || Promise.resolve(report(options.record?.id, (options.record?.version || 1) + 1, 'Saved text'))) as T
    },
    async blob() { throw Error('No blob request belongs to comment editing') },
  }
  const workflow = new ReportCommentWorkflow({ record: options.record || report(), scope, onSaved: async saved => { confirmed.push(saved); await options.saved?.(saved) }, onInspected: record => { inspected.push(record); options.inspected?.(record) }, onBusyChange: value => { busy.push(value); options.busy?.(value) } })
  return { workflow, requests, confirmed, inspected, busy, switchWorkspace: () => { current = false } }
}

test('comment save sends only the captured report version, text and change reason', async () => {
  const f = fixture({ record: report('report/a', 7) })
  await f.workflow.save('  Shared finding\nSecond line  ', 'Explain this annotation')
  assert.equal(f.requests.length, 1)
  assert.equal(f.requests[0].url, '/api/business/reports/report%2Fa/comment')
  assert.equal(f.requests[0].method, 'PUT')
  assert.deepEqual(f.requests[0].body, { comment: '  Shared finding\nSecond line  ', version: 7, reason: 'Explain this annotation' })
  assert.equal(f.confirmed.length, 1)
  assert.equal(f.workflow.getSnapshot().state, 'saved')
  assert.deepEqual(f.busy, [true, false]); f.workflow.dispose()
})

test('an uncertain save cannot be resubmitted until explicit inspection and review', async () => {
  let writes = 0
  const f = fixture({ request: async call => {
    if (call.method === 'PUT') { writes++; if (writes === 1) throw new ApiError('NETWORK_ERROR'); return report('report-a', 3, 'New finding') }
    return [report('report-a', 2, 'Original submitted draft')]
  } })
  await assert.rejects(f.workflow.save('Original submitted draft', 'Original reason'), /NETWORK_ERROR/)
  assert.equal(f.workflow.getSnapshot().state, 'blocked')
  await f.workflow.save('Original submitted draft', 'Original reason')
  assert.equal(writes, 1, 'No automatic or unreviewed retry')
  await f.workflow.inspect()
  assert.equal(f.workflow.getSnapshot().state, 'review')
  assert.equal(f.workflow.getSnapshot().record.version, 1, 'Inspection alone does not replace the edit base')
  await f.workflow.save('New finding', 'New reason')
  assert.equal(writes, 1)
  f.workflow.acceptInspection()
  await f.workflow.save('New finding', 'New reason')
  assert.equal(writes, 2)
  assert.equal((f.requests.at(-1)!.body as ReportCommentRequest).version, 2)
  f.workflow.dispose()
})

test('a version conflict requires a freshly inspected base before another write', async () => {
  let writes = 0
  const f = fixture({ request: async call => {
    if (call.method === 'PUT') { writes++; if (writes === 1) throw new ApiError('VERSION_CONFLICT'); return report('report-a', 6, 'Reviewed draft') }
    return [report('report-a', 5, 'Another member updated this')]
  } })
  await assert.rejects(f.workflow.save('Preserved draft', 'Preserved reason'), /VERSION_CONFLICT/)
  await f.workflow.inspect(); f.workflow.acceptInspection()
  assert.equal(f.workflow.getSnapshot().record.version, 5)
  await f.workflow.save('Reviewed draft', 'Keep the reviewed findings')
  assert.equal((f.requests.at(-1)!.body as ReportCommentRequest).version, 5)
  f.workflow.dispose()
})

test('confirmed write remains saved when the subsequent workspace refresh fails', async () => {
  const visible: string[] = []
  const f = fixture({ saved: async saved => { visible.push(String(saved.data.comment)); throw new ApiError('NETWORK_ERROR') } })
  await assert.rejects(f.workflow.save('Draft', 'Reason'), /NETWORK_ERROR/)
  assert.deepEqual(visible, ['Saved text'], 'Confirmed data reaches the UI before refresh failure')
  assert.equal(f.workflow.getSnapshot().state, 'saved')
  assert.equal(f.workflow.getSnapshot().refreshFailed, true)
  assert.equal(f.workflow.getSnapshot().record.version, 2)
  await f.workflow.save('Draft', 'Reason')
  assert.equal(f.requests.length, 1, 'A failed refresh cannot turn into another mutation')
  assert.deepEqual(f.busy, [true, false]); f.workflow.dispose()
})

test('a response from the previous workspace cannot upsert confirmed data', async () => {
  const response = deferred<BusinessRecord>()
  const f = fixture({ request: () => response.promise })
  const saving = f.workflow.save('Draft', 'Reason')
  f.switchWorkspace(); response.resolve(report('report-a', 2, 'Stale response'))
  await assert.rejects(saving, /WORKSPACE_CHANGED/)
  assert.equal(f.confirmed.length, 0)
  assert.equal(f.workflow.getSnapshot().error, 'WORKSPACE_CHANGED')
  assert.equal(f.workflow.getSnapshot().inspectable, false)
  assert.deepEqual(f.busy, [true, false]); f.workflow.dispose()
})

test('closing report A releases its busy lease once; its late response cannot affect report B', async () => {
  const first = deferred<BusinessRecord>(), second = deferred<BusinessRecord>(), busy: boolean[] = []
  const a = fixture({ request: () => first.promise, busy: value => busy.push(value) })
  const pendingA = a.workflow.save('A draft', 'A reason')
  a.workflow.dispose()
  const b = fixture({ record: report('report-b'), request: () => second.promise, busy: value => busy.push(value) })
  const pendingB = b.workflow.save('B draft', 'B reason')
  first.resolve(report('report-a', 2, 'A saved'))
  await assert.rejects(pendingA, { name: 'AbortError' })
  assert.equal(a.confirmed.length, 0)
  assert.equal(b.workflow.getSnapshot().busy, true)
  assert.deepEqual(busy, [true, false, true], 'A late completion must not release B\'s lease')
  second.resolve(report('report-b', 2, 'B saved')); await pendingB
  assert.equal(b.confirmed[0].id, 'report-b')
  assert.deepEqual(busy, [true, false, true, false]); b.workflow.dispose()
})

test('a different report in the save response is never applied to the opened report', async () => {
  const f = fixture({ request: async () => report('report-b', 2) })
  await assert.rejects(f.workflow.save('Draft', 'Reason'), /SERVER_ERROR/)
  assert.equal(f.confirmed.length, 0)
  assert.equal(f.workflow.getSnapshot().record.id, 'report-a')
  assert.equal(f.workflow.getSnapshot().state, 'blocked'); f.workflow.dispose()
})

test('definite validation rejection stays editable and archived reports cannot be saved', async () => {
  const f = fixture({ request: async () => { throw new ApiError('REASON_REQUIRED') } })
  await assert.rejects(f.workflow.save('Draft', ''), /REASON_REQUIRED/)
  assert.equal(f.workflow.getSnapshot().state, 'editing'); f.workflow.dispose()
  const archived = fixture({ record: { ...report(), archived: true } })
  await archived.workflow.save('Draft', 'Reason')
  assert.equal(archived.requests.length, 0); archived.workflow.dispose()
})

test('a report archived by another member stays read-only after conflict inspection', async () => {
  const f = fixture({ request: async call => {
    if (call.method === 'PUT') throw new ApiError('VERSION_CONFLICT')
    return [{ ...report('report-a', 2), archived: true }]
  } })
  await assert.rejects(f.workflow.save('Draft', 'Reason'), /VERSION_CONFLICT/)
  await f.workflow.inspect(); f.workflow.acceptInspection()
  await f.workflow.save('Still retained draft', 'Reason')
  assert.equal(f.requests.filter(call => call.method === 'PUT').length, 1)
  assert.equal(f.workflow.getSnapshot().record.archived, true); f.workflow.dispose()
})

test('inspection updates the visible saved comment after a committed write loses its response', async () => {
  let visible = report('report-a', 1, 'Previous comment')
  const committed = report('report-a', 2, 'Submitted comment')
  const f = fixture({ record: visible, inspected: current => { visible = current }, request: async call => {
    if (call.method === 'PUT') throw new ApiError('NETWORK_ERROR')
    return [committed]
  } })
  await assert.rejects(f.workflow.save('Submitted comment', 'Review finding'), /NETWORK_ERROR/)
  assert.equal(visible.data.comment, 'Previous comment')
  await f.workflow.inspect()
  assert.equal(visible.data.comment, 'Submitted comment', 'Parent details receive authoritative inspected data before the editor closes')
  assert.equal(visible.version, 2)
  assert.equal(f.workflow.getSnapshot().state, 'review')
  assert.equal(f.workflow.getSnapshot().record.version, 1, 'Draft review base is not silently replaced')
  assert.equal(f.confirmed.length, 0, 'Reading current data is not presented as a newly confirmed write')
  f.workflow.acceptInspection(); f.workflow.dispose()
  assert.equal(visible.data.comment, 'Submitted comment')
  assert.equal(f.requests.filter(call => call.method === 'PUT').length, 1, 'Inspection and closing do not duplicate a mutation')
})

test('inspection from an old workspace or disposed report never updates parent records', async () => {
  for (const invalidate of ['workspace', 'disposed']) {
    const response = deferred<BusinessRecord[]>()
    const f = fixture({ request: async call => {
      if (call.method === 'PUT') throw new ApiError('NETWORK_ERROR')
      return response.promise
    } })
    await assert.rejects(f.workflow.save('Draft', 'Reason'), /NETWORK_ERROR/)
    const pending = f.workflow.inspect()
    if (invalidate === 'workspace') f.switchWorkspace()
    else f.workflow.dispose()
    response.resolve([report('report-a', 2, 'Stale inspected comment')])
    await assert.rejects(pending, invalidate === 'workspace' ? /WORKSPACE_CHANGED/ : { name: 'AbortError' })
    assert.equal(f.inspected.length, 0)
    assert.equal(f.confirmed.length, 0)
    f.workflow.dispose()
  }
})
