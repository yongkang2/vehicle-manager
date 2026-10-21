import { test } from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import ExcelJS from 'exceljs'
import { createApp } from '../server/app.js'
import { DOVE_BATCH_LIMIT, DOVE_MAX_FILE_BYTES } from '../shared/business.js'
import type { BusinessRecord, DoveBatchPreviewResult, DoveBatchSaveResult } from '../shared/business.js'

const vin = 'TEST0000000000001', otherVin = 'TEST0000000000002'

async function workbook(reportVin = vin, software = '2.0') {
  const book = new ExcelJS.Workbook()
  book.addWorksheet('DOVE').addRows([['Vin :', reportVin], ['Date of record', '2026-10-22'], ['Vehicle milage', '1200 km']])
  const identification = book.addWorksheet('Identification')
  identification.addRow(['ECU', 'Description', 'Network', 'Supplier'])
  identification.addRow(['EVCU', 'Control', 'CAN UDS', 'Supplier', 'FN', 'PN', software, '', 'CAL', '2', '', '', '', '000123'])
  book.addWorksheet('Defauts').addRow(['EVCU', '', 'CAN UDS', 'P123456 (2Fh - Permanent) Fault'])
  return Buffer.from(await book.xlsx.writeBuffer())
}
function upload(files: { bytes: Buffer; name: string }[], field = 'files') {
  const form = new FormData()
  for (const file of files) form.append(field, new Blob([new Uint8Array(file.bytes)]), file.name)
  return form
}
async function fixture() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'vehicle-dove-batch-')), shared = path.join(directory, 'shared')
  await fs.mkdir(shared)
  const client = createApp({ dataDir: path.join(directory, 'local') }), server = client.app.listen(0, '127.0.0.1')
  if (!server.listening) await new Promise(resolve => server.once('listening', resolve))
  const cookies = new Map<string, string>()
  async function request(url: string, method = 'GET', body?: unknown, user = 'admin') {
    const form = body instanceof FormData, port = (server.address() as { port: number }).port
    const response = await fetch(`http://127.0.0.1:${port}/api${url}`, { method, headers: { Cookie: cookies.get(user) || '', 'X-App-Request': 'vehicle-manager', ...(body && !form ? { 'Content-Type': 'application/json' } : {}) }, body: body ? form ? body : JSON.stringify(body) : undefined })
    const cookie = response.headers.get('set-cookie'); if (cookie) cookies.set(user, cookie.split(';')[0])
    return { status: response.status, data: response.headers.get('content-type')?.includes('json') ? await response.json() : Buffer.from(await response.arrayBuffer()) }
  }
  async function close() {
    await new Promise<void>(resolve => server.close(() => resolve()))
    await client.synchronization.settle()
    client.store.db.close()
    await fs.rm(directory, { recursive: true, force: true })
  }
  try {
    assert.equal((await request('/register', 'POST', { username: 'batchadmin', displayName: 'Batch admin', password: 'batch-test-password' })).status, 201)
    assert.equal((await request('/setup/configure', 'POST', { path: shared, mode: 'create', teamName: 'DOVE batch test', confirmed: true })).status, 200)
    return { ...client, request, close, shared }
  } catch (error) { await close(); throw error }
}
async function createVehicle(request: Awaited<ReturnType<typeof fixture>>['request'], reportVin = vin) {
  const response = await request('/business/records', 'POST', { kind: 'vehicle', data: { vin: reportVin, status: 'available', project: 'Original project' }, reason: 'Register batch test vehicle' })
  assert.equal(response.status, 201)
  return response.data as BusinessRecord
}

