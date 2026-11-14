import { test } from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import ExcelJS from 'exceljs'
import { LocalStore } from '../server/store.js'
import { History } from '../server/history.js'
import type { Change } from '../shared/business.js'
import { HistoryQueries } from '../server/history-queries.js'

test('derived history search tracks append, update, delete and literal nested values without losing exact matching', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vm-history-search-')), store = new LocalStore(root)
  try {
    const insert = store.db.prepare('INSERT INTO changes VALUES(?,?,?,?,?)')
    const change: Change = { id: 'one', recordId: 'part', vehicleId: 'car', kind: 'part', before: null, after: { nested: { serial: 'OLD_100%', note: 'quote" slash\\ test', softwareVersion: 'v1', unicode: 'Äctor', state: true, nul: 'before\0notVisible', later: 'after-null-visible' } }, archivedBefore: null, archivedAfter: false, actor: { id: 'actor', name: 'Actor', role: 'member', deviceId: 'device' }, reason: 'indexed', action: 'created', sourceId: null, created: '2026-11-11T00:00:00Z' }
    insert.run(change.id, change.recordId, change.vehicleId, JSON.stringify(change), change.created)
    const history = new History(store)
    for (const q of ['OLD_100%', 'quote"', 'slash\\', 'Actor 软件版本 v1', 'Äctor', 'after-null-visible']) assert.equal(history.query({ q }).total, 1, q)
    assert.equal(history.query({ q: 'notVisible' }).total, 0)
    assert.equal(history.query({ q: 'äctor' }).total, 0)
    assert.equal(history.query({ q: 'missing' }).total, 0)
    insert.run('two', 'part', 'car', JSON.stringify({ ...change, id: 'two', reason: 'appended' }), change.created)
    assert.equal(history.query({ q: 'appended' }).total, 1)
    store.db.prepare('UPDATE changes SET payload=? WHERE id=?').run(JSON.stringify({ ...change, reason: 'corrected' }), 'one')
    assert.equal(history.query({ q: 'corrected' }).total, 1)
    store.db.prepare('DELETE FROM changes WHERE id=?').run('one')
    assert.equal(history.query({ q: 'corrected' }).total, 0)
    assert.equal(history.query({ q: 'OLD_100%' }).total, 1)
  } finally { store.db.close(); await fs.rm(root, { recursive: true, force: true }) }
})

test('background history queries preserve results, observe new writes and release database handles', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vm-history-worker-')), store = new LocalStore(root), queries = new HistoryQueries(root)
  try {
    const change: Change = { id: 'one', recordId: 'part', vehicleId: 'car', kind: 'part', before: null, after: { software: 'indexed value' }, archivedBefore: null, archivedAfter: false, actor: { id: 'actor', name: 'Actor', role: 'member', deviceId: 'device' }, reason: 'background', action: 'created', sourceId: null, created: '2026-11-11T00:00:00Z' }
    const insert = store.db.prepare('INSERT INTO changes VALUES(?,?,?,?,?)')
    insert.run(change.id, change.recordId, change.vehicleId, JSON.stringify(change), change.created)
    assert.deepEqual(await queries.query({ q: 'indexed', summary: '1' }), new History(store).query({ q: 'indexed', summary: '1' }))
    insert.run('two', 'part', 'car', JSON.stringify({ ...change, id: 'two' }), change.created)
    assert.equal((await queries.query({ q: 'indexed', summary: '1' })).total, 2)
    await assert.rejects(queries.query({ page: '0' }), /INVALID_INPUT/)
    assert.equal((await queries.query({ q: 'indexed' })).total, 2)
    store.db.prepare('DELETE FROM changes WHERE id=?').run('one')
    assert.equal((await queries.query({ q: 'indexed' })).total, 1)
  } finally { await queries.close(); store.db.close(); await fs.rm(root, { recursive: true, force: true }) }
  await assert.rejects(queries.query({}), /REQUEST_CANCELLED/)
})

