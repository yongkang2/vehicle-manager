import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ATTACHMENT_BATCH_LIMIT, ATTACHMENT_EXTENSIONS, ATTACHMENT_MAX_FILE_BYTES, attachmentFileError } from '../shared/attachments.js'
import type { BusinessRecord } from '../shared/business.js'
import { AttachmentUploadQueue } from '../src/attachment-upload-queue.js'
import { ApiError } from '../src/api.js'
import type { createWorkspaceScope } from '../src/api.js'

type Scope = ReturnType<typeof createWorkspaceScope>
const file = (name: string) => new File(['Fictional attachment'], name)
const saved = (name: string, vehicleId = 'vehicle-a'): BusinessRecord => ({ id: `saved-${name}`, kind: 'attachment', vehicleId, data: { name }, archived: false, version: 1, updated: '2026-10-26T00:00:00Z' })
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done }); return { promise, resolve } }
function fixture(options: { upload?: (filename: string, signal: AbortSignal) => Promise<BusinessRecord>; refresh?: (signal: AbortSignal) => Promise<void> } = {}) {
  const calls: { url: string; filename: string; signal: AbortSignal }[] = [], busy: boolean[] = []
  let refreshes = 0, valid = true
  const scope: Scope = {
    assertCurrent(signal) { signal?.throwIfAborted(); if (!valid) throw new ApiError('WORKSPACE_CHANGED') },
    async request<T>(url: string, request = {}) {
      const { body, signal, method } = request as { body: FormData; signal: AbortSignal; method: string }
      assert.equal(method, 'POST'); assert.deepEqual([...body.keys()], ['file'])
      const upload = body.get('file') as File
      calls.push({ url, filename: upload.name, signal })
      return (await (options.upload?.(upload.name, signal) ?? Promise.resolve(saved(upload.name)))) as T
    },
    async blob() { throw new Error('Unexpected blob request') },
  }
  const queue = new AttachmentUploadQueue({ scope, vehicleId: 'vehicle-a', onRefresh: async signal => { refreshes++; await options.refresh?.(signal) }, onBusyChange: value => { busy.push(value) } })
  return { queue, calls, busy, invalidate: () => { valid = false }, get refreshes() { return refreshes } }
}

test('attachment file validation retains seven formats, uppercase JFIF and exact 10 MiB boundary', () => {
  assert.equal(ATTACHMENT_BATCH_LIMIT, 8)
  for (const extension of ATTACHMENT_EXTENSIONS) assert.equal(attachmentFileError({ name: `fictional${extension.toUpperCase()}`, size: ATTACHMENT_MAX_FILE_BYTES }), undefined)
  assert.equal(attachmentFileError({ name: 'fictional.jfif', size: ATTACHMENT_MAX_FILE_BYTES + 1 }), 'FILE_TOO_LARGE')
  for (const name of ['fictional.txt', 'fictional.jfif.exe', 'no-extension']) assert.equal(attachmentFileError({ name, size: 1 }), 'FILE_TYPE_NOT_ALLOWED')
})

test('queue keeps the first eight rows, retains invalid files and permits removing and adding selections', () => {
  const { queue } = fixture(), original = queue.getSnapshot()
  assert.equal(queue.getSnapshot(), original)
  const selection = [file('invalid.txt'), ...Array.from({ length: 9 }, (_, index) => file(`${index}.JFIF`))]
  queue.add(selection)
  const snapshot = queue.getSnapshot()
  assert.equal(snapshot.rows.length, 8); assert.equal(snapshot.limited, true)
  assert.deepEqual(snapshot.rows.map(row => row.file), selection.slice(0, 8))
  assert.equal(snapshot.rows[0].status, 'invalid'); assert.equal(snapshot.rows[0].error, 'FILE_TYPE_NOT_ALLOWED')
  assert.equal(original.rows.length, 0, 'Earlier snapshots must not be mutated')
  const removed = snapshot.rows[2].id
  queue.remove(removed); queue.add([file('next.pdf')])
  assert.equal(queue.getSnapshot().rows.at(-1)?.file.name, 'next.pdf')
  assert.equal(queue.getSnapshot().rows.some(row => row.id === removed), false)
  assert.equal(queue.getSnapshot().limited, false)
  assert.equal(new Set(queue.getSnapshot().rows.map(row => row.id)).size, 8)
  queue.dispose()
})

