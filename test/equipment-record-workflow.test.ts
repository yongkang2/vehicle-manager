import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { BusinessRecord, Fields } from '../shared/business.js'
import { ApiError } from '../src/api.js'
import type { createWorkspaceScope } from '../src/api.js'
import { EquipmentRecordWorkflow } from '../src/equipment-record-workflow.js'

type Scope = ReturnType<typeof createWorkspaceScope>
const equipment = (id = 'equipment-a', version = 1): BusinessRecord => ({ id, kind: 'equipment', vehicleId: 'vehicle-a', data: { name: 'Fictional logger' }, archived: false, version, updated: '2026-11-09T00:00:00Z' })
const file = (name: string) => new File(['Fictional equipment file'], name)
const attachment = (name: string, equipmentId = 'equipment-a'): BusinessRecord => ({ id: `attachment-${name}`, kind: 'attachment', vehicleId: 'vehicle-a', data: { name, equipmentId }, archived: false, version: 1, updated: '2026-11-09T00:00:00Z' })
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done }); return { promise, resolve } }
type Request = { url: string; method: string; body: { data: Fields; reason: string; requestId: string; version?: number }; signal: AbortSignal }
function fixture(options: {
  record?: BusinessRecord
  save?: (request: Request) => Promise<BusinessRecord>
  upload?: (filename: string, signal: AbortSignal) => Promise<BusinessRecord>
  refresh?: (signal: AbortSignal) => Promise<void>
  blob?: (url: string, signal: AbortSignal) => Promise<Blob>
} = {}) {
  const saves: Request[] = [], uploads: { url: string; filename: string; reason: string; signal: AbortSignal }[] = [], busy: boolean[] = []
  let valid = true, nextId = 0, refreshes = 0
  const scope: Scope = {
    assertCurrent(signal) { signal?.throwIfAborted(); if (!valid) throw new ApiError('WORKSPACE_CHANGED') },
    async request<T>(url: string, request = {}) {
      const { body, method, signal } = request as { body: FormData | Request['body']; method: string; signal: AbortSignal }
      if (body instanceof FormData) {
        const item = body.get('file') as File
        assert.deepEqual([...body.keys()], ['file', 'reason'])
        uploads.push({ url, filename: item.name, reason: String(body.get('reason')), signal })
        return (await (options.upload?.(item.name, signal) || Promise.resolve(attachment(item.name)))) as T
      }
      const call: Request = { url, method, body: structuredClone(body), signal }
      saves.push(call)
      return (await (options.save?.(call) || Promise.resolve(equipment(options.record?.id, (options.record?.version || 0) + 1)))) as T
    },
    async blob(url, request) { return request?.signal ? await (options.blob?.(url, request.signal) || Promise.resolve(new Blob(['Fictional original']))) : new Blob() },
  }
  const workflow = new EquipmentRecordWorkflow({ scope, vehicleId: 'vehicle-a', record: options.record || null, onRefresh: async signal => { refreshes++; await options.refresh?.(signal) }, onBusyChange: value => { busy.push(value) }, requestId: () => `request-${++nextId}` })
  return { workflow, saves, uploads, busy, invalidate: () => { valid = false }, get refreshes() { return refreshes } }
}

test('optional files and either blank date do not block saving equipment; refresh completes the workflow', async () => {
  for (const data of [
    { name: 'Logger', installedAt: '', removedAt: '' },
    { name: 'Logger', installedAt: '2026-11-01', removedAt: '' },
    { name: 'Logger', installedAt: '', removedAt: '2026-11-09' },
  ]) {
    const f = fixture()
    await f.workflow.save(data, 'Record fictional equipment')
    assert.equal(f.saves.length, 1); assert.deepEqual(f.saves[0].body.data, data)
    assert.equal(f.uploads.length, 0); assert.equal(f.refreshes, 1)
    assert.equal(f.workflow.getSnapshot().state, 'saved'); assert.equal(f.workflow.canFinishCleanly(), true)
    assert.deepEqual(f.busy, [true, false]); f.workflow.dispose()
  }
})