test('history searches all persisted changes, paginates stably and exports deleted fields and attribution', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vm-history-'))
  const store = new LocalStore(root)
  try {
    const insert = store.db.prepare('INSERT INTO changes VALUES (?,?,?,?,?)')
    for (let i = 0; i < 1251; i++) {
      const change: Change = { id: `c${i}`, recordId: 'part', vehicleId: i === 1250 ? 'other' : 'car', kind: 'part', before: { serialNumber: i === 0 ? 'OLD_100%' : 'previous', removed: 'deleted value' }, after: { serialNumber: `new-${i}` }, actor: { id: 'actor-id', name: 'Historical Name', role: 'member', deviceId: 'device' }, reason: 'replacement', action: 'updated', sourceId: 'report-id', created: '2026-11-04T00:00:00Z', archivedBefore: false, archivedAfter: false }
      insert.run(change.id, change.recordId, change.vehicleId, JSON.stringify(change), change.created)
    }
    const history = new History(store)
    assert.equal(history.query({}).total, 1251)
    assert.equal(history.query({ vehicleId: 'car' }).total, 1250)
    assert.equal(history.query({ vehicleId: 'car' }).items[0].id, 'c1249')
    assert.equal(history.query({ vehicleId: 'car', page: '2' }).items[0].id, 'c1199')
    const allIds = Array.from({ length: 25 }, (_, index) => history.query({ vehicleId: 'car', page: String(index + 1) }).items.map(item => item.id)).flat()
    assert.equal(new Set(allIds).size, 1250)
    assert.equal(allIds.at(-1), 'c0')
    assert.deepEqual(history.query({ vehicleId: 'car', page: '26' }).items, [])
    assert.equal(history.query({ vehicleId: 'car', q: 'OLD_100%' }).items[0].id, 'c0')
    assert.equal(history.query({ vehicleId: 'car', q: 'Historical serialNumber OLD_100%' }).items[0].id, 'c0')
    assert.equal(history.query({ vehicleId: 'car', q: 'Historical 序列号 OLD_100%' }).total, 1)
    assert.equal(history.query({ q: 'Historical impossible-term' }).total, 0)
    assert.equal(history.query({ q: '%' }).total, 1)
    assert.equal(history.query({ kind: 'part', date: '2026-11-04', offset: '-480', q: 'OLD_100%', vehicleId: 'car' }).total, 1)
    assert.equal(history.query({ kind: 'vehicle' }).total, 0)
    assert.equal(history.query({ kind: 'configurationRevision' }).total, 0)
    assert.equal(history.query({ kind: 'componentType' }).total, 0)
    assert.equal(history.query({ date: '2026-11-03', offset: '480' }).total, 1251)
    assert.equal(history.query({ date: '2026-11-03', offset: '0' }).total, 0)
    for (const input of [{ kind: 'unknown' }, { date: '2026-02-30', offset: '0' }, { date: '2025-02-29', offset: '0' }, { date: '2026-11-04' }, { offset: '841' }, { offset: '-841' }, { offset: '1.5' }]) assert.throws(() => history.query(input), /INVALID_INPUT/)
    for (const q of ['Historical Name', 'replacement', 'part', 'deleted value']) assert.equal(history.query({ vehicleId: 'car', q }).total, 1250)
    for (const input of [{ page: '0' }, { page: '1.5' }, { page: '99999999999999999999' }, { q: [] }, { vehicleId: [] }]) assert.throws(() => history.query(input), /INVALID_INPUT/)
    await assert.rejects(history.export({ vehicleId: [] }), /INVALID_INPUT/)
    const file = await history.export({ vehicleId: 'car' })
    try {
      const workbook = new ExcelJS.Workbook()
      await workbook.xlsx.readFile(file.path)
      const sheet = workbook.worksheets[0]
      assert.equal(sheet.rowCount, 2501)
      const removed = sheet.getRow(3).values as unknown[]
      assert(removed.includes('removed')); assert(removed.includes('deleted value'))
      assert.equal(sheet.getRow(3).getCell(12).value, null)
      assert(removed.includes('Historical Name')); assert(removed.includes('actor-id')); assert(removed.includes('report-id'))
      assert(!JSON.stringify(sheet.getSheetValues()).includes('c1250'))
    } finally { await file.cleanup() }
  } finally { store.db.close(); await fs.rm(root, { recursive: true, force: true }) }
})

