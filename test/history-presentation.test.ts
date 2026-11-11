import test from 'node:test'
import assert from 'node:assert/strict'
import { historyChangedFields, historyFieldValue, historyIsReference } from '../src/history-presentation'

test('creation hides empty snapshot defaults while retaining populated historical values', () => {
  assert.deepEqual(historyChangedFields({ before: null, after: { model: 'EMP2', vin: '001234', blank: '', whitespace: '  ', optional: null, zero: 0, flag: false, list: [], nested: { empty: '' }, serial: 'OLD-001' } }), ['model', 'vin', 'zero', 'flag', 'serial'])
})
test('updates include removed fields and changes to empty, zero and false', () => {
  assert.deepEqual(historyChangedFields({ before: { removedSerial: 'OLD-001', name: 'VCU', mileage: 20, enabled: true, same: 'same' }, after: { name: '', mileage: 0, enabled: false, same: 'same' } }), ['removedSerial', 'name', 'mileage', 'enabled'])
})

test('metadata filtering is scoped to record kind and retains meaningful relationships', () => {
  const after = { checksum: 'abc', size: 100, savedAt: '2026-11-11', parserVersion: 'v2', name: 'report.xlsx', recordedAt: '2026-11-10', legacySerial: '001' }
  assert.deepEqual(historyChangedFields({ kind: 'report', before: null, after }), ['name', 'recordedAt', 'legacySerial'])
  assert.deepEqual(historyChangedFields({ kind: 'vehicle', before: null, after: { size: 100, schema: 1, checksum: 'legacy business value' } }), ['size', 'schema', 'checksum'])
  assert.deepEqual(historyChangedFields({ kind: 'attachment', before: { equipmentId: 'old', size: 0 }, after: { equipmentId: 'new', size: 10 } }), ['equipmentId'])
  assert.deepEqual(historyChangedFields({ kind: 'modification', before: { groupId: 'group' }, after: {} }), ['groupId'])
  assert(historyIsReference('attachment', 'equipmentId'))
  assert(historyIsReference('vehicle', 'photoAttachmentId'))
  assert(!historyIsReference('equipment', 'serial'))
})

test('file replacement remains a business change without showing a checksum on creation', () => {
  assert.deepEqual(historyChangedFields({ kind: 'attachment', before: null, after: { name: 'file.pdf', checksum: 'old' } }), ['name'])
  assert.deepEqual(historyChangedFields({ kind: 'attachment', before: { checksum: 'old' }, after: { checksum: 'new' } }), ['checksum'])
})

test('attachment diffs ignore storage changes but retain filename and archive changes', () => {
  const file = { id: 'file-id', name: 'instructions.pdf', checksum: 'old-hash', size: 100, savedAt: '2026-11-10', archived: false }
  const before = { attachments: [file] }
  assert.deepEqual(historyChangedFields({ before, after: { attachments: [{ ...file, id: 'clone-id', checksum: 'old-hash', size: 200, savedAt: '2026-11-11' }] } }), [])
  assert.deepEqual(historyChangedFields({ before, after: { attachments: [{ ...file, archived: true }] } }), ['attachments'])
  assert.deepEqual(historyChangedFields({ before, after: { attachments: [] } }), ['attachments'])
  assert.deepEqual(historyChangedFields({ before, after: { attachments: [{ ...file, checksum: 'replacement' }] } }), ['attachments'])
  assert.deepEqual(historyFieldValue('attachments', [file]), [{ name: 'instructions.pdf', archived: false }])
})

test('attachment ordering and cloned IDs do not create spurious changes', () => {
  const first = { id: '1', name: 'first.pdf', checksum: 'a', archived: false }
  const second = { id: '2', name: 'second.pdf', checksum: 'b', archived: true }
  assert.deepEqual(historyChangedFields({ before: { attachments: [first, second] }, after: { attachments: [{ ...second, id: '3' }, first] } }), [])
})
