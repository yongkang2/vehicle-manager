import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { LocalStore } from '../server/store.js'
import { History } from '../server/history.js'

// Run with npx tsx scripts/benchmark-history.ts. Baseline is the committed implementation.
const source = path.resolve('server/.history-benchmark-baseline.ts')
await writeFile(source, execFileSync('git', ['show', 'HEAD:server/history.ts']))
const Baseline = (await import(pathToFileURL(source).href)).History as typeof History
try {
  for (const count of [10000, 100000]) {
    const root = await mkdtemp(path.join(os.tmpdir(), 'vm-history-benchmark-'))
    const store = new LocalStore(root)
    try {
      const insert = store.db.prepare('INSERT INTO changes VALUES(?,?,?,?,?)')
      store.transaction(() => {
        const vehicle = store.db.prepare('INSERT INTO records VALUES(?,?,?,?,?,?,?,?)')
        for (let i=0;i<1000;i++) vehicle.run(`v${i}`,'vehicle',null,`VIN${i}`,JSON.stringify({model:`Model${i}`,vin:`VIN${i}`}),0,1,'2026-11-06T00:00:00Z')
        for (let i = 0; i < count; i++) {
          const change = {id:`c${i}`, recordId:`r${i}`,vehicleId:`v${i%1000}`,kind:i%2000===0?'report':'part',before:{softwareVersion:'v1'},after:{name:'Part',softwareVersion:`v${i%10}`,notes:i%2000===0?'DOVE '+ 'snapshot '.repeat(20000):'normal'},actor:{id:'a',name:'Actor',role:'member',deviceId:'d'},action:'updated',reason:'benchmark',created:'2026-11-06T00:00:00Z',archivedBefore:false,archivedAfter:false}
          insert.run(change.id,change.recordId,change.vehicleId,JSON.stringify(change),change.created)
        }
      })
      const indexes = store.db.prepare("SELECT name,sql FROM sqlite_master WHERE type='index' AND name LIKE 'changes_%'").all()
      for (const row of indexes) store.db.exec(`DROP INDEX ${row.name}`)
      for (const [version, history] of [['baseline', new Baseline(store)],['current',new History(store)]] as const) {
        if (version === 'current') {
          const start = performance.now()
          for (const row of indexes) store.db.exec(String(row.sql))
          console.log(JSON.stringify({count,version,query:'indexBuild',ms:Math.round(performance.now()-start)}))
        }
        for (const [query, filter] of Object.entries({page:{},vehicle:{vehicleId:'v0'},date:{date:'2026-11-06',offset:'0'},compound:{q:'Actor softwareVersion v1'},dove:{q:'DOVE'}})) {
          const start = performance.now()
          const result = history.query({...filter,...(version==='current'?{summary:'1'}:{})})
          console.log(JSON.stringify({count,version,query,ms:Math.round(performance.now()-start),total:result.total,bytes:Buffer.byteLength(JSON.stringify(result))}))
        }
        const exportStart = performance.now()
        const exported = await history.export({vehicleId:'v0'})
        try { console.log(JSON.stringify({count,version,query:'exportVehicle',ms:Math.round(performance.now()-exportStart)})) } finally {await exported.cleanup()}
      }
    } finally {store.db.close();await rm(root,{recursive:true,force:true})}
  }
} finally {await rm(source,{force:true})}
