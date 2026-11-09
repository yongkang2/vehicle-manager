import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { BusinessRecord } from '../shared/business.js'
import type { ModificationView } from '../shared/modifications.js'
import { MODIFICATION_MAX_TARGETS } from '../shared/modifications.js'
import { matchesModificationVin, modificationDestinations, selectedModificationTargets } from '../src/modification-population.js'
import { AttachmentUploadQueue } from '../src/attachment-upload-queue.js'
import { ApiError } from '../src/api.js'
import type { createWorkspaceScope } from '../src/api.js'

const vehicle = (id: string, vin: string, archived = false): BusinessRecord => ({ id, kind: 'vehicle', vehicleId: null, data: { name: id, vin, plate: '' }, archived, version: 1, updated: '2026-11-08T00:00:00.000Z' })
const source: ModificationView = { record: { id: 'source-modification', kind: 'modification', vehicleId: 'source', data: { name: 'Fictional retrofit' }, archived: false, version: 1, updated: '2026-11-08T00:00:00.000Z' }, mode: 'linked', groupId: 'fictional-group', groupVersion: 2, linkedVehicles: [{ id: 'linked', vin: 'TEST0000000000002', name: 'Linked vehicle', plate: '' }], files: [] }

test('population options cover all eligible vehicles while excluding source, archived and already linked identities', () => {
  const options = modificationDestinations([vehicle('source', 'TEST0000000000001'), vehicle('linked', 'TEST0000000000002'), vehicle('late-page', 'TEST0000000000100'), vehicle('archived', 'TEST0000000000003', true), vehicle('first-page', 'TEST0000000000004'), { ...source.record, id: 'not-a-vehicle' }], source)
  assert.deepEqual(options.map(record => record.id), ['first-page', 'late-page'])
  assert(matchesModificationVin(String(options[1].data.vin), 'test00000000001'))
  assert(matchesModificationVin(String(options[0].data.vin), '  0004  '))
  assert(!matchesModificationVin(String(options[0].data.vin), 'not-a-vin'))
})

test('population binds reviewed UUID and VIN snapshots and refuses missing, duplicate or oversized selections', () => {
  const current = vehicle('reviewed-uuid', 'TEST0000000000004')
  const request = selectedModificationTargets([current], [current.id])!
  assert.deepEqual(request, [{ vehicleId: 'reviewed-uuid', expectedVin: 'TEST0000000000004' }])
  current.data.vin = 'TEST0000000000999'
  assert.equal(request[0].expectedVin, 'TEST0000000000004', 'A captured submission must not acquire refreshed VIN data')
  assert.equal(selectedModificationTargets([vehicle('new-uuid', 'TEST0000000000004')], ['reviewed-uuid']), null, 'VIN reuse must not substitute another identity')
  assert.equal(selectedModificationTargets([current], []), null)
  assert.equal(selectedModificationTargets([current], [current.id, current.id]), null)
  assert.equal(selectedModificationTargets([{ ...current, archived: true }], [current.id]), null)
  const many = Array.from({ length: MODIFICATION_MAX_TARGETS + 1 }, (_, index) => vehicle(`car-${index}`, `VIN-${index}`))
  assert.equal(selectedModificationTargets(many, many.map(record => record.id)), null)
  assert.equal(selectedModificationTargets(many, many.slice(0, MODIFICATION_MAX_TARGETS).map(record => record.id))?.length, MODIFICATION_MAX_TARGETS)
})

function scope(): ReturnType<typeof createWorkspaceScope> {
  return { assertCurrent: signal => signal?.throwIfAborted(), request: async () => { throw new Error('The modification adapter must not call the general vehicle upload endpoint') }, blob: async () => { throw new Error('No download expected') } }
}

test('known committed upload pauses remaining files until local refresh, retaining success through refresh failure', async () => {
  const calls: string[] = []
  let refreshAvailable = false
  const queue = new AttachmentUploadQueue({ scope: scope(), vehicleId: 'original-vehicle', validateFile: () => undefined, onRefresh: async () => { if (!refreshAvailable) throw new ApiError('MODIFICATION_LOCAL_REFRESH_REQUIRED') }, uploadFile: async file => { calls.push(file.name); return { id: file.name, pauseForRefresh: !refreshAvailable } } })
  queue.add([new File(['First'], 'committed.txt'), new File(['Second'], 'unsent.txt')])
  await queue.run('pending')
  assert.deepEqual(calls, ['committed.txt'])
  assert.deepEqual(queue.getSnapshot().rows.map(row => row.status), ['uploaded', 'pending'])
  assert.equal(queue.getSnapshot().inspectionRequired, false, 'The shared commit is known, not an uncertain upload')
  assert.equal(queue.getSnapshot().refreshError, 'MODIFICATION_LOCAL_REFRESH_REQUIRED')
  refreshAvailable = true
  await queue.refresh()
  await queue.run('pending')
  assert.deepEqual(calls, ['committed.txt', 'unsent.txt'])
  assert(queue.getSnapshot().rows.every(row => row.status === 'uploaded'))
  queue.dispose()
})

test('modification upload adapter preserves sequential versions and known successes when a shared record becomes stale', async () => {
  let version = 4, refreshes = 0
  const calls: { name: string; version: number }[] = []
  const queue = new AttachmentUploadQueue({ scope: scope(), vehicleId: 'original-vehicle', validateFile: () => undefined, onRefresh: async () => { refreshes++ }, uploadFile: async file => {
    calls.push({ name: file.name, version })
    if (file.name === 'second.eml') throw new ApiError('MODIFICATION_STALE')
    version++; return { id: 'saved-file-id' }
  } })
  queue.add([new File(['Fictional text'], 'first.txt'), new File(['From: test@example.invalid\r\nSubject: Fictional\r\n\r\nBody'], 'second.eml'), new File(['Fictional text'], 'unsent.txt')])
  await queue.run('pending')
  assert.deepEqual(calls, [{ name: 'first.txt', version: 4 }, { name: 'second.eml', version: 5 }])
  assert.deepEqual(queue.getSnapshot().rows.map(row => row.status), ['uploaded', 'failed', 'pending'])
  assert.equal(queue.getSnapshot().rows[0].savedId, 'saved-file-id')
  assert.equal(queue.getSnapshot().inspectionRequired, false)
  assert.equal(refreshes, 1)
  queue.dispose()
})

test('modification adapter keeps uncertain outcomes inspectable and never includes saved files in a failed-only retry', async () => {
  const calls: string[] = []
  const queue = new AttachmentUploadQueue({ scope: scope(), vehicleId: 'original-vehicle', validateFile: () => undefined, onRefresh: async () => {}, uploadFile: async file => {
    calls.push(file.name)
    if (file.name === 'unknown.msg') throw new ApiError('NETWORK_ERROR')
    return { id: file.name }
  } })
  queue.add([new File(['Fictional'], 'saved.txt'), new File(['Fictional'], 'unknown.msg')])
  await queue.run('pending'); await queue.run('failed')
  assert.deepEqual(calls, ['saved.txt', 'unknown.msg'])
  assert.deepEqual(queue.getSnapshot().rows.map(row => row.status), ['uploaded', 'unknown'])
  assert.equal(queue.getSnapshot().inspectionRequired, true)
  await queue.refresh()
  assert.equal(queue.getSnapshot().inspectionRequired, false)
  queue.dispose()
})
