import { test } from 'node:test'
import assert from 'node:assert/strict'
import { matchesReportSearch, reportMonth } from '../src/report-archive.js'
import type { BusinessRecord } from '../shared/business.js'
const report = { kind: 'report', vehicleId: 'car', archived: true, data: { name: '03-software-upgrade.xlsx', recordedAt: '2026-10-03 09h30', savedAt: '2026-11-06' } } as BusinessRecord
const car = { data: { model: 'E-P64', vin: 'TEST0000000000001', project: 'D85' } } as BusinessRecord

test('compound report search combines vehicle, VIN, filename and time terms regardless of archive state', () => {
  assert.equal(matchesReportSearch(report, car, 'e-p64 0001 software 2026-10'), true)
  assert.equal(matchesReportSearch(report, car, 'D85 09:30'), true)
  assert.equal(matchesReportSearch(report, car, 'e-p64 0002'), false)
  assert.equal(matchesReportSearch(report, undefined, 'software 2026-10'), true)
  assert.equal(matchesReportSearch(report, car, '  '), true)
})
test('report month follows acquisition date, including unknown dates', () => {
  assert.equal(reportMonth(report), '2026-10')
  assert.equal(reportMonth({ ...report, data: { recordedAt: '' } }), 'unknown')
})