test('history uses vehicle model/VIN labels, historical vehicle fallbacks and filter-independent options', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vm-history-labels-'))
  const store = new LocalStore(root)
  try {
    const record = store.db.prepare('INSERT INTO records VALUES (?,?,?,?,?,?,?,?)')
    record.run('car', 'vehicle', null, 'CURRENT-VIN', JSON.stringify({ model: 'Current Model', vin: 'CURRENT-VIN' }), 1, 1, 'now')
    record.run('vin-only', 'vehicle', null, 'ONLY-VIN', JSON.stringify({ model: '  ', vin: 'ONLY-VIN' }), 0, 1, 'now')
    const insert = store.db.prepare('INSERT INTO changes VALUES (?,?,?,?,?)')
    const add = (id: string, vehicleId: string, kind: Change['kind'], after: Change['after'], created = '2026-11-03T16:00:00.000Z') => {
      const change: Change = { id, recordId: id, vehicleId, kind, before: null, after, archivedBefore: null, archivedAfter: false, actor: { id: 'actor', name: 'Snapshot Actor', role: 'member', deviceId: 'device' }, action: 'created', reason: 'reason', sourceId: null, created }
      insert.run(id, id, vehicleId, JSON.stringify(change), created)
    }
    add('a', 'car', 'part', { name: 'Unrelated Part' })
    add('b', 'deleted', 'vehicle', { model: 'Historical Model', vin: 'OLD-VIN' })
    add('c', 'deleted', 'part', { name: 'Unrelated Part' })
    add('d', 'unknown', 'part', { name: 'Never Vehicle Label' })
    add('e', 'vin-only', 'part', {})
    add('configuration', 'car', 'configurationRevision', { name: 'Configuration' })
    add('component-type', 'car', 'componentType', { name: 'Component Type' })
    add('software', 'software-car', 'part', { softwareVersion: 'v2', hardwareVersion: 'H1', calibrationVersion: 'C1', owner: 'Alex', notes: 'literal_%' })
    add('end', 'car', 'part', {}, '2026-11-04T16:00:00.000Z')
    add('before', 'car', 'part', {}, '2026-11-03T15:59:59.999Z')
    const history = new History(store)
    const all = history.query({})
    assert.equal(all.items.find(item => item.id === 'a')!.vehicleLabel, 'Current Model')
    assert.equal(all.items.find(item => item.id === 'c')!.vehicleLabel, 'Historical Model')
    assert.equal(all.items.find(item => item.id === 'd')!.vehicleLabel, 'unknown')
    assert.equal(all.items.find(item => item.id === 'e')!.vehicleLabel, 'ONLY-VIN')
    assert(all.vehicleOptions.some(item => item.id === 'car' && item.label === 'Current Model · CURRENT-VIN'))
    assert(all.vehicleOptions.some(item => item.id === 'deleted' && item.label === 'Historical Model · OLD-VIN'))
    const filtered = history.query({ vehicleId: 'car', kind: 'part', q: 'CURRENT-VIN', date: '2026-11-04', offset: '-480' })
    assert.deepEqual(filtered.items.map(item => item.id), ['a'])
    assert.deepEqual(filtered.vehicleOptions, all.vehicleOptions)
    assert.equal(history.query({ q: 'Current Model' }).total, 5)
    assert.deepEqual(history.query({ kind: 'configurationRevision' }).items.map(item => item.id), ['configuration'])
    assert.deepEqual(history.query({ kind: 'componentType' }).items.map(item => item.id), ['component-type'])
    for (const q of ['Alex 软件', 'Alex 软件版本', 'Alex hardware', 'Alex 硬件版本', 'Alex 标定版本', 'Alex 负责人', 'Alex 备注 literal_%']) assert.deepEqual(history.query({ q }).items.map(item => item.id), ['software'], q)
    assert.equal(history.query({ q: 'Alex 软件 missing' }).total, 0)
    assert.equal(filtered.items[0].actor.name, 'Snapshot Actor')
    assert.deepEqual(history.query({ kind: 'part', q: 'Historical Model' }).items.map(item => item.id), ['c'])
    assert.deepEqual(history.query({ kind: 'part', q: 'OLD-VIN' }).items.map(item => item.id), ['c'])
    add('dst-spring-start', 'spring', 'part', {}, '2026-03-08T05:00:00.000Z')
    add('dst-spring-last', 'spring', 'part', {}, '2026-03-09T03:59:59.999Z')
    add('dst-spring-end', 'spring', 'part', {}, '2026-03-09T04:00:00.000Z')
    assert.deepEqual(history.query({ vehicleId: 'spring', date: '2026-03-08', offset: '300', endOffset: '240' }).items.map(item => item.id), ['dst-spring-last', 'dst-spring-start'])
    add('dst-fall-start', 'fall', 'part', {}, '2026-11-01T04:00:00.000Z')
    add('dst-fall-last', 'fall', 'part', {}, '2026-11-02T04:59:59.999Z')
    add('dst-fall-end', 'fall', 'part', {}, '2026-11-02T05:00:00.000Z')
    assert.deepEqual(history.query({ vehicleId: 'fall', date: '2026-11-01', offset: '240', endOffset: '300' }).items.map(item => item.id), ['dst-fall-last', 'dst-fall-start'])
    for (const endOffset of ['841', '-841', '0.5', '', 'invalid']) assert.throws(() => history.query({ date: '2026-11-01', offset: '240', endOffset }), /INVALID_INPUT/)
  } finally { store.db.close(); await fs.rm(root, { recursive: true, force: true }) }
})

