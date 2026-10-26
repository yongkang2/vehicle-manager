import { test } from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import ExcelJS from 'exceljs'
import { ZipArchive } from 'archiver'
import unzipper from 'unzipper'
import { Business } from '../server/business.js'
import { LocalStore } from '../server/store.js'
import { TeamDirectory } from '../server/team.js'
import { BusinessSync } from '../server/sync.js'
import { DoveService } from '../server/dove.js'
import { createBackup, restoreBackup } from '../server/backup.js'
import { buildCsvExport } from '../server/csv-export.js'
import { defaultExportConfiguration } from '../shared/csv-export.js'
import { reportAssociationVin, reportMatchesVehicle } from '../shared/business.js'
import type { Actor, BusinessRecord, ReportData } from '../shared/business.js'

const vin = 'TEST0000000000001'
async function workbook(sourceVin = '') {
  const book = new ExcelJS.Workbook()
  book.addWorksheet('DOVE').addRows([['Vin :', sourceVin], ['Date of record', '2026-10-25 10h00']])
  book.addWorksheet('Identification').addRows([['ECU', 'Description', 'Network', 'Supplier'], ['EVCU', 'Fictional controller', 'CAN UDS', 'QA supplier', '000001', '000002', '1.0']])
  book.addWorksheet('Defauts')
  return Buffer.from(await book.xlsx.writeBuffer())
}
async function fixture() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'vm-dove-manual-compat-')), shared = path.join(directory, 'shared')
  await fs.mkdir(shared)
  const clients = ['alpha', 'beta'].map(name => {
    const store = new LocalStore(path.join(directory, name)), business = new Business(store), teams = new TeamDirectory()
    return { store, business, teams, dove: new DoveService(business), sync: new BusinessSync(business, teams), identity: { deviceId: store.deviceId, deviceName: name, localUserId: name, displayName: name }, actor: null as Actor | null }
  })
  const [alpha, beta] = clients, team = await alpha.teams.create(shared, 'Fictional manual report team', alpha.identity)
  const requested = await beta.teams.join(shared, team.id, beta.identity)
  const approved = await alpha.teams.approve(shared, team.id, alpha.identity, requested.requests[0].id, 'admin', null, 'Approve isolated test client')
  for (const client of clients) client.actor = { id: approved.bindings.find(binding => binding.deviceId === client.store.deviceId)!.memberId, name: client.identity.displayName, deviceId: client.store.deviceId, role: 'admin' }
  const synchronize = (index: number) => clients[index].sync.synchronize(shared, team.id, clients[index].identity)
  const converge = async () => { for (const index of [0, 1, 0]) { const state = await synchronize(index); assert.equal(state.phase, 'ready'); assert.equal(state.pending, 0) } }
  const seed = async (manual = true) => {
    const vehicle = alpha.business.write({ kind: 'vehicle', data: { vin, status: 'available' }, actor: alpha.actor!, reason: 'Register fictional vehicle' })
    const bytes = await workbook(manual ? '' : vin), preview = await alpha.dove.preview(bytes, 'fictional.xlsx', 'local-account')
    const selected = manual ? alpha.dove.bind(preview.id, 'local-account', vehicle.id, vin) : preview
    const report = await alpha.dove.save(preview.id, 'local-account', alpha.actor!, { confirmed: true, reportOnly: true, ...(manual ? { bindingToken: selected.manualBinding!.token, manualVehicleConfirmed: true } : {}) })
    return { vehicle, report, bytes }
  }
  const close = async () => { for (const client of clients) client.store.db.close(); await fs.rm(directory, { recursive: true, force: true }) }
  return { directory, shared, clients, teamId: team.id, synchronize, converge, seed, close }
}
type Manifest = { format: number; records: BusinessRecord[]; deletions?: unknown[]; quarantinedOperations?: unknown[] }
async function rewriteBackup(bytes: Buffer, mutate: (manifest: Manifest) => void) {
  const original = await unzipper.Open.buffer(bytes), archive = new ZipArchive(), chunks: Buffer[] = []
  const completed = new Promise<Buffer>((resolve, reject) => { archive.on('data', chunk => chunks.push(Buffer.from(chunk))); archive.once('end', () => resolve(Buffer.concat(chunks))); archive.once('error', reject) })
  for (const entry of original.files) {
    const content = await entry.buffer()
    if (entry.path === 'manifest.json') { const manifest = JSON.parse(content.toString()) as Manifest; mutate(manifest); archive.append(JSON.stringify(manifest), { name: entry.path }) }
    else archive.append(content, { name: entry.path })
  }
  void archive.finalize()
  return completed
}