test('one Save keeps the equipment UUID and uploads selected files sequentially with its reason', async () => {
  const first = deferred<BusinessRecord>(), entered = deferred<void>()
  const f = fixture({ upload: async name => { if (name === 'one.pdf') { entered.resolve(); return first.promise }; return attachment(name) } })
  f.workflow.queue.add([file('one.pdf'), file('two.JFIF')])
  assert.equal(f.saves.length, 0); assert.equal(f.uploads.length, 0, 'Selection alone has no writes')
  const pending = f.workflow.save({ name: 'Logger', installedAt: '', removedAt: '' }, 'Evidence for equipment')
  await entered.promise
  assert.equal(f.saves.length, 1); assert.equal(f.uploads.length, 1)
  assert.equal(f.workflow.getSnapshot().savedRecord?.id, 'equipment-a')
  assert.equal(f.workflow.getSnapshot().busy, true)
  first.resolve(attachment('one.pdf')); await pending
  assert.deepEqual(f.uploads.map(row => row.filename), ['one.pdf', 'two.JFIF'])
  assert(f.uploads.every(row => row.url === '/api/business/equipment/equipment-a/attachments' && row.reason === 'Evidence for equipment'))
  assert.equal(f.workflow.canFinishCleanly(), true); assert.deepEqual(f.busy, [true, false])
  f.workflow.dispose()
})

test('partial failures retain saved equipment and known successful files; retries never save equipment again', async () => {
  let fail = true
  const f = fixture({ upload: async name => { if (name === 'retry.pdf' && fail) { fail = false; throw new ApiError('FILE_TYPE_NOT_ALLOWED') }; return attachment(name) } })
  f.workflow.queue.add([file('saved.png'), file('retry.pdf'), file('invalid.txt'), file('last.xls')])
  await f.workflow.save({ name: 'Logger' }, 'Record with optional files')
  assert.equal(f.workflow.getSnapshot().state, 'saved')
  assert.deepEqual(f.workflow.queue.getSnapshot().rows.map(row => row.status), ['uploaded', 'failed', 'invalid', 'uploaded'])
  assert.equal(f.workflow.canFinishCleanly(), false)
  await f.workflow.queue.run('failed'); await f.workflow.save({ name: 'Do not create another' }, 'Ignored')
  assert.equal(f.saves.length, 1)
  assert.deepEqual(f.uploads.map(row => row.filename), ['saved.png', 'retry.pdf', 'last.xls', 'retry.pdf'])
  assert.equal(f.workflow.queue.getSnapshot().rows[0].savedId, 'attachment-saved.png')
  f.workflow.dispose()
})

test('lost save response freezes and reuses request ID and payload before uploading any file', async () => {
  let attempt = 0
  const f = fixture({ save: async () => { if (++attempt === 1) throw new ApiError('NETWORK_ERROR'); return equipment() } })
  const values = { name: 'Original logger', notes: 'Preserve this command' }
  f.workflow.queue.add([file('evidence.pdf')])
  await f.workflow.save(values, 'Original reason')
  assert.equal(f.workflow.getSnapshot().state, 'unknown'); assert.equal(f.uploads.length, 0)
  values.name = 'Changed caller object'
  await f.workflow.save({ name: 'New data must not replace uncertain request' }, 'New reason')
  assert.equal(f.saves.length, 2)
  assert.deepEqual(f.saves[0].body, f.saves[1].body)
  assert.equal(f.saves[1].body.data.name, 'Original logger'); assert.equal(f.saves[1].body.reason, 'Original reason')
  assert.equal(f.saves[0].body.requestId, 'request-1')
  assert.equal(f.uploads.length, 1); assert.equal(f.workflow.canFinishCleanly(), true)
  f.workflow.dispose()
})

test('definite save validation failures keep selected files and permit a corrected command', async () => {
  let attempt = 0
  const f = fixture({ save: async () => { if (++attempt === 1) throw new ApiError('INVALID_DATE'); return equipment() } })
  f.workflow.queue.add([file('evidence.pdf')])
  await f.workflow.save({ name: 'Logger', installedAt: 'invalid' }, 'First reason')
  assert.equal(f.workflow.getSnapshot().state, 'editing'); assert.equal(f.uploads.length, 0)
  assert.equal(f.workflow.queue.getSnapshot().rows[0].status, 'pending')
  await f.workflow.save({ name: 'Logger', installedAt: '' }, 'Corrected reason')
  assert.notEqual(f.saves[0].body.requestId, f.saves[1].body.requestId)
  assert.equal(f.uploads.length, 1); f.workflow.dispose()
})