test('history export preserves vehicle/object context and oversized nested values across labelled text parts', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vm-history-large-'))
  const store = new LocalStore(root)
  try {
    store.db.prepare('INSERT INTO records VALUES (?,?,?,?,?,?,?,?)').run('car', 'vehicle', null, 'VIN-CURRENT', JSON.stringify({ name: 'Current Vehicle', vin: 'VIN-CURRENT' }), 0, 1, 'now')
    const longValue = { nested: 'x'.repeat(70000) }
    const change: Change = { id: 'change', recordId: 'part', vehicleId: 'car', kind: 'part', before: { name: 'Object Name', serialNumber: 'OLD' }, after: { name: 'Object Name', serialNumber: 'NEW', report: longValue }, archivedBefore: false, archivedAfter: false, actor: { id: 'actor', name: 'Original Name', role: 'member', deviceId: 'device' }, action: 'updated', reason: 'reason', sourceId: 'source', created: 'now' }
    store.db.prepare('INSERT INTO changes VALUES (?,?,?,?,?)').run(change.id, change.recordId, change.vehicleId, JSON.stringify(change), change.created)
    const file = await new History(store).export({ vehicleId: 'car' })
    try {
      const workbook = new ExcelJS.Workbook()
      await workbook.xlsx.readFile(file.path)
      const sheet = workbook.worksheets[0]
      const parts: string[] = []
      sheet.eachRow((row, index) => {
        if (index === 1) return
        assert.equal(row.getCell(15).value, 'Current Vehicle')
        assert.equal(row.getCell(16).value, 'VIN-CURRENT')
        assert.equal(row.getCell(17).value, 'Object Name')
        assert.equal(row.getCell(18).value, '{"serialNumber":"OLD"}')
        assert.equal(row.getCell(19).value, '{"serialNumber":"NEW"}')
        row.eachCell(cell => assert(String(cell.value).length <= 32767))
        if (row.getCell(10).value === 'report') {
          parts.push(String(row.getCell(12).value))
          assert.equal(row.getCell(20).value, `${parts.length}/3`)
        }
      })
      assert.equal(parts.join(''), JSON.stringify(longValue))
    } finally { await file.cleanup() }
  } finally { store.db.close(); await fs.rm(root, { recursive: true, force: true }) }
})

