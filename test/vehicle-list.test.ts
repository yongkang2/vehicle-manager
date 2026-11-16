import { test } from 'node:test'
import assert from 'node:assert/strict'
import { VehicleListQueries } from '../server/vehicle-list.js'
import type { BusinessRecord } from '../shared/business.js'
import { builtinComponentTypes } from '../shared/configuration-revisions.js'
import { randomUUID } from 'node:crypto'
import { modificationView } from '../shared/modifications.js'
import { modificationDestinations } from '../src/modification-population.js'

test('vehicle paging keeps fleet totals/facets, bounds payloads and loads full records only on demand', () => {
  const records: BusinessRecord[] = Array.from({ length: 25 }, (_, index) => ({ id: `v${index}`, kind: 'vehicle', vehicleId: null, data: { name: `Car ${index}`, vin: `VIN${index}`, status: index % 2 ? 'testing' : 'available', owner: index === 24 ? 'Last owner' : 'Owner' }, archived: index === 23, version: 1, updated: '2026-11-13' }))
  records.push({ id: 'equipment', kind: 'equipment', vehicleId: 'v0', data: { name: 'Large equipment', notes: 'x'.repeat(100000) }, archived: false, version: 1, updated: '2026-11-13' })
  records.push({ id: 'report', kind: 'report', vehicleId: 'v0', data: { name: 'Report', recordedAt: '2026-11-13', parsed: { controllers: ['Large report'] } }, archived: false, version: 1, updated: '2026-11-13' })
  const groupId = randomUUID()
  records.push({ id: groupId, kind: 'modificationGroup', vehicleId: null, data: { schema: 1, name: 'Shared retrofit' }, archived: false, version: 3, updated: '2026-11-13' })
  for (const vehicleId of ['v0', 'v24']) records.push({ id: `mod-${vehicleId}`, kind: 'modification', vehicleId, data: { groupId }, archived: false, version: 1, updated: '2026-11-13' })
  const view = { records, catalog: { enabled: false, types: builtinComponentTypes }, revisionSummaries: [] }
  let builds = 0
  const queries = new VehicleListQueries(() => { builds++; return view })
  const query = { search: '', archived: false, page: 1, pageSize: 10, filters: {} }
  const first = queries.read('1', query)
  assert.equal(first.vehicleList?.total, 24)
  assert.equal(first.records.filter(record => record.kind === 'vehicle').length, 10)
  assert.equal(first.records.some(record => record.kind === 'equipment'), false)
  assert.equal(first.records.find(record => record.id === 'report')?.data.parsed, undefined)
  assert.equal(first.vehicleList?.counts.total, 24)
  assert(first.vehicleList?.options.owner?.includes('["Last owner"]'))
  const last = queries.read('1', { ...query, page: 99 })
  assert.equal(last.vehicleList?.page, 3)
  assert.equal(last.records.filter(record => record.kind === 'vehicle').length, 4)
  const filtered = queries.read('1', { ...query, filters: { owner: ['["Last owner"]'] } })
  assert.deepEqual(filtered.records.filter(record => record.kind === 'vehicle').map(record => record.id), ['v24'])
  assert.equal(filtered.vehicleList?.counts.total, 24)
  assert.equal(queries.read('1', { ...query, detailId: 'v0' }).records.find(record => record.id === 'equipment')?.data.notes, 'x'.repeat(100000))
  const detail = queries.read('1', { ...query, detailId: 'v0' })
  const linked = modificationView(detail.records, 'mod-v0')
  assert.equal(linked.linkedVehicles.length, 2, 'linked scope includes membership outside the current page')
  assert.equal(linked.groupVersion, 3)
  assert(modificationDestinations(detail.records, linked).some(record => record.id === 'v22'), 'populate includes destinations outside the current page')
  assert(!modificationDestinations(detail.records, linked).some(record => record.id === 'v24'))
  assert.deepEqual(queries.read('1', { ...query, reportId: 'report' }).records.find(record => record.id === 'report')?.data.parsed, { controllers: ['Large report'] })
  assert.equal(builds, 1)
  queries.read('2', query); assert.equal(builds, 2)
  assert.throws(() => queries.read('2', { ...query, pageSize: 10000 }), { code: 'INVALID_INPUT' })
})