test('editing uses the original UUID and reviewed version, and upload retries do not repeat PUT', async () => {
  let fail = true
  const f = fixture({ record: equipment('equipment-a', 7), upload: async name => { if (fail) { fail = false; throw new ApiError('FILE_TYPE_NOT_ALLOWED') }; return attachment(name) } })
  f.workflow.queue.add([file('retry.pdf')]); await f.workflow.save({ name: 'Edited logger' }, 'Update equipment')
  assert.equal(f.saves[0].url, '/api/business/records/equipment-a'); assert.equal(f.saves[0].method, 'PUT'); assert.equal(f.saves[0].body.version, 7)
  await f.workflow.queue.run('failed')
  assert.equal(f.saves.length, 1); assert.equal(f.uploads.length, 2); f.workflow.dispose()
})

test('unknown upload responses stop unsent files, require inspection and never resend known successes', async () => {
  const f = fixture({ upload: async name => { if (name === 'uncertain.pdf') throw new ApiError('NETWORK_ERROR'); return attachment(name) } })
  f.workflow.queue.add([file('saved.pdf'), file('uncertain.pdf'), file('unsent.pdf')]); await f.workflow.save({ name: 'Logger' }, 'Attach evidence')
  assert.equal(f.workflow.getSnapshot().state, 'saved')
  assert.equal(f.workflow.queue.getSnapshot().inspectionRequired, true)
  await f.workflow.queue.run('failed'); await f.workflow.queue.run('pending')
  assert.equal(f.uploads.length, 2); assert.equal(f.saves.length, 1)
  await f.workflow.queue.refresh()
  assert.equal(f.workflow.queue.getSnapshot().inspectionRequired, false)
  assert.equal(f.workflow.queue.getSnapshot().rows[1].status, 'unknown')
  assert.equal(f.workflow.queue.getSnapshot().rows[0].savedId, 'attachment-saved.pdf')
  assert.equal(f.workflow.queue.getSnapshot().rows[2].status, 'pending')
  await f.workflow.queue.run('pending')
  assert.deepEqual(f.uploads.map(row => row.filename), ['saved.pdf', 'uncertain.pdf', 'unsent.pdf'])
  assert.equal(f.saves.length, 1); f.workflow.dispose()
})

test('required equipment Type rejection stays editable and permits a corrected save', async () => {
  const f = fixture({ save: async request => { if (!request.body.data.equipmentType) throw new ApiError('EQUIPMENT_TYPE_REQUIRED'); return equipment() } })
  f.workflow.queue.add([file('evidence.pdf')]); await f.workflow.save({ name: 'Legacy logger' }, 'Select classification')
  assert.equal(f.workflow.getSnapshot().state, 'editing'); assert.equal(f.workflow.getSnapshot().error, 'EQUIPMENT_TYPE_REQUIRED')
  assert.equal(f.uploads.length, 0)
  await f.workflow.save({ name: 'Legacy logger', equipmentType: 'ETAS tools' }, 'Select classification')
  assert.equal(f.workflow.getSnapshot().state, 'saved'); assert.equal(f.saves.length, 2); assert.equal(f.uploads.length, 1)
  assert.notEqual(f.saves[0].body.requestId, f.saves[1].body.requestId); f.workflow.dispose()
})

for (const code of ['EQUIPMENT_REQUEST_MISMATCH', 'WORKSPACE_TOKEN_REQUIRED', 'WORKSPACE_CHANGED', 'WORKSPACE_NOT_FOUND', 'LOGIN_REQUIRED', 'NOT_CONFIGURED', 'REQUEST_CANCELLED', 'VERSION_CONFLICT', 'PARENT_ARCHIVED', 'CLIENT_UPGRADE_REQUIRED']) {
  test(`${code} blocks repeated equipment saves and requires safe refresh or reopening`, async () => {
    const f = fixture({ save: async () => { throw new ApiError(code) } })
    f.workflow.queue.add([file('unsent.pdf')]); await f.workflow.save({ name: 'Logger' }, 'Save fictional equipment')
    assert.equal(f.workflow.getSnapshot().state, 'blocked'); assert.equal(f.workflow.getSnapshot().error, code)
    assert.equal(f.workflow.getSnapshot().savedRecord, null); assert.equal(f.workflow.canFinishCleanly(), false)
    await f.workflow.save(); await f.workflow.save({ name: 'Do not create a new receipt' }, 'Try again')
    assert.equal(f.saves.length, 1); assert.equal(f.uploads.length, 0); assert.equal(f.workflow.queue.getSnapshot().rows[0].status, 'pending')
    f.workflow.dispose()
  })
}

