// Local review only: every run owns a fresh temporary database and shared folder.
import { once } from 'node:events'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomBytes, randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import ExcelJS from 'exceljs'
import * as XLSX from 'xlsx'
import { createApp } from '../dist-server/server/app.js'
import { BrowserPresence, installBrowserPresence } from '../dist-server/server/browser-presence.js'
import { localReminderDay } from '../dist-server/shared/backup-reminder.js'
import { configurationDecisionKey } from '../dist-server/shared/configuration-revisions.js'

const project = fileURLToPath(new URL('..', import.meta.url))
await fs.access(path.join(project, 'dist', 'index.html'))
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vehicle-manager-ui-preview-'))
const shared = path.join(root, 'synthetic-team')
await fs.mkdir(shared)
// Keep the presence channel, but omit automatic idle shutdown for a review server.
const browserPresence = new BrowserPresence({ onEmpty() {} }), presenceToken = randomBytes(32).toString('hex')
const client = createApp({ dataDir: path.join(root, 'local'), staticDir: path.join(project, 'dist'), browserPresence, presenceToken })
const port = Number(process.env.VEHICLE_MANAGER_PREVIEW_PORT || 4426)
if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid VEHICLE_MANAGER_PREVIEW_PORT')
const server = client.app.listen(port, '127.0.0.1')
const disposePresence = installBrowserPresence(server, browserPresence, { token: presenceToken })
let cookie = '', workspaceToken = '', baseUrl = ''
async function request(route, method = 'GET', body) {
  const form = body instanceof FormData
  const response = await fetch(`${baseUrl}/api${route}`, {
    method, headers: { Cookie: cookie, 'X-Workspace-Token': workspaceToken, 'X-App-Request': 'vehicle-manager', ...(body && !form ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? form ? body : JSON.stringify(body) : undefined,
  })
  cookie = response.headers.get('set-cookie')?.split(';')[0] || cookie
  workspaceToken = response.headers.get('x-workspace-token') || workspaceToken
  const data = await response.json()
  if (!response.ok) throw new Error(`${method} ${route}: ${response.status} ${JSON.stringify(data)}`)
  return data
}
const write = (kind, data, vehicleId) => request('/business/records', 'POST', { kind, vehicleId, data, reason: 'Synthetic UI review data' })
function upload(bytes, filename) {
  const form = new FormData()
  form.append('file', new Blob([bytes]), filename)
  return form
}
async function stop() { browserPresence.stop(); disposePresence(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await client.close() }
try {
  if (!server.listening) await once(server, 'listening')
  baseUrl = `http://127.0.0.1:${server.address().port}`
  await request('/register', 'POST', { username: 'preview', displayName: 'Design Review / 界面验收', password: 'Preview-2026!' })
  await request('/setup/configure', 'POST', { path: shared, mode: 'create', teamName: 'UI PREVIEW · 模拟数据', confirmed: true })
  await request('/business/backup/reminder/dismiss', 'POST', { day: localReminderDay() })
  await request('/business/sync', 'POST')
  await request('/business/configuration-revisions/enable', 'POST', { requestId: randomUUID(), reason: 'All clients belong to this isolated synthetic preview' })
  const vehicles = []
  const statuses = ['available', 'testing', 'maintenance', 'inactive']
  for (let i = 0; i < 12; i++) {
    const car = await write('vehicle', {
      name: ['Atlas · 热管理验证', 'Orion · 标定试验', 'Vega · 耐久测试', 'Nova · 集成验证'][i % 4] + ` ${String(i + 1).padStart(2, '0')}`,
      vin: `TEST${String(i + 1).padStart(13, '0')}`, project: ['eP64', 'STLA Medium', 'STLA Large'][i % 3],
      model: ['Prototype A', 'Prototype B', 'Prototype C'][i % 3], color: ['Silver', 'White', 'Blue'][i % 3],
      status: statuses[i % 4], physicalLocation: ['Lab A / 试验室', 'Track B / 试车场', 'Workshop / 车间'][i % 3],
      owner: ['Alex Chen', 'Morgan Li', 'Sam Wang'][i % 3], plate: `DEMO-${String(i + 1).padStart(3, '0')}`,
      plateExpiry: '2027-06-30', thermal: ['Indirect Heat Pump', 'Direct Heat Pump', 'No Heat Pump'][i % 3],
      complianceLevel: ['Eu7', 'CN6', 'Eu6'][i % 3], notes: 'Fictional review vehicle. 仅用于界面验收，无真实业务数据。',
    })
    vehicles.push(car)
    if (i >= 4) continue
    await write('part', { name: 'VCU', category: 'controller', controllerType: 'Open ECU', supplier: 'Demo supplier', software: '3.2.1', serial: `VCU-${i + 1}`, productPart: 'DEMO-PN-100', calibrationVersion: '2.4', network: 'CAN UDS' }, car.id)
    await write('part', { name: 'HV Battery', category: 'battery', productPart: 'DEMO-BAT-82', serial: `BAT-${i + 1}`, maturity: 'Prototype', lifeStatus: 'BOL', installedAt: '2026-10-01' }, car.id)
    await write('part', { name: 'Front eMotor', category: 'motor', position: 'Front', productPart: 'DEMO-EM-150', serial: `EM-${i + 1}`, maturity: 'Prototype', notes: 'Synthetic drive unit' }, car.id)
    await write('part', { name: 'Compressor / 压缩机', category: 'component', componentTypeId: 'thermal-management', productPart: 'DEMO-TH-01', notes: 'Synthetic thermal configuration' }, car.id)
    await write('equipment', { name: 'INCA Logger / 数据采集', equipmentType: 'ETAS tools', installedAt: '2026-10-12', description: 'Thermal and CAN measurement / 热管理与 CAN 测量' }, car.id)
    await write('equipment', { name: 'Charging adaptor / 充电适配器', equipmentType: 'Charging Adaptors', description: 'Workshop validation kit / 车间验证套件' }, car.id)
    await write('modification', { name: 'Cooling circuit validation / 冷却回路验证', description: 'Prototype hose routing and sensor calibration', installedAt: '2026-10-15', notes: 'Independent sample modification' }, car.id)
    const book = new ExcelJS.Workbook()
    book.addWorksheet('DOVE').addRows([['Vin :', car.data.vin], ['Date of record', '2026-11-10'], ['Value SOC', '76']])
    const identification = book.addWorksheet('Identification')
    identification.addRow(['ECU', 'Description', 'Network', 'Supplier'])
    identification.addRow(['EVCU', 'Vehicle control', 'CAN UDS', 'Demo supplier', 'FN-01', 'DEMO-PN-100', '3.2.2', '', 'CAL-01', '2.4', '', '', '', `VCU-${i + 1}`])
    book.addWorksheet('Defauts').addRow(['EVCU', '', 'CAN UDS', 'P123456 (2Fh - Permanent) Synthetic diagnostic fault'])
    const workbookBytes = await book.xlsx.writeBuffer()
    const draft = await request('/business/dove/preview', 'POST', upload(workbookBytes, `demo-scan-${i + 1}.xlsx`))
    await request('/business/dove/save', 'POST', { draftId: draft.id, confirmation: { confirmed: true, reportOnly: true } })
    await request(`/business/vehicles/${car.id}/attachments`, 'POST', (() => {
      const form = upload(workbookBytes, 'validation-scan.xlsx')
      form.append('reason', 'Synthetic review attachment')
      return form
    })())
  }
  await request('/business/sync', 'POST')
  for (const car of vehicles.slice(0, 2)) {
    const preview = await request(`/business/vehicles/${car.id}/configuration-revisions/preview`, 'POST', {})
    const decisions = { fields: {}, sections: {} }
    for (const section of preview.sections) {
      if (!section.components.length) decisions.sections[section.typeId] = { state: 'notInstalled', reason: 'Not installed in this synthetic configuration' }
      for (const component of section.components) for (const field of component.fields) if (field.required && !field.value.trim()) decisions.fields[configurationDecisionKey(component.id, field.id)] = { state: 'unknown', reason: 'Synthetic sample value pending' }
    }
    await request(`/business/vehicles/${car.id}/configuration-revisions`, 'POST', { previewToken: preview.token, requestId: randomUUID(), title: 'Baseline validation / 基线验证', summary: 'Synthetic reviewed configuration', decisions })
  }
  const imageBytes = await fs.readFile(path.join(project, 'scripts/fixtures/preview.png'))
  const jpegBytes = await fs.readFile(path.join(project, 'scripts/fixtures/preview.jpg'))
  const demoBook = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(demoBook, XLSX.utils.aoa_to_sheet([['Synthetic equipment / 模拟设备', 'Status', 'Quantity'], ['Charging adapter', 'Available', 2], ['CAN logger', 'Testing', 1]]), 'Equipment')
  XLSX.utils.book_append_sheet(demoBook, XLSX.utils.aoa_to_sheet([['Notes'], ['Fictional review data only']]), 'Notes')
  const xlsBytes = XLSX.write(demoBook, { type: 'buffer', bookType: 'biff8' })
  const xlsxBytes = XLSX.write(demoBook, { type: 'buffer', bookType: 'xlsx' })
  const pdfBytes = Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 300 180]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj\n4 0 obj<</Length 52>>stream\nBT /F1 18 Tf 30 120 Td (Synthetic PDF preview) Tj ET\nendstream endobj\n5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF')
  for (const [filename, bytes] of [['demo-workbook.xlsx', xlsxBytes], ['demo.xls', xlsBytes], ['demo.pdf', pdfBytes], ['demo.png', imageBytes], ['demo.jpg', jpegBytes], ['demo.jpeg', jpegBytes], ['demo.jfif', jpegBytes]]) {
    const form = upload(bytes, filename); form.append('reason', 'Synthetic preview format coverage')
    await request(`/business/vehicles/${vehicles[0].id}/attachments`, 'POST', form)
  }
  const records = await request('/business/records')
  const counts = Object.fromEntries([...new Set(records.map(record => record.kind))].map(kind => [kind, records.filter(record => record.kind === kind).length]))
  if (counts.vehicle !== 12 || counts.report !== 4 || counts.equipment !== 8 || counts.attachment !== 11 || counts.part !== 16 || counts.modification !== 4) throw new Error(`Unexpected preview data: ${JSON.stringify(counts)}`)
  console.log(JSON.stringify({ url: baseUrl, username: 'preview', password: 'Preview-2026!', dataRoot: root, counts }, null, 2))
  process.once('SIGINT', () => { void stop() })
  process.once('SIGTERM', () => { void stop() })
} catch (error) {
  await stop()
  throw error
}
