import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { BusinessRecord, Controller, DovePreview, DoveBatchSaveResult } from '../shared/business.js'
import {
  applyBatchSaveResults, canRetainDoveRow, canReviewDoveRow, clearManualDoveBinding,
  confirmationForReview, failedDoveReviewRow, initialReviewChoice, needsOlderDoveReview, reviewChoiceBlocked,
} from '../src/dove-import-review.js'

const time = Date.parse('2026-10-21T12:00:00Z'), vin = 'TEST0000000000001'
function record(id: string, kind: BusinessRecord['kind'], data: BusinessRecord['data'], vehicleId: string | null = 'vehicle-a', version = 1): BusinessRecord {
  return { id, kind, vehicleId, data, version, archived: false, updated: '2026-10-21T12:00:00Z' }
}
function controller(name: string, software = '2.0'): Controller {
  return { name, software, description: '', network: 'CAN', supplier: '', functionalPart: '', productPart: '', calibrationPart: '', calibrationVersion: '', flashingDate: '', productionDate: '', serial: '' }
}
function preview(manual = true): DovePreview {
  return {
    id: 'draft-a', filename: 'demo.xlsx', checksum: 'checksum-a', size: 123, expires: time + 30 * 60_000,
    parsed: { vin: manual ? '' : vin, rawVin: manual ? '' : vin, vehicleId: '', recordedAt: '2026-10-20 12h00', software: '', mileage: null, soc: null, vehicleMode: '', controllers: [controller('EVCU'), controller('MCU'), controller('BMS')], faults: [], warnings: manual ? ['VIN_MISSING'] : [], sheets: ['DOVE', 'Identification', 'Defauts'] },
    vehicle: record('vehicle-a', 'vehicle', { vin }, null), match: 'matched', existingId: null,
    currentControllers: [record('vcu', 'part', { name: 'VCU', category: 'controller', reportRecordedAt: '2026-10-19 12h00' }, 'vehicle-a', 4), record('bms', 'part', { name: 'MSB', category: 'controller', reportRecordedAt: '2026-10-19 12h00' }, 'vehicle-a', 7)],
    ...(manual ? { manualBinding: { vehicleId: 'vehicle-a', vin, token: 'binding-a' } } : {}),
  }
}
const row = (value = preview()) => ({ uid: value.id, preview: value })

test('manual review defaults to report-only while normal review preserves controller-import defaults', () => {
  const manual = preview(), normal = preview(false), before = structuredClone(manual)
  assert.deepEqual(initialReviewChoice(manual), { reportOnly: true, allowOlder: false, selections: { VCU: 0, MCU: 1, 'BMS/MSB': 2 } })
  assert.deepEqual(initialReviewChoice(normal), { reportOnly: false, allowOlder: false, selections: { VCU: 0, MCU: 1, 'BMS/MSB': 2 } })
  assert.deepEqual(manual, before)
  const ambiguous = preview()
  ambiguous.parsed.controllers.push(controller('VCU', '3.0'))
  assert.equal(initialReviewChoice(ambiguous).selections?.VCU, undefined)
})

test('unresolved VINless reports are reviewable but cannot be finally imported without binding', () => {
  const unbound = clearManualDoveBinding(preview()), current = row(unbound), choice = initialReviewChoice(unbound)
  assert.equal(canReviewDoveRow(current, time), true)
  assert.equal(canRetainDoveRow(current, time), false)
  assert.equal(reviewChoiceBlocked(current, choice, time), true)
  assert.equal(confirmationForReview(current, choice, time), null)
  assert.equal(unbound.match, 'manual-required')
  assert.equal(unbound.vehicle, null)
  assert.equal(unbound.manualBinding, undefined)
  assert.deepEqual(unbound.currentControllers, [])
  assert.equal(unbound.existingId, null)
})

test('clearing a manual binding drops the target and reviewed versions without changing source provenance', () => {
  const original = preview(), before = structuredClone(original), cleared = clearManualDoveBinding(original)
  assert.deepEqual(original, before)
  assert.equal(cleared.parsed.vin, '')
  assert.equal(cleared.parsed.rawVin, '')
  assert.equal(cleared.id, original.id)
  assert.equal(cleared.checksum, original.checksum)
  assert.equal(cleared.expires, original.expires)
  assert.equal(cleared.manualBinding, undefined)
  assert.deepEqual(cleared.currentControllers, [])
  assert.equal(cleared.vehicle, null)
})