test('DOVE batch preview isolates file errors; retention continues in order and stores original bytes without changing configuration', async () => {
  const client = await fixture(), { request } = client
  try {
    const car = await createVehicle(request)
    const part = (await request('/business/records', 'POST', { kind: 'part', vehicleId: car.id, data: { name: 'EVCU', category: 'controller', software: '1.0' }, reason: 'Install original controller' })).data as BusinessRecord
    const firstBytes = await workbook(), lastBytes = await workbook(vin, '3.0')
    await client.synchronization.settle()
    const beforeRecords = client.business.list(), beforeHistory = client.business.history()
    const response = await request('/business/dove/preview-batch', 'POST', upload([
      { name: 'first.xlsx', bytes: firstBytes },
      { name: 'wrong.pdf', bytes: firstBytes },
      { name: 'broken.xlsx', bytes: Buffer.from('not an Excel workbook') },
      { name: 'unmatched.xlsx', bytes: await workbook(otherVin) },
      { name: 'copy.xlsx', bytes: firstBytes },
      { name: 'last.xlsx', bytes: lastBytes },
    ]))
    assert.equal(response.status, 200)
    const previews = response.data as DoveBatchPreviewResult[]
    assert.deepEqual(previews.map(result => [result.index, result.filename]), [[0, 'first.xlsx'], [1, 'wrong.pdf'], [2, 'broken.xlsx'], [3, 'unmatched.xlsx'], [4, 'copy.xlsx'], [5, 'last.xlsx']])
    assert.equal(previews[1].error, 'XLSX_REQUIRED')
    assert.equal(previews[2].error, 'DOVE_PARSE_FAILED')
    assert.equal(previews[0].preview?.match, 'matched')
    assert.equal(previews[3].preview?.match, 'unmatched')
    assert.equal(previews[4].preview?.checksum, previews[0].preview?.checksum)
    assert.notEqual(previews[4].preview?.id, previews[0].preview?.id)
    assert.deepEqual(client.business.list(), beforeRecords)
    assert.deepEqual(client.business.history(), beforeHistory)
    const draftIds = [0, 3, 4, 5].map(index => previews[index].preview!.id)
    const saved = await request('/business/dove/save-batch', 'POST', { draftIds })
    assert.equal(saved.status, 201)
    const results = saved.data as DoveBatchSaveResult[]
    assert.deepEqual(results.map(result => result.draftId), draftIds)
    assert.equal(results[1].error, 'VIN_NOT_MATCHED')
    assert.equal(results[0].record?.kind, 'report')
    assert.equal(results[2].record?.id, results[0].record?.id)
    assert.equal(results[3].record?.kind, 'report')
    assert.notEqual(results[3].record?.id, results[0].record?.id)
    assert.deepEqual((await request(`/business/files/${results[0].record!.id}`)).data, firstBytes)
    assert.deepEqual((await request(`/business/files/${results[3].record!.id}`)).data, lastBytes)
    assert.equal(client.business.list('report').length, 2)
    assert.deepEqual(client.business.get(car.id).data, car.data)
    assert.deepEqual(client.business.get(part.id).data, part.data)
    assert.equal(client.business.history(car.id).filter(change => change.kind === 'vehicle' || change.kind === 'part').length, 2)
    const consumedIds = [draftIds[0], draftIds[2], draftIds[3]]
    const consumed = (await request('/business/dove/save-batch', 'POST', { draftIds: consumedIds })).data as DoveBatchSaveResult[]
    assert.deepEqual(consumed.map(result => result.error), ['DRAFT_EXPIRED', 'DRAFT_EXPIRED', 'DRAFT_EXPIRED'])
    const singlePreview = await request('/business/dove/preview', 'POST', upload([{ name: 'single.xlsx', bytes: firstBytes }], 'file'))
    assert.equal(singlePreview.status, 200)
    assert.equal(singlePreview.data.existingId, results[0].record!.id)
    assert.equal((await request('/business/dove/save', 'POST', { draftId: singlePreview.data.id })).data.id, results[0].record!.id)
    assert.equal((await request('/business/dove/save', 'POST', { draftId: singlePreview.data.id })).data.error, 'DRAFT_EXPIRED')
  } finally { await client.close() }
})

