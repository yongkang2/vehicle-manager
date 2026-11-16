import assert from 'node:assert/strict'
import { performance } from 'node:perf_hooks'
import { VehicleListQueries } from '../server/vehicle-list.js'
import type { BusinessRecord } from '../shared/business.js'
import { builtinComponentTypes } from '../shared/configuration-revisions.js'
import { createVehicleFilterKeys } from '../shared/vehicle-table-values.js'
import { vehicleColumnIds } from '../shared/vehicle-table.js'

// Synthetic, in-process measurements; not a substitute for a representative user workspace.
const size = Number(process.argv[2] || 10000)
assert(Number.isSafeInteger(size) && size > 0)
const records: BusinessRecord[] = Array.from({ length: size }, (_, index) => ({ id: `v${index}`, kind: 'vehicle', vehicleId: null, data: { name: `Vehicle ${index}`, owner: `Owner ${index % 100}`, status: index % 2 ? 'testing' : 'available', notes: 'Synthetic payload '.repeat(20) }, archived: index % 13 === 0, version: 1, updated: '2026-11-13' }))
const view = { records, catalog: { enabled: false, types: builtinComponentTypes }, revisionSummaries: [] }
const keys = createVehicleFilterKeys(records)
const queries = new VehicleListQueries(() => view)
const query = { search: '', archived: false, page: 50, pageSize: 20, filters: {} }
const start = performance.now()
queries.read('1', query)
const cold = performance.now() - start
function baseline() {
  const eligible = records.filter(record => !record.archived)
  const options = Object.fromEntries(vehicleColumnIds.filter(column => column !== 'actions').map(column => [column, [...new Set(eligible.map(record => keys.get(record.id)![column]))]]))
  const matches = eligible.filter(record => Object.values(record.data).join(' ').toLowerCase().includes(query.search))
  const page = Math.min(query.page, Math.max(1, Math.ceil(matches.length / query.pageSize)))
  return { total: matches.length, ids: matches.slice((page - 1) * query.pageSize, page * query.pageSize).map(record => record.id), options }
}
assert.deepEqual(queries.read('1', query).vehicleList!.ids, baseline().ids)
function measure(read: () => unknown) {
  for (let index = 0; index < 5; index++) read()
  const times = Array.from({ length: 30 }, () => { const before = performance.now(); read(); return performance.now() - before }).sort((a, b) => a - b)
  return { medianMs: +times[15].toFixed(2), p95Ms: +times[28].toFixed(2) }
}
console.log(JSON.stringify({ vehicles: size, coldProjectionMs: +cold.toFixed(2), previousFilterAndFacets: measure(baseline), sqlFullResponse: measure(() => queries.read('1', query)), retainedValidatedView: true }, null, 2))
queries.close()