test('manual report association, original bytes and truthful history synchronize without changing vehicle or controllers', async () => {
  const f = await fixture()
  try {
    const { vehicle, report, bytes } = await f.seed(), [alpha, beta] = f.clients
    await f.converge()
    for (const client of [alpha, beta]) {
      const received = client.business.get(report.id), data = received.data as unknown as ReportData
      assert.deepEqual(data.association, report.data.association)
      assert.equal(data.parsed.vin, ''); assert.equal(data.parsed.rawVin, '')
      assert.equal(reportAssociationVin(received), vin)
      assert.equal(reportMatchesVehicle(received, client.business.get(vehicle.id)), true)
      assert.deepEqual(await client.business.readBlob(String(data.checksum)), bytes)
      assert.equal(client.business.list('part', vehicle.id).length, 0)
      assert.ok(client.business.history(vehicle.id).some(change => change.recordId === report.id && change.reason.includes('manual vehicle association')))
      assert.equal(client.business.get(vehicle.id).data.vin, vin)
    }
    assert.equal(JSON.parse(await fs.readFile(path.join(f.shared, 'business', 'HEAD.json'), 'utf8')).protocol, 1)
    assert.equal(alpha.store.db.prepare('PRAGMA user_version').get()!.user_version, 4)
  } finally { await f.close() }
})

test('format 2 backup preserves manual provenance and originals; CSV leaves original report VINs blank', async () => {
  const f = await fixture()
  try {
    const { vehicle, report, bytes } = await f.seed(), [source, target] = f.clients
    const backup = await createBackup(source.business, f.teamId)
    const restored = await restoreBackup(target.business, backup, f.teamId, target.actor!, 'Restore fictional manual report')
    assert.equal(restored.changed, 2)
    const copy = target.business.get(report.id), data = copy.data as unknown as ReportData
    assert.deepEqual(data.association, report.data.association)
    assert.equal(data.parsed.vin, ''); assert.equal(data.parsed.rawVin, '')
    assert.deepEqual(await target.business.readBlob(data.checksum), bytes)
    assert.ok(target.business.history(vehicle.id).some(change => change.recordId === report.id && change.reason.includes('manual vehicle association')))
    const configuration = { ...defaultExportConfiguration('en'), columns: { report: ['reportVin', 'rawVin', 'vehicleVin', 'vehicleId'] } }
    const exported = await buildCsvExport(target.business.list(), { vehicleIds: [vehicle.id], configuration })
    const archive = await unzipper.Open.buffer(exported.bytes)
    const csv = (await archive.files.find(entry => entry.path === 'report-summaries.csv')!.buffer()).toString('utf8')
    assert.equal(csv, `\ufeffReport VIN,Original report VIN,Vehicle VIN,Vehicle ID\r\n,,${vin},${vehicle.id}\r\n`)
  } finally { await f.close() }
})

test('format 1 backups of ordinary reported-VIN records still restore without association metadata', async () => {
  const f = await fixture()
  try {
    const { report } = await f.seed(false), [source, target] = f.clients
    const legacy = await rewriteBackup(await createBackup(source.business, f.teamId), manifest => { manifest.format = 1; delete manifest.deletions; delete manifest.quarantinedOperations })
    await restoreBackup(target.business, legacy, f.teamId, target.actor!, 'Restore legacy report')
    const restored = target.business.get(report.id)
    assert.equal(restored.data.association, undefined)
    assert.equal(reportAssociationVin(restored), vin)
  } finally { await f.close() }
})

