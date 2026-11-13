// Read-only cross-check of the synthetic equipment export and its parent vehicles.
import fs from 'node:fs/promises'
import path from 'node:path'
import {fileURLToPath} from 'node:url'
import {createHash} from 'node:crypto'
import {TrainingCDP} from './cdp-training.mjs'
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../../../.runtime/training-v1.9.1')
const filename=path.join(root,'capture/capture.json')
const doc=JSON.parse(await fs.readFile(filename,'utf8')), c=await TrainingCDP.connect()
try {
  const status=await c.eval("fetch('/api/status').then(r=>r.json())")
  if(status.access!=='approved'||status.member?.role!=='member')throw Error('Evidence must use an approved member')
  const records=await c.eval("fetch('/api/status').then(r=>r.json()).then(s=>fetch('/api/business/records',{headers:{'X-Workspace-Token':s.workspaceToken}})).then(r=>r.json())")
  const vehicles=new Map(records.filter(r=>r.kind==='vehicle').map(r=>[r.id,r]))
  const associations=records.filter(r=>r.kind==='equipment').map(r=>({equipmentId:r.id,name:r.data.name,equipmentType:r.data.equipmentType,vehicleId:r.vehicleId,vin:vehicles.get(r.vehicleId)?.data.vin}))
  const bytes=Buffer.from(JSON.stringify({sourceCommit:doc.sourceCommit,version:doc.version,role:'member',associations},null,2))
  const dest=path.join(root,'downloads/equipment-associations.json')
  await fs.writeFile(dest,bytes)
  doc.csvEvidence.associationsPath=dest
  doc.csvEvidence.associationsSha256=createHash('sha256').update(bytes).digest('hex')
  await fs.writeFile(filename,JSON.stringify(doc,null,2))
  console.log(JSON.stringify({approvedMember:true,equipment:associations.length,vin:doc.csvEvidence.vin}))
} finally {c.close()}
