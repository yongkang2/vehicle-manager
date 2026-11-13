// Disposable fixture only. Uses the exact isolated application, never a personal data directory.
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { once } from 'node:events'
import { randomUUID, randomBytes } from 'node:crypto'

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const root = path.join(repo, '.runtime/training-v1.9.1')
const appRoot = path.join(root, 'app')
const expected = '6f9354ac76e7999e9a115ad6aa95417366f01a0a'
const { version } = JSON.parse(await fs.readFile(path.join(appRoot, 'package.json'), 'utf8'))
if (version !== '1.9.1') throw Error('The fixture requires Vehicle Manager 1.9.1')
const { createApp } = await import(pathToFileURL(path.join(appRoot, 'dist-server/server/app.js')))
const { BrowserPresence, installBrowserPresence } = await import(pathToFileURL(path.join(appRoot, 'dist-server/server/browser-presence.js')))
const { defaultExportConfiguration } = await import(pathToFileURL(path.join(appRoot, 'dist-server/shared/csv-export.js')))
const demo = await fs.mkdtemp(path.join(root, 'demo-'))
const share = path.join(demo, 'synthetic-share')
await fs.mkdir(share)
const fixtureDir = path.join(root, 'fixtures')
await fs.mkdir(fixtureDir, { recursive: true })
for (const name of ['DOVE_demo_before.xlsx', 'DOVE_demo_after.xlsx']) await fs.copyFile(path.join(repo, 'vehicle-manager-training/production/fixtures', name), path.join(fixtureDir, name))
await fs.copyFile(path.join(appRoot, 'public/vehicle-manager.png'), path.join(fixtureDir, 'training-illustration.png'))
// A small valid PDF with fictional, English-readable contents; no external assets.
const pdfObjects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>']
const pdfText = 'BT /F1 24 Tf 50 720 Td (SYNTHETIC TRAINING DOCUMENT) Tj 0 -50 Td /F1 14 Tf (Vehicle Manager - Fictional equipment guide) Tj 0 -30 Td (No production vehicle or customer information.) Tj ET'
pdfObjects.push(`<< /Length ${Buffer.byteLength(pdfText)} >>\nstream\n${pdfText}\nendstream`)
let pdf = '%PDF-1.4\n', offsets = [0]
for (let i = 0; i < pdfObjects.length; i++) { offsets.push(Buffer.byteLength(pdf)); pdf += `${i + 1} 0 obj\n${pdfObjects[i]}\nendobj\n` }
const xref = Buffer.byteLength(pdf)
pdf += `xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
await fs.writeFile(path.join(fixtureDir, 'equipment-guide.pdf'), pdf)

const presence = new BrowserPresence({ onEmpty() {} }), presenceToken = randomBytes(32).toString('hex')
const client = createApp({ dataDir: path.join(demo, 'local'), staticDir: path.join(appRoot, 'dist'), browserPresence: presence, presenceToken })
const server = client.app.listen(14411, '127.0.0.1')
const dispose = installBrowserPresence(server, presence, { token: presenceToken })
if (!server.listening) await once(server, 'listening')
const base = 'http://127.0.0.1:14411'
const sessions = new Map()
async function request(route, method = 'GET', body, session = 'owner') {
  const credentials = sessions.get(session) || { cookie: '', token: '' }, form = body instanceof FormData
  const response = await fetch(`${base}/api${route}`, { method, headers: { Cookie: credentials.cookie, 'X-App-Request': 'vehicle-manager', 'X-Workspace-Token': credentials.token, ...(body !== undefined && !form ? { 'Content-Type': 'application/json' } : {}) }, body: body === undefined ? undefined : form ? body : JSON.stringify(body) })
  credentials.cookie = response.headers.get('set-cookie')?.split(';')[0] || credentials.cookie
  credentials.token = response.headers.get('x-workspace-token') || credentials.token
  sessions.set(session, credentials)
  const result = await response.json()
  if (!response.ok) throw Error(`${method} ${route}: ${response.status} ${JSON.stringify(result)}`)
  await client.synchronization.settle()
  return result
}
async function write(kind, data, vehicleId = null) { return request('/business/records', 'POST', { kind, data, vehicleId, reason: 'Prepare fictional member training data' }) }
async function upload(vehicleId, name) { const form = new FormData(); form.append('file', new Blob([await fs.readFile(path.join(fixtureDir, name))]), name); form.append('reason', 'Fictional training document'); return request(`/business/vehicles/${vehicleId}/attachments`, 'POST', form) }
try {
  await request('/register', 'POST', { username: 'training-owner', displayName: '离镜演示管理员', password: 'Fictional-Owner-2026!' })
  const configured = await request('/setup/configure', 'POST', { path: share, mode: 'create', teamName: '培训演示团队 · 全部为虚构数据', confirmed: true })
  await request('/business/sync', 'POST')
  await request('/business/configuration-revisions/enable', 'POST', { requestId: randomUUID(), reason: 'Only isolated, current fictional clients exist' })
  await request('/business/modifications/enable', 'POST', { requestId: randomUUID(), reason: 'Only isolated, current fictional clients exist' })
  const car = await write('vehicle', { name: '功能演示车 A02', vin: 'TEST0000000000002', model: '培训车型 B', project: 'DEMO', status: 'available', complianceLevel: 'Eu7', physicalLocation: '演示车间 A 区', owner: '演示成员', thermal: 'Indirect Heat Pump', notes: 'Fictional training vehicle; not a real vehicle.' })
  for (const name of ['VCU', 'MCU', 'BMS/MSB']) await write('part', { name, category: 'controller', controllerType: 'Open ECU', supplier: 'Demo supplier', productPart: `DEMO-${name.replace('/', '-')}-100`, serial: `TRAINING-${name}`, software: '3.2.1', calibrationVersion: '2.4', network: 'CAN UDS' }, car.id)
  await write('part', { name: 'HV Battery', category: 'battery', productPart: 'DEMO-BAT-82', serial: '00001234567890123456', maturity: 'Prototype', lifeStatus: 'BOL' }, car.id)
  await write('part', { name: '前电机', category: 'motor', position: 'Front', productPart: 'DEMO-EM-150', serial: 'TRAINING-EM-02' }, car.id)
  await write('part', { name: '演示压缩机', category: 'component', componentTypeId: 'thermal-management', productPart: 'DEMO-TH-01' }, car.id)
  await write('modification', { name: '冷却回路验证', description: '独立改装示例，不会修改其他车辆', installedAt: '2026-11-01' }, car.id)
  await upload(car.id, 'training-illustration.png')
  await upload(car.id, 'equipment-guide.pdf')
  await write('vehicle', { name: '耐久演示车 B03', vin: 'TEST0000000000003', model: '培训车型 C', project: 'DEMO', status: 'testing', complianceLevel: 'CN6', physicalLocation: '演示试验场' })
  await request('/business/sync', 'POST')
  await request('/register', 'POST', { username: 'training-member', displayName: '演示成员', password: 'Training-Member-2026!' }, 'member')
  await request('/setup/configure', 'POST', { path: share, mode: 'join', teamId: configured.teamId }, 'member')
  const team = await request('/team')
  const pending = team.requests.find(item => item.status === 'pending' && item.identity.displayName === '演示成员')
  if (!pending) throw Error('Fictional member request missing')
  await request(`/team/requests/${pending.id}/approve`, 'POST', { role: 'member', memberId: null, reason: 'Approve isolated fictional training member off camera' })
  const memberStatus = await request('/status', 'GET', undefined, 'member')
  if (memberStatus.member?.role !== 'member' || memberStatus.access !== 'approved') throw Error('Capture account is not an approved ordinary member')
  const configuration = defaultExportConfiguration('zh')
  configuration.filters.search = '功能演示车 A02'
  configuration.columns = { equipment: ['name', 'equipmentType'] }
  await request('/business/export-templates', 'POST', { name: '培训设备清单', configuration }, 'member')
  await request('/logout', 'POST', undefined, 'member')
  await request('/logout', 'POST')
  const state = { appVersion: version, sourceCommit: expected, base, demo, share, fixtureDir, preparedVehicle: { id: car.id, vin: car.data.vin, name: car.data.name }, account: { username: 'training-member', password: 'Training-Member-2026!' }, role: 'member', approved: true, ownerOnlyPreparation: ['approval', 'configurationActivation', 'enhancedModificationsActivation'], startedAt: new Date().toISOString() }
  await fs.writeFile(path.join(root, 'demo-state.json'), JSON.stringify(state, null, 2))
  console.log(JSON.stringify({ ready: true, base, role: 'member', version, state: path.join(root, 'demo-state.json') }))
  let stopping = false
  async function stop() { if (stopping) return; stopping = true; presence.stop(); dispose(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await client.close(); await fs.writeFile(path.join(root, 'demo-stopped.json'), JSON.stringify({ stoppedAt: new Date().toISOString(), demo })); process.exit(0) }
  process.once('SIGINT', () => void stop()); process.once('SIGTERM', () => void stop())
  const stopper = setInterval(async () => { try { await fs.access(path.join(root, 'stop-demo')); clearInterval(stopper); await stop() } catch {} }, 1000)
} catch (cause) { presence.stop(); dispose(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await client.close(); throw cause }