test('one final manual confirmation carries the reviewed binding token, acknowledgment, and all controller versions', () => {
  const current = row(), choice = initialReviewChoice(current.preview), before = structuredClone({ current, choice })
  const confirmation = confirmationForReview(current, choice, time)
  assert.ok(confirmation)
  assert.equal(confirmation.confirmed, true)
  assert.equal(confirmation.manualVehicleConfirmed, true)
  assert.equal(confirmation.bindingToken, 'binding-a')
  assert.equal(confirmation.reportOnly, true)
  assert.equal(confirmation.allowOlder, false)
  assert.deepEqual(confirmation.versions, { VCU: 4, MCU: null, 'BMS/MSB': 7 })
  assert.deepEqual({ current, choice }, before)
  const replacement = preview()
  replacement.manualBinding!.token = 'binding-b'
  replacement.currentControllers[0].version = 9
  const next = confirmationForReview(row(replacement), initialReviewChoice(replacement), time)
  assert.equal(next?.bindingToken, 'binding-b')
  assert.equal(next?.versions?.VCU, 9)
  assert.equal(confirmation.bindingToken, 'binding-a')
  assert.equal(confirmation.versions?.VCU, 4)
})

test('normal final confirmation has no manual acknowledgment or binding token', () => {
  const current = row(preview(false)), choice = initialReviewChoice(current.preview)
  const confirmation = confirmationForReview(current, choice, time)
  assert.ok(confirmation)
  assert.equal(confirmation.reportOnly, false)
  assert.equal(confirmation.bindingToken, undefined)
  assert.equal(confirmation.manualVehicleConfirmed, undefined)
  assert.deepEqual(confirmation.versions, { VCU: 4, MCU: null, 'BMS/MSB': 7 })
})

test('manual older-report permission follows final explicit controller opt-in, never report-only retention', () => {
  const current = row()
  current.preview.currentControllers[0].data.reportRecordedAt = '2026-10-21 12h00'
  assert.equal(needsOlderDoveReview(current.preview), true)
  const reportOnly = { ...initialReviewChoice(current.preview), allowOlder: true }
  assert.equal(confirmationForReview(current, reportOnly, time)?.allowOlder, false)
  const optIn = { ...reportOnly, reportOnly: false, allowOlder: false }
  assert.equal(reviewChoiceBlocked(current, optIn, time), false)
  assert.equal(confirmationForReview(current, optIn, time)?.allowOlder, true)
  current.preview.currentControllers[0].data.reportRecordedAt = '2026-10-19 12h00'
  assert.equal(needsOlderDoveReview(current.preview), false)
  assert.equal(confirmationForReview(current, { ...optIn, allowOlder: true }, time)?.allowOlder, false)
})

test('normal older-report acknowledgment remains required only for controller updates', () => {
  const current = row(preview(false))
  current.preview.currentControllers[0].data.reportRecordedAt = '2026-10-21 12h00'
  const choice = initialReviewChoice(current.preview)
  assert.equal(reviewChoiceBlocked(current, choice, time), true)
  assert.equal(confirmationForReview(current, choice, time), null)
  assert.equal(reviewChoiceBlocked(current, { ...choice, allowOlder: true }, time), false)
  assert.equal(confirmationForReview(current, { ...choice, allowOlder: true }, time)?.allowOlder, true)
  assert.equal(reviewChoiceBlocked(current, { ...choice, reportOnly: true }, time), false)
})

test('controller source conflicts and duplicate working controllers do not block report-only import', () => {
  const current = row()
  current.preview.parsed.controllers.push(controller('VCU', '3.0'))
  let choice = initialReviewChoice(current.preview)
  assert.equal(reviewChoiceBlocked(current, choice, time), false)
  assert.equal(reviewChoiceBlocked(current, { ...choice, reportOnly: false }, time), true)
  choice = { ...choice, reportOnly: false, selections: { ...choice.selections, VCU: 3 } }
  assert.equal(reviewChoiceBlocked(current, choice, time), false)
  current.preview.currentControllers.push(record('duplicate-vcu', 'part', { category: 'controller', name: 'EVCU' }))
  assert.equal(reviewChoiceBlocked(current, choice, time), true)
  assert.equal(reviewChoiceBlocked(current, { ...choice, reportOnly: true }, time), false)
})

test('final confirmation excludes saved, expired, erroneous, and unbound reports', () => {
  const current = row(), choice = initialReviewChoice(current.preview)
  assert.equal(canRetainDoveRow(current, time), true)
  assert.equal(confirmationForReview(current, undefined, time), null)
  for (const blocked of [{ ...current, savedId: 'saved-report' }, { ...current, error: 'VERSION_CONFLICT' }, { ...current, preview: { ...current.preview, expires: time - 1 } }, { ...current, preview: clearManualDoveBinding(current.preview) }, { uid: 'no-preview' }]) {
    assert.equal(canRetainDoveRow(blocked, time), false)
    assert.equal(confirmationForReview(blocked, choice, time), null)
  }
})