test('file read failures leave saved equipment intact and never become uncertain server writes', async () => {
  const f = fixture(), unreadable = file('disappeared.jfif')
  Object.defineProperty(unreadable, 'arrayBuffer', { value: async () => { throw new DOMException('File changed', 'NotReadableError') } })
  f.workflow.queue.add([unreadable, file('valid.pdf')]); await f.workflow.save({ name: 'Logger' }, 'Save evidence')
  assert.equal(f.workflow.getSnapshot().state, 'saved'); assert.equal(f.saves.length, 1)
  assert.deepEqual(f.uploads.map(row => row.filename), ['valid.pdf'])
  assert.equal(f.workflow.queue.getSnapshot().rows[0].error, 'FILE_UNREADABLE')
  assert.equal(f.workflow.queue.getSnapshot().inspectionRequired, false)
  f.workflow.dispose()
})

test('selection cancellation before Save causes no writes', async () => {
  const f = fixture(); f.workflow.queue.add([file('optional.pdf')]); f.workflow.dispose()
  await f.workflow.save({ name: 'Cancelled logger' }, 'Must not save')
  assert.equal(f.saves.length, 0); assert.equal(f.uploads.length, 0); assert.equal(f.refreshes, 0)
})

test('closing or switching workspace during an equipment save discards late replies and stops uploads', async () => {
  for (const close of [false, true]) {
    const delayed = deferred<BusinessRecord>(), entered = deferred<void>()
    const f = fixture({ save: async () => { entered.resolve(); return delayed.promise } })
    f.workflow.queue.add([file('unsent.pdf')])
    const pending = f.workflow.save({ name: 'Logger' }, 'Record evidence')
    await entered.promise
    if (close) f.workflow.dispose(); else f.invalidate()
    delayed.resolve(equipment()); await pending
    assert.equal(f.uploads.length, 0); assert.equal(f.refreshes, 0)
    assert.equal(f.workflow.getSnapshot().savedRecord, null)
    if (close) assert.equal(f.saves[0].signal.aborted, true)
    f.workflow.dispose()
  }
})

test('closing during the first admitted upload stops unsent files and ignores its late response', async () => {
  const delayed = deferred<BusinessRecord>(), entered = deferred<void>()
  const f = fixture({ upload: async () => { entered.resolve(); return delayed.promise } })
  f.workflow.queue.add([file('admitted.pdf'), file('unsent.pdf')])
  const pending = f.workflow.save({ name: 'Logger' }, 'Record evidence')
  await entered.promise; f.workflow.dispose(); delayed.resolve(attachment('admitted.pdf')); await pending
  assert.equal(f.saves.length, 1); assert.equal(f.uploads.length, 1); assert.equal(f.uploads[0].signal.aborted, true)
  assert.equal(f.refreshes, 0); assert.deepEqual(f.busy, [true, false])
})

test('refresh failures retain the saved identity and can recover without another save', async () => {
  let broken = true
  const f = fixture({ refresh: async () => { if (broken) throw new ApiError('SHARE_UNAVAILABLE') } })
  await f.workflow.save({ name: 'Logger' }, 'Save equipment')
  assert.equal(f.workflow.getSnapshot().state, 'saved'); assert.equal(f.workflow.canFinishCleanly(), false)
  assert.equal(f.workflow.queue.getSnapshot().refreshError, 'SHARE_UNAVAILABLE')
  broken = false; await f.workflow.queue.refresh()
  assert.equal(f.saves.length, 1); assert.equal(f.workflow.canFinishCleanly(), true); f.workflow.dispose()
})

test('attachment downloads reject another equipment identity and are cancelled when the editor closes', async () => {
  const delayed = deferred<Blob>(), entered = deferred<void>()
  let signal: AbortSignal | undefined
  const f = fixture({ record: equipment(), blob: async (_url, value) => { signal = value; entered.resolve(); return delayed.promise } })
  await assert.rejects(f.workflow.readAttachment(attachment('other.pdf', 'equipment-b')), { message: 'INVALID_INPUT' })
  const downloading = f.workflow.readAttachment(attachment('owned.pdf')); await entered.promise
  f.workflow.dispose(); assert.equal(signal!.aborted, true)
  delayed.resolve(new Blob(['Original bytes'])); await assert.rejects(downloading, { name: 'AbortError' })
})
