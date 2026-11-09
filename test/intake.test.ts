import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseIntakeFields, matchIntakeRecords } from '../shared/intake.js'

test('recognition accepts only evidence-backed identifiers and preserves leading zeros', () => {
  assert.deepEqual(parseIntakeFields({ serial: '00123', productPart: 'ABC', lifeStatus: 'BOL' }), { serial: '00123', productPart: 'ABC' })
  assert.throws(() => parseIntakeFields({ serial: 123 }))
  assert.throws(() => parseIntakeFields({ vin: 'invalid' }))
  assert.throws(() => parseIntakeFields({ serial: 'x'.repeat(401) }))
})

test('matching never picks a shared part number as a unique physical identity', () => {
  const rows = ['a', 'b'].map(id => ({ id, kind: 'part' as const, vehicleId: id, data: { serial: '00123', productPart: 'ABC' }, archived: false, version: 1, updated: '' }))
  assert.deepEqual(matchIntakeRecords(rows, { serial: '00123' }).map(row => row.id), ['a', 'b'])
  assert.deepEqual(matchIntakeRecords(rows, { serial: '00124' }), [])
  assert.equal(matchIntakeRecords(rows, { productPart: 'ABC' }).length, 2)
  assert.equal(matchIntakeRecords([{ ...rows[0], archived: true }], { serial: '00123' }).length, 0)
  const vehicle = { ...rows[0], id: 'a', kind: 'vehicle' as const, vehicleId: null, data: { vin: 'TEST0000000000001' } }
  assert.deepEqual(matchIntakeRecords([vehicle, ...rows], { vin: 'TEST0000000000001', serial: '00123' }).map(row => row.id), ['a'])
})
