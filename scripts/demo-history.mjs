import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { createApp } from '../dist-server/server/app.js'

// Synthetic acceptance data only: always allocate a fresh, isolated directory.
const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vehicle-history-acceptance-'))
const shared = path.join(root, 'shared')
await fs.mkdir(shared)
const client = createApp({ dataDir: path.join(root, 'local'), staticDir: path.join(project, 'dist') })
const server = client.app.listen(Number(process.env.HISTORY_DEMO_PORT || 0), '127.0.0.1')
await new Promise(resolve => server.once('listening', resolve))
const url = `http://127.0.0.1:${server.address().port}`
let cookie = '', workspaceToken = ''
async function request(route, body) {
  const response = await fetch(url + '/api' + route, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-App-Request': 'vehicle-manager', 'X-Workspace-Token': workspaceToken, Cookie: cookie }, body: JSON.stringify(body) })
  cookie = response.headers.get('set-cookie')?.split(';')[0] || cookie
  workspaceToken = response.headers.get('x-workspace-token') || workspaceToken
  const result = await response.json()
  if (!response.ok) throw new Error(`${route}: ${JSON.stringify(result)}`)
  return result
}
const username = 'history-demo', password = 'History-Demo-2026!'
await request('/register', { username, password, displayName: 'Demo Reviewer' })
await request('/setup/configure', { path: shared, mode: 'create', confirmed: true, teamName: 'Synthetic History Review' })
const team = client.store.db.prepare('SELECT id FROM workspaces').get()
const workspace = client.workspaces.get(team.id)
const actors = [
  { id: 'demo-alex-1', name: 'Alex Chen', deviceId: 'demo-device-alpha', role: 'admin' },
  { id: 'demo-jamie', name: 'Jamie Martin', deviceId: 'demo-device-beta', role: 'member' },
  { id: 'demo-alex-2', name: 'Alex Chen', deviceId: 'demo-device-gamma', role: 'member' },
]
const vehicles = []
for (let index = 0; index < 2; index++) {
  const actor = actors[0]
  const car = workspace.business.write({ kind: 'vehicle', data: { name: `DEMO Vehicle ${index + 1}`, model: index === 0 ? 'EMP2 Prototype' : '', vin: `TEST000000000000${index + 1}`, status: 'available', complianceLevel: 'Eu7' }, actor, reason: 'Register the vehicle for winter validation' })
  const part = workspace.business.write({ kind: 'part', vehicleId: car.id, data: { category: 'controller', name: 'VCU', serial: `CURRENT-SN-${index + 1}`, software: 'SW-1204' }, actor, reason: 'Synthetic controller installation' })
  const extra = workspace.business.write({ kind: 'equipment', vehicleId: car.id, data: { name: 'CAN logger', description: 'Winter validation data recorder' }, actor: actors[1], reason: 'Record CAN traffic during road testing' })
  const count = index === 0 ? 1205 : 150
  workspace.store.transaction(() => {
    const insert = workspace.store.db.prepare('INSERT INTO changes VALUES(?,?,?,?,?)')
    for (let n = 0; n < count; n++) {
      const before = { name: 'VCU', category: 'controller', serial: n === 0 ? 'LEGACY-SN-0007' : `CURRENT-SN-${index + 1}`, software: `SW-${n - 1}` }
      const after = { ...before, serial: `CURRENT-SN-${index + 1}`, software: `SW-${n}` }
      if (n === 1) before.notes = 'Historical field removed during service'
      const change = { id: randomUUID(), recordId: part.id, vehicleId: car.id, kind: 'part', before, after, archivedBefore: false, archivedAfter: false, actor: actors[n % actors.length], reason: `Align VCU software with winter test configuration (revision ${n + 1})`, action: 'updated', sourceId: null, created: new Date(Date.UTC(2026, 10, 4, 8) - (count - n) * 3600000).toISOString() }
      insert.run(change.id, part.id, car.id, JSON.stringify(change), change.created)
    }
  })
  vehicles.push({ id: car.id, name: car.data.name, model: car.data.model, vin: car.data.vin, equipmentId: extra.id, historyCount: count + 3 })
}
await fs.mkdir(path.join(project, 'releases'), { recursive: true })
const session = { url, username, password, root, vehicles, oldSerial: 'LEGACY-SN-0007', synthetic: true }
await fs.writeFile(path.join(project, 'releases', 'history-demo-session.json'), JSON.stringify(session, null, 2))
console.log(JSON.stringify(session, null, 2))
console.log('Synthetic preview is running. Press Ctrl+C to stop; generated data is retained for review.')
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { server.close(() => { void client.close().then(() => process.exit()) }) })
