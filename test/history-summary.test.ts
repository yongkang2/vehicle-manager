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
    const change = { id:'large', recordId:'r', vehicleId:'v', kind:'report', before:{name:'Old', content:'x'.repeat(100000)}, after:{name:'New', category:'DOVE', content:'y'.repeat(100000), checksum:'internal-hash', size:123, savedAt:'2026-11-06T00:00:00Z', parserVersion:'v2'}, actor:{id:'a',name:'Actor',role:'member',deviceId:'d'}, action:'updated',reason:'update',created:'2026-11-06T00:00:00Z',archivedBefore:false,archivedAfter:true }
    store.db.prepare('INSERT INTO changes VALUES(?,?,?,?,?)').run(change.id,change.recordId,change.vehicleId,JSON.stringify(change),change.created)
    const history = new History(store)
    const summary = history.query({summary:'1'})
    assert.equal(summary.items[0].before,null)
    assert.deepEqual(summary.items[0].after,{name:'New',category:'DOVE'})
    assert.equal(summary.items[0].changedFieldCount,4)
    assert.equal(summary.items[0].statusChanged,true)
    assert(!JSON.stringify(summary).includes('xxxxx'))
    assert(!('vehicleOptions' in summary))
    assert.deepEqual(history.detail('large').after,change.after)
    assert.deepEqual(history.options().vehicleOptions,[])
    assert.throws(()=>history.detail('missing'),/NOT_FOUND/)
  } finally {store.db.close();await rm(root,{recursive:true,force:true})}
})

test('vehicle options include only existing vehicles while all historical records remain searchable', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'vm-history-options-')), store = new LocalStore(root)
  try {
    const insert = store.db.prepare('INSERT INTO records VALUES(?,?,?,?,?,?,?,?)')
    insert.run('active', 'vehicle', null, 'VIN-A', JSON.stringify({model:'Current model',vin:'VIN-A'}), 0, 1, 'now')
    insert.run('archived', 'vehicle', null, 'VIN-B', JSON.stringify({vin:'VIN-B'}), 1, 1, 'now')
    insert.run('configuration', 'componentType', null, null, JSON.stringify({name:'Configuration'}), 0, 1, 'now')
    const add = (id: string, kind: string, vehicleId: string, after: object) => {
      const change = {id,recordId:id,vehicleId,kind,before:null,after,actor:{id:'a',name:'Tester',role:'admin',deviceId:'d'},reason:'Preserved audit',action:'created',created:'2026-11-06T00:00:00Z',archivedBefore:null,archivedAfter:false}
      store.db.prepare('INSERT INTO changes VALUES(?,?,?,?,?)').run(id,id,vehicleId,JSON.stringify(change),change.created)
    }
    add('deleted-change','vehicle','deleted',{model:'Removed model',vin:'OLD-VIN'})
    add('config-change','componentType','configuration',{name:'Configuration'})
    const history = new History(store)
    assert.deepEqual(history.options().vehicleOptions,[{id:'active',label:'Current model · VIN-A'},{id:'archived',label:'VIN-B'}])
    assert.equal(history.query({q:'Removed model',summary:'1'}).total,1)
    assert.equal(history.query({q:'Configuration',summary:'1'}).total,1)
    assert.equal(history.detail('deleted-change').vehicleLabel,'Removed model')
    store.rememberDeletions([{ id:'deletion',requestId:'request',vehicleId:'active',vin:'VIN-A',recordIds:['active'],fileKeys:[],actor:{id:'a',name:'Tester',role:'admin',deviceId:'d'},reason:'Synthetic canonical deletion',deletedAt:'2026-11-06T00:00:00Z',revision:'revision',sequence:1 }])
    assert.deepEqual(history.options().vehicleOptions,[{id:'archived',label:'VIN-B'}])
  } finally {store.db.close();await rm(root,{recursive:true,force:true})}
})
