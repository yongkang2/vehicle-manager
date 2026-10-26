import { test } from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import ExcelJS from 'exceljs'
import unzipper from 'unzipper'
import { createApp } from '../server/app.js'
import type { BusinessRecord } from '../shared/business.js'

test('full approved workflow: vehicles, parts, DOVE, configuration, exact files, backup and restore', async () => {
  const root = await fs.mkdtemp(path.join(import.meta.dirname, 'test-data-')), shared = path.join(root, 'shared')
  await fs.mkdir(shared)
  const clients = ['admin', 'member'].map(name => {
    const client = createApp({ dataDir: path.join(root, name) })
    return { ...client, server: client.app.listen(0, '127.0.0.1'), cookie: '', workspaceToken: '' }
  })
  for (const client of clients) if (!client.server.listening) await new Promise(resolve => client.server.once('listening', resolve))
  async function request(client: typeof clients[number], url: string, method = 'GET', body?: unknown) {
    const port = (client.server.address() as { port: number }).port, form = body instanceof FormData
    const response = await fetch(`http://127.0.0.1:${port}/api${url}`, { method, headers: { Cookie: client.cookie, 'X-Workspace-Token': client.workspaceToken, 'X-App-Request': 'vehicle-manager', ...(body && !form ? { 'Content-Type': 'application/json' } : {}) }, body: body ? form ? body : JSON.stringify(body) : undefined })
    client.workspaceToken = response.headers.get('x-workspace-token') || client.workspaceToken
    const cookie = response.headers.get('set-cookie'); if (cookie) client.cookie = cookie.split(';')[0]
    const binary = !response.headers.get('content-type')?.includes('json')
    return { status: response.status, data: binary ? Buffer.from(await response.arrayBuffer()) : await response.json() }
  }
  async function workbook(software: string, vin = 'TEST0000000000001') {
    const book = new ExcelJS.Workbook()
    book.addWorksheet('DOVE').addRows([['Vin :', vin], ['Date of record', '2026-10-21'], ['Value SOC', '70']])
    const identification = book.addWorksheet('Identification')
    identification.addRow(['ECU', 'Description', 'Network', 'Supplier'])
    identification.addRow(['EVCU', 'Control', 'CAN UDS', 'Supplier', 'FN', 'PN', software, '', 'CAL', '2', '', '', '', '000123'])
    book.addWorksheet('Defauts').addRow(['EVCU', '', 'CAN UDS', 'P123456 (2Fh - Permanent) Fault'])
    return Buffer.from(await book.xlsx.writeBuffer())
  }
  function upload(bytes: Buffer, name: string) { const form = new FormData(); form.append('file', new Blob([new Uint8Array(bytes)]), name); return form }
  try {
    const [admin, member] = clients
    for (const [index, client] of clients.entries()) assert.equal((await request(client, '/register', 'POST', { username: `user${index}`, displayName: `Person ${index}`, password: 'workflow-test-password' })).status, 201)
    const created = await request(admin, '/setup/configure', 'POST', { path: shared, mode: 'create', teamName: 'Workflow', confirmed: true })
    assert.equal(created.status, 200)
    const check = (await request(member, '/setup/check', 'POST', { path: shared })).data
    await request(member, '/setup/configure', 'POST', { path: shared, mode: 'join', teamId: check.teamId })
    assert.equal((await request(member, '/business/records')).status, 403)
    const team = (await request(admin, '/team')).data
    assert.equal((await request(admin, `/team/requests/${team.requests[0].id}/approve`, 'POST', { role: 'member', memberId: null, reason: 'Verified' })).status, 200)
    let response = await request(admin, '/business/records', 'POST', { kind: 'vehicle', data: { vin: 'TEST0000000000001', status: 'available', complianceLevel: 'Eu7', project: 'eP64' }, reason: 'Register without a nickname' })
    assert.equal(response.status, 201); const car = response.data as BusinessRecord
    assert.equal(car.data.name, '')
    const firstSync = await request(admin, '/business/sync', 'POST')
    assert.equal(firstSync.data.phase, 'ready', JSON.stringify(firstSync.data))
    assert.equal((await request(member, '/business/records')).data.length, 1)
    response = await request(member, '/business/records', 'POST', { kind: 'part', vehicleId: car.id, data: { name: 'EVCU', category: 'controller', controllerType: 'Open ECU', software: '1.0', serial: '000123' }, reason: 'Install controller' })
    assert.equal(response.status, 201); const part = response.data as BusinessRecord
    assert.equal((await request(member, `/business/records/${car.id}/archive`, 'POST', { archived: true, version: car.version, reason: 'Not permitted' })).status, 403)
    const bytes = await workbook('2.0')
    response = await request(member, '/business/dove/preview', 'POST', upload(bytes, 'scan.xlsx'))
    assert.equal(response.status, 200); assert.equal(response.data.match, 'matched')
    const report = (await request(member, '/business/dove/save', 'POST', { draftId: response.data.id, confirmation: { confirmed: true } })).data as BusinessRecord
    assert.equal(report.kind, 'report')
    assert.deepEqual((await request(member, `/business/files/${report.id}`)).data, bytes)
    const beforeUpdate = (await request(member, '/business/records')).data.find((record: BusinessRecord) => record.id === part.id) as BusinessRecord
    assert.equal(beforeUpdate.data.software, '2.0')
    assert.equal(beforeUpdate.data.description, 'Control')
    assert.equal((await request(member, '/business/records', 'POST', { kind: 'part', vehicleId: car.id, data: { name: 'VCU', category: 'controller', controllerType: 'Open ECU', position: 'rear' }, reason: 'Duplicate must be rejected' })).status, 409)
    response = await request(member, `/business/reports/${report.id}/configuration`, 'POST', { reportVersion: report.version, reason: 'Verified current software', selections: [{ controllerIndex: 0, partId: part.id, version: beforeUpdate.version, fields: ['software'] }] })
    assert.equal(response.status, 200); assert.equal(response.data[0].data.software, '2.0')
    assert.equal(response.data[0].data.name, 'VCU')
    assert.equal(response.data[0].data.sourceName, 'EVCU')
    assert.equal(response.data[0].data.reportId, report.id)
    const controllerBeforeEdit = response.data[0] as BusinessRecord
    const manualData = { ...controllerBeforeEdit.data, supplier: 'Manual supplier', productPart: 'PN-MANUAL', calibrationPart: 'CAL-MANUAL', calibrationVersion: '2.50', serial: '000789', description: 'Manually verified controller' }
    response = await request(member, `/business/records/${part.id}`, 'PUT', { data: manualData, version: controllerBeforeEdit.version, reason: 'Manual controller correction' })
    assert.equal(response.status, 200)
    assert.equal(response.data.data.name, 'VCU')
    assert.equal(response.data.data.productPart, 'PN-MANUAL')
    assert.equal(response.data.data.serial, '000789')
    assert.equal(response.data.data.software, '2.0')
    assert.equal(response.data.data.reportId, report.id)
    assert.equal((await request(member, `/business/records/${part.id}`, 'PUT', { data: manualData, version: controllerBeforeEdit.version, reason: 'Stale correction' })).status, 409)
    assert.ok((await request(member, '/business/history')).data.some((change: { recordId: string; reason: string; sourceId: string | null }) => change.recordId === part.id && change.reason === 'Manual controller correction' && change.sourceId === null))
    const keyBook = new ExcelJS.Workbook()
    keyBook.addWorksheet('DOVE').addRows([['Vin :', car.data.vin], ['Date of record', '2026-10-22']])
    const keySheet = keyBook.addWorksheet('Identification')
    keySheet.addRow(['ECU', 'Description', 'Network', 'Supplier'])
    keySheet.addRow(['MSB', 'Battery control', 'CAN UDS', 'CATL', 'FN', 'PN', '1.0', '', 'CAL', '0.00', '21/06/26', '', '29/03/26', '000456'])
    keySheet.addRow(['BMS', 'Battery control', 'CAN UDS', 'CATL', 'FN', 'PN', 'invalide', '', 'CAL', '0.00', '', '', '', '000456'])
    keyBook.addWorksheet('Defauts')
    const keyBytes = Buffer.from(await keyBook.xlsx.writeBuffer())
    const keyDraft = (await request(member, '/business/dove/preview', 'POST', upload(keyBytes, 'battery.xlsx'))).data
    const keyReport = (await request(member, '/business/dove/save', 'POST', { draftId: keyDraft.id, confirmation: { confirmed: true, reportOnly: true } })).data as BusinessRecord
    const keyPayload = { reportVersion: keyReport.version, reason: 'Confirm battery controller', selections: [{ controllerIndex: 0, partId: null, fields: ['software', 'serial', 'flashingDate'] }] }
    response = await request(member, `/business/reports/${keyReport.id}/configuration`, 'POST', keyPayload)
    assert.equal(response.status, 200); const battery = response.data[0] as BusinessRecord
    assert.equal(battery.data.name, 'BMS/MSB'); assert.equal(battery.data.serial, '000456'); assert.equal(battery.data.flashingDate, '21/06/26')
    assert.equal((await request(member, `/business/reports/${keyReport.id}/configuration`, 'POST', keyPayload)).status, 409)
    response = await request(member, `/business/reports/${keyReport.id}/configuration`, 'POST', { ...keyPayload, selections: [{ controllerIndex: 1, partId: battery.id, version: battery.version, fields: ['software'] }] })
    assert.equal(response.status, 409)
    response = await request(member, `/business/reports/${keyReport.id}/configuration`, 'POST', { ...keyPayload, selections: [{ controllerIndex: 1, partId: battery.id, version: battery.version, fields: ['serial'] }] })
    assert.equal(response.status, 200); assert.equal(response.data[0].data.software, '1.0'); assert.equal(response.data[0].data.sourceName, 'BMS')
    assert.equal((await request(member, `/business/reports/${report.id}/configuration`, 'POST', { reportVersion: report.version, reason: 'Wrong controller', selections: [{ controllerIndex: 0, partId: battery.id, version: 2, fields: ['software'] }] })).status, 409)
    const latestVcu = (await request(member, '/business/records')).data.find((record: BusinessRecord) => record.id === part.id) as BusinessRecord
    const newerVcu = (await request(member, `/business/records/${part.id}`, 'PUT', { data: { ...latestVcu.data, reportRecordedAt: '2026-10-23 18h34' }, version: latestVcu.version, reason: 'Newer observed configuration' })).data as BusinessRecord
    const olderPayload = { reportVersion: report.version, reason: 'Review older source', selections: [{ controllerIndex: 0, partId: part.id, version: newerVcu.version, fields: ['software'] }] }
    response = await request(member, `/business/reports/${report.id}/configuration`, 'POST', olderPayload)
    assert.equal(response.status, 409); assert.equal(response.data.error, 'OLDER_REPORT_CONFIRMATION_REQUIRED')
    assert.equal((await request(member, `/business/reports/${report.id}/configuration`, 'POST', { ...olderPayload, allowOlder: true })).status, 200)
    const draft = (await request(member, '/business/dove/preview', 'POST', upload(await workbook('3.0'), 'scan2.xlsx'))).data
    const second = (await request(member, '/business/dove/save', 'POST', { draftId: draft.id, confirmation: { confirmed: true } })).data as BusinessRecord
    response = await request(member, `/business/reports/compare?left=${report.id}&right=${second.id}`)
    assert.equal(response.status, 200); assert.equal(response.data.controllers[0].status, 'changed')
    const unmatched = (await request(member, '/business/dove/preview', 'POST', upload(await workbook('4.0', 'TEST0000000000002'), 'unmatched.xlsx'))).data
    assert.equal(unmatched.match, 'unmatched')
    assert.equal((await request(member, '/business/dove/save', 'POST', { draftId: unmatched.id })).status, 409)
    const duplicate = (await request(member, '/business/dove/preview', 'POST', upload(bytes, 'same.xlsx'))).data
    assert.equal(duplicate.existingId, report.id)
    await request(member, '/business/sync', 'POST')
    const pulled = (await request(admin, '/business/records')).data as BusinessRecord[]
    assert.equal(pulled.filter(record => record.kind === 'report').length, 3)
    assert.equal((await request(member, '/business/backup')).status, 403)
    assert.equal((await request(member, '/business/audit')).status, 403)
    assert.ok((await request(admin, '/business/audit')).data.some((event: { action: string }) => event.action === 'account.login' || event.action === 'account.registered'))
    const backup = await request(admin, '/business/backup'); assert.equal(backup.status, 200)
    const archive = await unzipper.Open.buffer(backup.data as Buffer)
    const manifest = JSON.parse((await archive.files.find(file => file.path === 'manifest.json')!.buffer()).toString())
    assert.equal(manifest.records.filter((record: BusinessRecord) => record.kind === 'report').length, 3)
    assert.equal(manifest.accounts, undefined); assert.equal(manifest.sessions, undefined)
    assert.equal(manifest.team.id, team.id)
    const current = pulled.find(record => record.id === car.id)!
    assert.equal((await request(admin, `/business/records/${car.id}`, 'PUT', { data: { ...current.data, owner: 'Changed after backup' }, version: current.version, reason: 'Change owner' })).status, 200)
    await request(admin, '/business/sync', 'POST')
    const restore = upload(backup.data as Buffer, 'backup.zip'); restore.append('confirmation', 'RESTORE'); restore.append('reason', 'Restore verified backup')
    response = await request(admin, '/business/restore', 'POST', restore)
    assert.equal(response.status, 200); assert.ok(response.data.changed > 0)
    await request(admin, '/business/sync', 'POST')
    const restored = (await request(member, '/business/records')).data as BusinessRecord[]
    assert.equal(restored.find(record => record.id === car.id)!.data.owner, '')
    assert.equal(restored.find(record => record.id === car.id)!.data.name, '')
    assert.deepEqual((await request(member, `/business/files/${report.id}`)).data, bytes)
    assert.ok((await request(member, `/business/history?vehicleId=${car.id}`)).data.some((change: { sourceId: string }) => change.sourceId === report.id))
    const currentReport = (await request(admin, '/business/records')).data.find((record: BusinessRecord) => record.id === report.id) as BusinessRecord
    assert.equal((await request(admin, `/business/records/${report.id}/archive`, 'POST', { version: currentReport.version, archived: true, reason: 'Archive retained report' })).status, 200)
    await request(admin, '/business/sync', 'POST')
    assert.equal((await request(member, '/business/records')).data.find((record: BusinessRecord) => record.id === report.id).archived, true)
    const archivedReport = (await request(admin, '/business/records')).data.find((record: BusinessRecord) => record.id === report.id) as BusinessRecord
    assert.equal((await request(admin, `/business/records/${report.id}/archive`, 'POST', { version: archivedReport.version, archived: false, reason: 'Restore retained report' })).status, 200)
    await request(admin, '/business/sync', 'POST')
    assert.equal((await request(member, '/business/records')).data.find((record: BusinessRecord) => record.id === report.id).archived, false)
    const restoredCar = (await request(admin, '/business/records')).data.find((record: BusinessRecord) => record.id === car.id) as BusinessRecord
    assert.equal((await request(admin, `/business/records/${car.id}/archive`, 'POST', { version: restoredCar.version, archived: true, reason: 'Archive for backup test' })).status, 200)
    await request(admin, '/business/sync', 'POST')
    const archivedBackup = await request(admin, '/business/backup'); assert.equal(archivedBackup.status, 200)
    const archivedCar = (await request(admin, '/business/records')).data.find((record: BusinessRecord) => record.id === car.id) as BusinessRecord
    assert.equal((await request(admin, `/business/records/${car.id}/archive`, 'POST', { version: archivedCar.version, archived: false, reason: 'Restore temporarily' })).status, 200)
    await request(admin, '/business/sync', 'POST')
    const restoreArchived = upload(archivedBackup.data, 'archived.zip'); restoreArchived.append('confirmation', 'RESTORE'); restoreArchived.append('reason', 'Restore archived vehicle and retained child records')
    assert.equal((await request(admin, '/business/restore', 'POST', restoreArchived)).status, 200)
    const finalSync = await request(admin, '/business/sync', 'POST')
    assert.equal(finalSync.data.pending, 0, JSON.stringify(finalSync.data))
    assert.equal((await request(member, '/business/records')).data.find((record: BusinessRecord) => record.id === car.id).archived, true)
    await fs.rename(shared, `${shared}-offline`)
    assert.equal((await request(admin, `/business/records/${car.id}/archive`, 'POST', { archived: true, version: current.version, reason: 'Offline admin operation' })).status, 503)
    await fs.rename(`${shared}-offline`, shared)
  } finally {
    for (const client of clients) { await new Promise<void>(resolve => client.server.close(() => resolve())); await client.synchronization.settle(); client.store.db.close() }
    await fs.rm(root, { recursive: true, force: true })
  }
})