test('DOVE batch retention rechecks vehicle VIN and local draft ownership for each file', async () => {
  const client = await fixture(), { request } = client
  try {
    const firstCar = await createVehicle(request)
    await createVehicle(request, otherVin)
    await client.synchronization.settle()
    assert.equal((await request('/register', 'POST', { username: 'batchmember', displayName: 'Batch member', password: 'batch-test-password' }, 'member')).status, 201)
    const check = (await request('/setup/check', 'POST', { path: client.shared }, 'member')).data
    assert.equal((await request('/setup/configure', 'POST', { path: client.shared, mode: 'join', teamId: check.teamId }, 'member')).status, 200)
    const team = (await request('/team')).data
    assert.equal((await request(`/team/requests/${team.requests[0].id}/approve`, 'POST', { role: 'member', memberId: null, reason: 'Verify batch member' })).status, 200)
    const response = await request('/business/dove/preview-batch', 'POST', upload([{ name: 'first.xlsx', bytes: await workbook() }, { name: 'second.xlsx', bytes: await workbook(otherVin) }]))
    const previews = response.data as DoveBatchPreviewResult[], draftIds = previews.map(result => result.preview!.id)
    const denied = (await request('/business/dove/save-batch', 'POST', { draftIds }, 'member')).data as DoveBatchSaveResult[]
    assert.deepEqual(denied.map(result => result.error), ['DRAFT_EXPIRED', 'DRAFT_EXPIRED'])
    assert.equal(client.business.list('report').length, 0)
    assert.equal((await request(`/business/records/${firstCar.id}`, 'PUT', { data: { ...firstCar.data, vin: 'TEST0000000000003' }, version: firstCar.version, reason: 'Correct VIN before retention' })).status, 200)
    const retained = (await request('/business/dove/save-batch', 'POST', { draftIds })).data as DoveBatchSaveResult[]
    assert.equal(retained[0].error, 'VIN_NOT_MATCHED')
    assert.equal(retained[1].record?.kind, 'report')
    assert.equal(retained[1].record?.data.name, 'second.xlsx')
    assert.equal(client.business.list('report').length, 1)
  } finally { await client.close() }
})

test('DOVE batch accepts eight live drafts, rejects nine files, and validates retention selections', async () => {
  const client = await fixture(), { request } = client
  try {
    await createVehicle(request)
    const bytes = await workbook(), files = Array.from({ length: DOVE_BATCH_LIMIT }, (_, index) => ({ name: `${index}.xlsx`, bytes }))
    const response = await request('/business/dove/preview-batch', 'POST', upload(files))
    assert.equal(response.status, 200)
    const previews = response.data as DoveBatchPreviewResult[]
    assert.equal(previews.length, 8)
    assert.ok(previews.every(result => result.preview?.match === 'matched'))
    const draftIds = previews.map(result => result.preview!.id)
    assert.equal(new Set(draftIds).size, 8)
    const excess = await request('/business/dove/preview-batch', 'POST', upload([...files, { name: 'ninth.xlsx', bytes }]))
    assert.equal(excess.status, 400)
    assert.equal(excess.data.error, 'DOVE_BATCH_LIMIT')
    assert.equal(client.business.list('report').length, 0)
    assert.equal((await request('/business/dove/preview-batch', 'POST', new FormData())).data.error, 'FILE_REQUIRED')
    const wrongField = await request('/business/dove/preview-batch', 'POST', upload([{ name: 'wrong-field.xlsx', bytes }], 'file'))
    assert.equal(wrongField.status, 400)
    assert.equal(wrongField.data.error, 'INVALID_INPUT')
    const oversized = await request('/business/dove/preview-batch', 'POST', upload([{ name: 'large.xlsx', bytes: Buffer.alloc(DOVE_MAX_FILE_BYTES + 1) }]))
    assert.equal(oversized.status, 413)
    assert.equal(oversized.data.error, 'FILE_TOO_LARGE')
    for (const body of [{}, { draftIds: [] }, { draftIds: [''] }, { draftIds: [' '] }, { draftIds: [7] }, { draftIds: ['same', 'same'] }, { draftIds: Array.from({ length: 9 }, (_, index) => `${index}`) }]) {
      const invalid = await request('/business/dove/save-batch', 'POST', body)
      assert.equal(invalid.status, 400)
      assert.equal(invalid.data.error, 'INVALID_INPUT')
    }
    const retained = (await request('/business/dove/save-batch', 'POST', { draftIds })).data as DoveBatchSaveResult[]
    assert.equal(retained.length, 8)
    assert.ok(retained.every(result => result.record?.kind === 'report'))
    assert.equal(new Set(retained.map(result => result.record!.id)).size, 1)
    assert.equal(client.business.list('report').length, 1)
  } finally { await client.close() }
})
