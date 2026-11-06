import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { LocalStore } from '../server/store.js'
import { History } from '../server/history.js'

test('summary pages omit large snapshots and retain lazy detail and independent options', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'vm-history-summary-'))
  const store = new LocalStore(root)
  try {
    const change = { id:'large', recordId:'r', vehicleId:'v', kind:'report', before:{name:'Old', content:'x'.repeat(100000)}, after:{name:'New', category:'DOVE', content:'y'.repeat(100000)}, actor:{id:'a',name:'Actor',role:'member',deviceId:'d'}, action:'updated',reason:'update',created:'2026-11-06T00:00:00Z',archivedBefore:false,archivedAfter:true }
    store.db.prepare('INSERT INTO changes VALUES(?,?,?,?,?)').run(change.id,change.recordId,change.vehicleId,JSON.stringify(change),change.created)
    const history = new History(store)
    const summary = history.query({summary:'1'})
    assert.equal(summary.items[0].before,null)
    assert.deepEqual(summary.items[0].after,{name:'New',category:'DOVE'})
    assert.equal(summary.items[0].changedFieldCount,3)
    assert.equal(summary.items[0].statusChanged,true)
    assert(!JSON.stringify(summary).includes('xxxxx'))
    assert(!('vehicleOptions' in summary))
    assert.deepEqual(history.detail('large').after,change.after)
    assert.deepEqual(history.options().vehicleOptions,[{id:'v',label:'v'}])
    assert.throws(()=>history.detail('missing'),/NOT_FOUND/)
  } finally {store.db.close();await rm(root,{recursive:true,force:true})}
})
