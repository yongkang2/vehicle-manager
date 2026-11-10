import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { LocalStore } from '../server/store.js'
import { History } from '../server/history.js'

test('history pagination avoids temporary sorting and upgrades legacy indexes without touching history', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'vm-history-order-'))
  let store = new LocalStore(root)
  try {
    const add = store.db.prepare('INSERT INTO changes VALUES(?,?,?,?,?)')
    for (let i = 0; i < 101; i++) {
      const change = { id: `c${i}`, recordId: 'r', vehicleId: 'v', kind: 'part', before: null, after: { name: 'Part' }, actor: { id: 'a', name: 'Actor', role: 'member', deviceId: 'd' }, action: 'created', reason: 'test', created: '2026-11-10T00:00:00Z', archivedBefore: null, archivedAfter: false }
      add.run(change.id, 'r', 'v', JSON.stringify(change), change.created)
    }
    store.db.exec('DROP INDEX changes_created; CREATE INDEX changes_created ON changes(created DESC)')
    store.db.close(); store = new LocalStore(root)
    for (const [where, values] of [['', []], ['WHERE vehicle_id=?', ['v']], ["WHERE vehicle_id=? AND json_extract(payload,'$.kind')=?", ['v', 'part']]] as const) {
      const plan = store.db.prepare(`EXPLAIN QUERY PLAN SELECT payload FROM changes ${where} ORDER BY created DESC,rowid DESC LIMIT 50 OFFSET 50`).all(...values)
      assert(!plan.some(row => /TEMP B-TREE/.test(String(row.detail))), JSON.stringify(plan))
    }
    const history = new History(store)
    assert.equal(history.query({ summary: '1' }).total, 101)
    assert.deepEqual(history.query({ summary: '1', page: '2' }).items.map(row => row.id), Array.from({ length: 50 }, (_, i) => `c${50 - i}`))
    assert.equal(store.db.prepare('PRAGMA integrity_check').get()!.integrity_check, 'ok')
    assert.equal(store.db.prepare('PRAGMA user_version').get()!.user_version, 6)
  } finally { store.db.close(); await rm(root, { recursive: true, force: true }) }
})


test('local history revision tracks committed inserts, edits and deletes and survives reopen', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'vm-history-revision-'))
  let store = new LocalStore(root)
  try {
    assert.equal(store.get('historyRevision'), null)
    const start = store.get<number>('historyRevision') || 0
    store.db.prepare('INSERT INTO changes VALUES(?,?,?,?,?)').run('change', 'record', 'vehicle', '{}', '2026-11-10')
    assert.equal(store.get('historyRevision'), start + 1)
    store.db.prepare('UPDATE changes SET payload=? WHERE id=?').run('{"reason":"updated"}', 'change')
    assert.equal(store.get('historyRevision'), start + 2)
    assert.throws(() => store.transaction(() => { store.db.prepare('DELETE FROM changes').run(); throw new Error('Rollback fixture') }))
    assert.equal(store.get('historyRevision'), start + 2)
    assert.equal(store.db.prepare('SELECT count(*) AS total FROM changes').get()!.total, 1)
    store.db.close(); store = new LocalStore(root)
    assert.equal(store.get('historyRevision'), start + 2)
    store.db.prepare('DELETE FROM changes').run()
    assert.equal(store.get('historyRevision'), start + 3)
    const imported = store.db.prepare('INSERT OR IGNORE INTO changes VALUES(?,?,?,?,?)')
    for (const id of ['import-a', 'import-b', 'import-b']) imported.run(id, 'record', 'vehicle', '{}', '2026-11-10')
    assert.equal(store.get('historyRevision'), start + 5, 'Only newly imported audit rows advance the revision')
  } finally { store.db.close(); await rm(root, { recursive: true, force: true }) }
})