test('SQL paging preserves Unicode substrings, large selections, archived last pages and global counts', () => {
  const names = ['\u0130STANBUL', '\u039f\u03a3', '\u4e2d\u6587\ud83d\ude99', 'nul\0tail', 'lone\ud800tail', '100%_literal', 'x'.repeat(3900)]
  const records: BusinessRecord[] = Array.from({ length: 47 }, (_, index) => ({ id: `v${index}`, kind: 'vehicle', vehicleId: null, data: { name: names[index % names.length], owner: index % 3 ? 'Owner' : 'Other', status: index % 2 ? 'testing' : 'available' }, archived: index % 5 === 0, version: 1, updated: '2026-11-13' }))
  const queries = new VehicleListQueries(() => ({ records, catalog: { enabled: false, types: builtinComponentTypes }, revisionSummaries: [] }))
  const base = { search: '', archived: false, page: 999, pageSize: 3, filters: {} }
  for (const archived of [false, true]) for (const search of ['', 'i\u0307s', '\u03bf\u03c2', '\ud83d\ude99', '\ud83d', '\0t', '\ud800', '%_', 'x'.repeat(3800), 'absent']) {
    const matches = records.filter(record => (archived || !record.archived) && Object.values(record.data).join(' ').toLowerCase().includes(search.toLowerCase()))
    const actual = queries.read('1', { ...base, archived, search }).vehicleList!
    const page = Math.min(base.page, Math.max(1, Math.ceil(matches.length / base.pageSize)))
    assert.equal(actual.total, matches.length, JSON.stringify(search))
    assert.equal(actual.page, page)
    assert.deepEqual(actual.ids, matches.slice((page - 1) * base.pageSize, page * base.pageSize).map(record => record.id))
    assert.equal(actual.counts.total, records.filter(record => !record.archived).length)
  }
  const selected = Array.from({ length: 20000 }, (_, index) => index === 19999 ? '["Other"]' : `missing${index}`)
  const filtered = queries.read('1', { ...base, status: 'testing', filters: { owner: selected, name: [] } }).vehicleList!
  const matches = records.filter(record => !record.archived && record.data.status === 'testing' && record.data.owner === 'Other')
  assert.equal(filtered.total, matches.length)
  assert.deepEqual(filtered.ids, matches.slice(-3).map(record => record.id))
  assert(filtered.options.owner!.includes('["Owner"]'))
})

test('projection invalidation rebuilds null stamps and survives failed view builds', () => {
  let builds = 0, fail = false
  const record: BusinessRecord = { id: 'v1', kind: 'vehicle', vehicleId: null, data: { name: 'Original' }, archived: false, version: 1, updated: '2026-11-13' }
  const queries = new VehicleListQueries(() => { builds++; if (fail) throw new Error('invalid view'); return { records: [record], catalog: { enabled: false, types: builtinComponentTypes }, revisionSummaries: [] } })
  const query = { search: '', archived: false, page: 1, pageSize: 10, filters: {} }
  queries.read('1', query)
  queries.read('1', query)
  assert.equal(builds, 1)
  fail = true
  assert.throws(() => queries.read('2', query), /invalid view/)
  assert.deepEqual(queries.read('1', query).vehicleList!.ids, ['v1'])
  fail = false
  record.data.name = 'Changed'
  assert.equal(queries.read('2', { ...query, search: 'Changed' }).vehicleList!.total, 1)
  for (let index = 0; index < 5; index++) queries.read(null, query)
  assert.equal(builds, 8)
})


test('SQL facets and selections distinguish lone surrogates from replacement characters', () => {
  const owners = ['lone\ud800', 'lone\ufffd', 'nul\0tail']
  const records: BusinessRecord[] = owners.map((owner, index) => ({ id: `v${index}`, kind: 'vehicle', vehicleId: null, data: { owner }, archived: false, version: 1, updated: '2026-11-13' }))
  const queries = new VehicleListQueries(() => ({ records, catalog: { enabled: false, types: builtinComponentTypes }, revisionSummaries: [] }))
  const query = { search: '', archived: false, page: 1, pageSize: 10, filters: {} }
  assert.deepEqual(queries.read('1', query).vehicleList!.options.owner, owners.map(owner => JSON.stringify([owner])))
  for (const [index, owner] of owners.entries()) assert.deepEqual(queries.read('1', { ...query, filters: { owner: [JSON.stringify([owner])] } }).vehicleList!.ids, [`v${index}`])
  queries.close()
  assert.deepEqual(queries.read('1', query).vehicleList!.ids, ['v0', 'v1', 'v2'])
  queries.close()
})