for (const invalid of ['nonblank-source', 'wrong-parent', 'invalid-vin', 'invalid-actor', 'invalid-date', 'null', 'nonvehicle-parent'] as const) {
  test(`restore rejects ${invalid} manual association metadata before any working data or blobs are written`, async () => {
    const f = await fixture()
    try {
      const { report } = await f.seed(), [source, target] = f.clients
      const invalidBackup = await rewriteBackup(await createBackup(source.business, f.teamId), manifest => {
        const record = manifest.records.find(row => row.id === report.id)!, data = record.data as unknown as ReportData
        if (invalid === 'nonblank-source') data.parsed.rawVin = vin
        else if (invalid === 'wrong-parent') data.association!.vehicleId = randomUUID()
        else if (invalid === 'invalid-vin') data.association!.vin = 'INVALID'
        else if (invalid === 'invalid-actor') data.association!.actor.role = 'owner' as 'admin'
        else if (invalid === 'invalid-date') data.association!.assignedAt = 'not-a-date'
        else if (invalid === 'null') record.data.association = null
        else { record.vehicleId = report.id; data.association!.vehicleId = report.id }
      })
      const settings = target.store.db.prepare('SELECT * FROM settings ORDER BY key').all()
      await assert.rejects(restoreBackup(target.business, invalidBackup, f.teamId, target.actor!, 'Reject altered association'), { code: 'INVALID_BACKUP' })
      assert.deepEqual(target.business.list(), [])
      assert.deepEqual(target.store.db.prepare('SELECT * FROM settings ORDER BY key').all(), settings)
      assert.equal(target.store.db.prepare('SELECT COUNT(*) AS count FROM outbox').get()!.count, 0)
      await assert.rejects(fs.access(path.join(target.store.directory, 'blobs')))
    } finally { await f.close() }
  })
}

test('an offline manually attached report is quarantined after vehicle deletion and its provenance/file survive backup', async () => {
  const f = await fixture()
  try {
    const [alpha, beta] = f.clients
    const vehicle = alpha.business.write({ kind: 'vehicle', data: { vin, status: 'available' }, actor: alpha.actor!, reason: 'Register fictional offline vehicle' })
    await f.converge()
    const bytes = await workbook(), preview = await beta.dove.preview(bytes, 'offline.xlsx', 'member')
    const selected = beta.dove.bind(preview.id, 'member', vehicle.id, vin)
    const offline = await beta.dove.save(preview.id, 'member', beta.actor!, { confirmed: true, bindingToken: selected.manualBinding!.token, manualVehicleConfirmed: true })
    const current = alpha.business.get(vehicle.id)
    alpha.business.write({ id: vehicle.id, kind: 'vehicle', data: current.data, version: current.version, archived: true, actor: alpha.actor!, reason: 'Archive fictional vehicle' })
    assert.equal((await f.synchronize(0)).phase, 'ready')
    const deletion = await alpha.sync.deletePreview(f.shared, f.teamId, alpha.identity, alpha.actor!, vehicle.id)
    await alpha.sync.deleteVehicle(f.shared, f.teamId, alpha.identity, alpha.actor!, vehicle.id, { previewToken: deletion.token, version: deletion.version, vin, confirmation: 'DELETE', reason: 'Delete fictional archived vehicle', requestId: randomUUID() })
    await f.synchronize(1)
    assert.throws(() => beta.business.get(vehicle.id), { code: 'VEHICLE_DELETED' })
    assert.throws(() => beta.business.get(offline.id), { code: 'RECORD_NOT_FOUND' })
    const quarantined = beta.store.quarantineRows().find(entry => entry.operation.recordId === offline.id)!
    assert.deepEqual(quarantined.operation.desired.data.association, offline.data.association)
    assert.deepEqual(await beta.business.readBlob(String(offline.data.checksum)), bytes)
    const backup = await unzipper.Open.buffer(await createBackup(beta.business, f.teamId))
    const manifest = JSON.parse((await backup.files.find(entry => entry.path === 'manifest.json')!.buffer()).toString())
    assert.deepEqual(manifest.quarantinedOperations.find((entry: { operation: { recordId: string } }) => entry.operation.recordId === offline.id).operation.desired.data.association, offline.data.association)
    assert.deepEqual(await backup.files.find(entry => entry.path === `blobs/${offline.data.checksum}`)!.buffer(), bytes)
  } finally { await f.close() }
})