test('upload runs sequentially, holds the original target, and locks all selection changes while busy', async () => {
  const first = deferred<BusinessRecord>(), entered = deferred<void>()
  const f = fixture({ upload: async name => { if (name === 'one.pdf') { entered.resolve(); return first.promise }; return saved(name) } })
  f.queue.add([file('one.pdf'), file('two.png')])
  const original = f.queue.getSnapshot(), running = f.queue.run('pending')
  await entered.promise
  assert.equal(f.calls.length, 1); assert.equal(f.queue.getSnapshot().busy, true)
  f.queue.add([file('ignored.pdf')]); f.queue.remove(original.rows[0].id); f.queue.clear()
  await f.queue.run('pending'); await f.queue.refresh()
  assert.equal(f.calls.length, 1); assert.equal(f.refreshes, 0); assert.equal(f.queue.getSnapshot().rows.length, 2)
  first.resolve(saved('one.pdf')); await running
  assert.deepEqual(f.calls.map(call => call.filename), ['one.pdf', 'two.png'])
  assert(f.calls.every(call => call.url === '/api/business/vehicles/vehicle-a/attachments'))
  assert.deepEqual(f.queue.getSnapshot().rows.map(row => row.status), ['uploaded', 'uploaded'])
  assert.equal(f.refreshes, 1); assert.deepEqual(f.busy, [true, false])
  f.queue.dispose()
})

test('mixed batches skip invalid rows, keep successful uploads, and retry only definite failures', async () => {
  let failedOnce = false
  const f = fixture({ upload: async name => {
    if (name === 'bad-content.jfif' && !failedOnce) { failedOnce = true; throw new ApiError('FILE_TYPE_NOT_ALLOWED') }
    return saved(name)
  } })
  f.queue.add([file('one.pdf'), file('bad-content.jfif'), file('invalid.txt'), file('last.JFIF')])
  await f.queue.run('pending')
  assert.deepEqual(f.queue.getSnapshot().rows.map(row => row.status), ['uploaded', 'failed', 'invalid', 'uploaded'])
  assert.deepEqual(f.calls.map(call => call.filename), ['one.pdf', 'bad-content.jfif', 'last.JFIF'])
  await f.queue.run('failed'); await f.queue.run('failed'); await f.queue.run('pending')
  assert.deepEqual(f.calls.map(call => call.filename), ['one.pdf', 'bad-content.jfif', 'last.JFIF', 'bad-content.jfif'])
  assert.deepEqual(f.queue.getSnapshot().rows.map(row => row.status), ['uploaded', 'uploaded', 'invalid', 'uploaded'])
  assert.equal(f.refreshes, 2)
  f.queue.dispose()
})

for (const [label, cause] of [['lost connection', new ApiError('NETWORK_ERROR')], ['unreadable server response', new ApiError('SERVER_ERROR')], ['unfamiliar server code', new ApiError('UNRECOGNIZED_RESPONSE')], ['unexpected exception', new Error('A response may already have saved the file')]] as const) {
  test(`${label} is not retried and requires a manual refresh before clearing or reselecting`, async () => {
    const f = fixture({ upload: async name => { if (name === 'unknown.pdf') throw cause; return saved(name) } })
    f.queue.add([file('unknown.pdf'), file('continue.png')])
    await f.queue.run('pending')
    const unknown = f.queue.getSnapshot().rows[0]
    assert.equal(unknown.status, 'unknown'); assert.equal(f.queue.getSnapshot().rows[1].status, 'uploaded')
    assert.equal(f.queue.getSnapshot().inspectionRequired, true)
    assert.equal(f.refreshes, 1, 'Automatic refresh must not acknowledge user inspection')
    await f.queue.run('failed'); await f.queue.run('pending')
    assert.equal(f.calls.length, 2)
    f.queue.remove(unknown.id); f.queue.clear(); f.queue.add([file('unknown.pdf')])
    assert.equal(f.queue.getSnapshot().rows.length, 2)
    await f.queue.refresh()
    assert.equal(f.queue.getSnapshot().inspectionRequired, false)
    assert.equal(f.queue.getSnapshot().rows[0].status, 'unknown', 'Refreshing must not invent a success or a retryable failure')
    f.queue.remove(unknown.id)
    assert.equal(f.queue.getSnapshot().rows.length, 1)
    f.queue.clear(); assert.equal(f.queue.getSnapshot().rows.length, 0)
    f.queue.dispose()
  })
}

test('failed refresh does not unlock uncertain files and does not undo known saved files', async () => {
  let rejectRefresh = true
  const f = fixture({ upload: async name => { if (name === 'unknown.pdf') throw new ApiError('NETWORK_ERROR'); return saved(name) }, refresh: async () => { if (rejectRefresh) throw new ApiError('SHARE_UNAVAILABLE') } })
  f.queue.add([file('one.pdf'), file('unknown.pdf')]); await f.queue.run('pending')
  assert.equal(f.queue.getSnapshot().rows[0].savedId, 'saved-one.pdf')
  assert.equal(f.queue.getSnapshot().refreshError, 'SHARE_UNAVAILABLE')
  await f.queue.refresh()
  assert.equal(f.queue.getSnapshot().inspectionRequired, true)
  rejectRefresh = false; await f.queue.refresh()
  assert.equal(f.queue.getSnapshot().inspectionRequired, false)
  assert.equal(f.queue.getSnapshot().refreshError, undefined)
  assert.equal(f.queue.getSnapshot().rows[0].savedId, 'saved-one.pdf')
  assert.equal(f.calls.length, 2)
  f.queue.dispose()
})