test('manual stale-target, token, and version errors invalidate the private binding for explicit retry', () => {
  const current = row(), before = structuredClone(current)
  for (const code of ['MANUAL_VEHICLE_REQUIRED', 'MANUAL_BINDING_CHANGED', 'VEHICLE_SELECTION_CHANGED', 'VEHICLE_DELETED', 'VERSION_CONFLICT']) {
    const failed = failedDoveReviewRow(current, code)
    assert.equal(failed.error, code)
    assert.equal(failed.preview?.manualBinding, undefined, code)
    assert.equal(failed.preview?.match, 'manual-required', code)
    assert.deepEqual(failed.preview?.currentControllers, [], code)
    assert.equal(canRetainDoveRow(failed, time), false)
  }
  assert.deepEqual(current, before)
  const expired = failedDoveReviewRow(current, 'DRAFT_EXPIRED')
  assert.equal(expired.preview?.expires, 0)
  assert.equal(expired.preview?.manualBinding, undefined)
  assert.equal(canReviewDoveRow(expired, time), true)
  assert.equal(canRetainDoveRow(expired, time), false)
  const normal = row(preview(false))
  assert.equal(failedDoveReviewRow(normal, 'VERSION_CONFLICT').preview?.parsed.vin, vin)
})

test('transient save failures can retry the same reviewed target but stale target identity cannot', () => {
  const current = row(), choice = initialReviewChoice(current.preview)
  for (const code of ['NETWORK_ERROR', 'SERVER_ERROR']) {
    const failed = failedDoveReviewRow(current, code)
    assert.equal(canReviewDoveRow(failed, time), true)
    assert.equal(canRetainDoveRow(failed, time), true)
    assert.equal(confirmationForReview(failed, choice, time)?.bindingToken, 'binding-a')
  }
  for (const changed of [
    { ...current.preview, manualBinding: { ...current.preview.manualBinding!, token: '' } },
    { ...current.preview, manualBinding: { ...current.preview.manualBinding!, vehicleId: 'different-vehicle' } },
    { ...current.preview, manualBinding: { ...current.preview.manualBinding!, vin: 'TEST0000000000002' } },
  ]) {
    const changedRow = row(changed)
    assert.equal(canRetainDoveRow(changedRow, time), false)
    assert.equal(confirmationForReview(changedRow, choice, time), null)
  }
})

test('partial batch success keeps unresolved and failed rows while already saved rows cannot be retried', () => {
  const saved = row(), failed = row({ ...preview(), id: 'draft-failed' }), unresolved = row({ ...clearManualDoveBinding(preview()), id: 'draft-unresolved' })
  const savedRecord = record('report-saved', 'report', { checksum: saved.preview.checksum })
  const results: DoveBatchSaveResult[] = [{ draftId: saved.preview.id, record: savedRecord }, { draftId: failed.preview.id, error: 'MANUAL_BINDING_CHANGED' }]
  const original = [saved, failed, unresolved], before = structuredClone(original), updated = applyBatchSaveResults(original, results)
  assert.equal(updated.length, 3)
  assert.equal(updated[0].savedId, savedRecord.id)
  assert.equal(updated[0].error, undefined)
  assert.equal(updated[1].error, 'MANUAL_BINDING_CHANGED')
  assert.equal(updated[1].preview?.manualBinding, undefined)
  assert.equal(updated[2].preview?.match, 'manual-required')
  assert.equal(canReviewDoveRow(updated[0], time), false)
  assert.equal(canRetainDoveRow(updated[0], time), false)
  assert.equal(confirmationForReview(updated[0], initialReviewChoice(saved.preview), time), null)
  assert.deepEqual(original, before)
})

test('retained duplicate propagation is scoped by vehicle UUID and checksum, never checksum alone', () => {
  const saved = row(), duplicate = row({ ...preview(), id: 'draft-duplicate' }), other = preview()
  other.id = 'draft-other'
  other.vehicle = record('vehicle-b', 'vehicle', { vin: 'TEST0000000000002' }, null)
  other.manualBinding = { vehicleId: 'vehicle-b', vin: 'TEST0000000000002', token: 'binding-other' }
  const otherRow = row(other), savedRecord = record('report-saved', 'report', { checksum: saved.preview.checksum })
  const updated = applyBatchSaveResults([saved, duplicate, otherRow], [{ draftId: saved.preview.id, record: savedRecord }])
  assert.equal(updated[1].preview?.existingId, 'report-saved')
  assert.equal(updated[2].preview?.existingId, null)
  assert.equal(updated[2].savedId, undefined)
})
