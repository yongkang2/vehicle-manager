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
