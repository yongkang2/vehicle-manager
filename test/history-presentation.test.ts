import test from 'node:test'
import assert from 'node:assert/strict'
import { historyChangedFields } from '../src/history-presentation'

test('creation hides empty snapshot defaults while retaining populated historical values', () => {
  assert.deepEqual(historyChangedFields({ before: null, after: { model: 'EMP2', vin: '001234', blank: '', whitespace: '  ', optional: null, zero: 0, flag: false, list: [], nested: { empty: '' }, serial: 'OLD-001' } }), ['model', 'vin', 'zero', 'flag', 'serial'])
})
test('updates include removed fields and changes to empty, zero and false', () => {
  assert.deepEqual(historyChangedFields({ before: { removedSerial: 'OLD-001', name: 'VCU', mileage: 20, enabled: true, same: 'same' }, after: { name: '', mileage: 0, enabled: false, same: 'same' } }), ['removedSerial', 'name', 'mileage', 'enabled'])
})