test('history export uses the complete filtered selection and each row own vehicle metadata', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vm-history-filter-export-'))
  const store = new LocalStore(root)
  try {
    const insert = store.db.prepare('INSERT INTO changes VALUES (?,?,?,?,?)')
    for (const id of ['one', 'two']) store.db.prepare('INSERT INTO records VALUES (?,?,?,?,?,?,?,?)').run(id, 'vehicle', null, `VIN-${id}`, JSON.stringify({ name: `Vehicle ${id}`, vin: `VIN-${id}` }), 0, 1, 'now')
    for (let i = 0; i < 68; i++) {
      const change: Change = { id: `change-${i}`, recordId: 'part', vehicleId: i === 67 ? 'two' : 'one', kind: 'part', before: { softwareVersion: 'v1' }, after: { softwareVersion: 'v2' }, archivedBefore: false, archivedAfter: false, actor: { id: 'actor', name: i === 66 ? 'Other Actor' : 'Alex', role: 'member', deviceId: 'device' }, action: 'updated', reason: 'upgrade', sourceId: null, created: i === 65 ? '2026-11-03T00:00:00Z' : '2026-11-04T00:00:00Z' }
      insert.run(change.id, change.recordId, change.vehicleId, JSON.stringify(change), change.created)
    }
    const history = new History(store)
    const filters = { vehicleId: 'one', date: '2026-11-04', offset: '0', endOffset: '0', q: 'Alex 软件', kind: 'part', page: '2' }
    assert.equal(history.query(filters).total, 65)
    for (const [input, expected] of [[filters, 65], [{ q: 'Alex missing' }, 0], [{}, 68]] as const) {
      const file = await history.export(input)
      try {
        const workbook = new ExcelJS.Workbook()
        await workbook.xlsx.readFile(file.path)
        const sheet = workbook.worksheets[0]
        assert.equal(sheet.rowCount, expected + 1)
        sheet.eachRow((row, index) => {
          if (index === 1) return
          const vehicleId = row.getCell(7).value
          assert.equal(row.getCell(15).value, `Vehicle ${vehicleId}`)
          assert.equal(row.getCell(16).value, `VIN-${vehicleId}`)
          if ('vehicleId' in input) assert.equal(vehicleId, 'one')
        })
      } finally { await file.cleanup() }
    }
  } finally { store.db.close(); await fs.rm(root, { recursive: true, force: true }) }
})

test('history excludes modification activation from lists and exports while retaining audit evidence', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vm-history-activation-'))
  const store = new LocalStore(root)
  try {
    const activation: Change = { id: 'activation', recordId: 'modification-activation', vehicleId: 'modification-activation', kind: 'modificationGroup', before: null, after: { name: 'Vehicle Modification enabled' }, archivedBefore: null, archivedAfter: false, actor: { id: 'admin', name: 'Admin', role: 'admin', deviceId: 'device' }, reason: 'Client forced update confirmed.', action: 'modification.enabled', sourceId: null, created: '2026-11-09T06:41:04Z' }
    const edit: Change = { ...activation, id: 'edit', recordId: 'modification', vehicleId: 'car', kind: 'modification', action: 'modification.sharedUpdated', reason: 'Updated equipment', after: { name: 'New equipment' } }
    const insert = store.db.prepare('INSERT INTO changes VALUES (?,?,?,?,?)')
    for (const change of [activation, edit]) insert.run(change.id, change.recordId, change.vehicleId, JSON.stringify(change), change.created)
    const history = new History(store)
    assert.equal(history.query({}).total, 1)
    assert.deepEqual(history.query({ summary: '1' }).items.map(item => item.id), ['edit'])
    assert.equal(history.query({ q: 'forced update' }).total, 0)
    assert.equal(history.query({ kind: 'modificationGroup' }).total, 0)
    assert(!history.query({}).vehicleOptions.some(item => item.id === 'modification-activation'))
    assert.equal(history.detail('activation').action, 'modification.enabled')
    const file = await history.export()
    try {
      const workbook = new ExcelJS.Workbook()
      await workbook.xlsx.readFile(file.path)
      const values = JSON.stringify(workbook.worksheets[0].getSheetValues())
      assert(!values.includes('modification.enabled'))
      assert(values.includes('modification.sharedUpdated'))
    } finally { await file.cleanup() }
  } finally { store.db.close(); await fs.rm(root, { recursive: true, force: true }) }
})