for (const code of ['LOGIN_REQUIRED', 'ACCESS_DISABLED', 'WORKSPACE_CHANGED', 'PARENT_ARCHIVED', 'VEHICLE_DELETED', 'RECORD_NOT_FOUND']) {
  test(`${code} stops unsent files without removing earlier successful uploads`, async () => {
    const f = fixture({ upload: async name => { if (name === 'stop.pdf') throw new ApiError(code); return saved(name) } })
    f.queue.add([file('one.pdf'), file('stop.pdf'), file('unsent.pdf')]); await f.queue.run('pending')
    assert.deepEqual(f.calls.map(call => call.filename), ['one.pdf', 'stop.pdf'])
    assert.deepEqual(f.queue.getSnapshot().rows.map(row => row.status), ['uploaded', 'failed', 'pending'])
    assert.equal(f.queue.getSnapshot().rows[1].error, code)
    f.queue.dispose()
  })
}

test('a response associated with another vehicle is uncertain and cannot become a displayed success', async () => {
  const f = fixture({ upload: async name => saved(name, 'vehicle-b') })
  f.queue.add([file('fictional.pdf')]); await f.queue.run('pending')
  assert.equal(f.queue.getSnapshot().rows[0].status, 'unknown')
  assert.equal(f.queue.getSnapshot().rows[0].savedId, undefined)
  assert.equal(f.queue.getSnapshot().inspectionRequired, true)
  f.queue.dispose()
})

test('disposal aborts the current request, stops unsent files, and discards a late admitted response', async () => {
  const response = deferred<BusinessRecord>(), started = deferred<void>()
  const f = fixture({ upload: async () => { started.resolve(); return response.promise } })
  let notifications = 0
  const unsubscribe = f.queue.subscribe(() => { notifications++ })
  f.queue.add([file('one.pdf'), file('unsent.pdf')]); const running = f.queue.run('pending')
  await started.promise; f.queue.dispose(); const before = notifications
  assert.equal(f.calls[0].signal.aborted, true)
  response.resolve(saved('one.pdf')); await running
  await f.queue.run('pending'); await f.queue.refresh(); f.queue.add([file('ignored.pdf')]); f.queue.clear(); f.queue.dispose()
  assert.equal(notifications, before); assert.equal(f.calls.length, 1); assert.equal(f.refreshes, 0)
  assert.equal(f.queue.getSnapshot().rows[0].savedId, undefined)
  assert.equal(f.queue.getSnapshot().rows[1].status, 'pending')
  assert.deepEqual(f.busy, [true, false]); assert.equal(f.queue.getSnapshot().busy, false)
  unsubscribe()
})

test('a stale workspace scope discards the response and sends no request under the new workspace', async () => {
  const response = deferred<BusinessRecord>(), started = deferred<void>()
  const f = fixture({ upload: async () => { started.resolve(); return response.promise } })
  f.queue.add([file('one.pdf'), file('unsent.pdf')]); const running = f.queue.run('pending')
  await started.promise; f.invalidate(); response.resolve(saved('one.pdf')); await running
  assert.equal(f.calls.length, 1); assert.equal(f.refreshes, 0)
  assert.equal(f.queue.getSnapshot().rows[0].savedId, undefined)
  assert.equal(f.queue.getSnapshot().rows[1].status, 'pending')
  await f.queue.run('pending'); assert.equal(f.calls.length, 1)
  f.queue.dispose()
})

test('disposing during a manual refresh does not unlock unknown rows through a late callback', async () => {
  const held = deferred<void>(), started = deferred<void>()
  let manual = false
  const f = fixture({ upload: async () => { throw new ApiError('NETWORK_ERROR') }, refresh: async signal => { if (manual) { started.resolve(); await held.promise; assert.equal(signal.aborted, true) } } })
  f.queue.add([file('unknown.pdf')]); await f.queue.run('pending'); manual = true
  const refreshing = f.queue.refresh(); await started.promise; f.queue.dispose(); held.resolve(); await refreshing
  assert.equal(f.queue.getSnapshot().inspectionRequired, true)
  assert.deepEqual(f.busy, [true, false, true, false])
})
