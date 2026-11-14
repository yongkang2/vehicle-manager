import { test } from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import ExcelJS from 'exceljs'
import { ZipArchive } from 'archiver'
import unzipper from 'unzipper'
import { Business } from '../server/business.js'
import { LocalStore } from '../server/store.js'
import { TeamDirectory } from '../server/team.js'
import { BusinessSync } from '../server/sync.js'
import { DoveService } from '../server/dove.js'
import { ReportComments } from '../server/report-comments.js'
import { createBackup, previewBackup, restoreBackup } from '../server/backup.js'
import type { Actor, BusinessRecord } from '../shared/business.js'

const vin = 'TEST0000000000001'

async function fixture(secondRole: 'member' | 'admin' = 'member') {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'vm-report-comments-')), shared = path.join(directory, 'shared')
  await fs.mkdir(shared)
  const clients = ['alpha', 'beta'].map(name => {
    const store = new LocalStore(path.join(directory, name)), business = new Business(store), teams = new TeamDirectory()
    return { store, business, teams, sync: new BusinessSync(business, teams), dove: new DoveService(business), comments: new ReportComments(business), identity: { deviceId: store.deviceId, deviceName: name, localUserId: name, displayName: name }, actor: null as Actor | null }
  })
  const [alpha, beta] = clients, team = await alpha.teams.create(shared, 'Fictional report-comment team', alpha.identity)
  const pending = await beta.teams.join(shared, team.id, beta.identity)
  const approved = await alpha.teams.approve(shared, team.id, alpha.identity, pending.requests[0].id, secondRole, null, 'Approve isolated compatibility client')
  for (const client of clients) client.actor = { id: approved.bindings.find(binding => binding.deviceId === client.store.deviceId)!.memberId, name: client.identity.displayName, deviceId: client.store.deviceId, role: client === alpha ? 'admin' : secondRole }
  const synchronize = (index: number) => clients[index].sync.synchronize(shared, team.id, clients[index].identity)
  const converge = async () => { for (const index of [0, 1, 0]) { const result = await synchronize(index); assert.equal(result.phase, 'ready'); assert.equal(result.pending, 0) } }
  const seed = async () => {
    const vehicle = alpha.business.write({ kind: 'vehicle', data: { vin, status: 'available' }, actor: alpha.actor!, reason: 'Register fictional report vehicle' })
    const book = new ExcelJS.Workbook()
    book.addWorksheet('DOVE').addRows([['Vin :', vin], ['Date of record', '2026-11-14 10h00']])
    book.addWorksheet('Identification').addRows([['ECU', 'Description', 'Network', 'Supplier'], ['EVCU', 'Fictional controller', 'CAN UDS', 'QA supplier', '000001', '000002', '1.0']])
    book.addWorksheet('Defauts')
    const bytes = Buffer.from(await book.xlsx.writeBuffer()), draft = await alpha.dove.preview(bytes, 'fictional-report.xlsx', 'local-account')
    const report = await alpha.dove.save(draft.id, 'local-account', alpha.actor!, { confirmed: true, reportOnly: true })
    return { vehicle, report, bytes }
  }
  const save = (index: number, id: string, comment: string, reason: string) => clients[index].comments.save({ id, comment, version: clients[index].business.get(id).version, reason }, clients[index].actor!)
  const close = async () => { for (const client of clients) client.store.db.close(); await fs.rm(directory, { recursive: true, force: true }) }
  return { shared, teamId: team.id, clients, synchronize, converge, seed, save, close }
}

async function legacyWithoutComment(bytes: Buffer): Promise<Buffer> {
  const original = await unzipper.Open.buffer(bytes), archive = new ZipArchive(), chunks: Buffer[] = []
  const completed = new Promise<Buffer>((resolve, reject) => { archive.on('data', chunk => chunks.push(Buffer.from(chunk))); archive.once('end', () => resolve(Buffer.concat(chunks))); archive.once('error', reject) })
  for (const entry of original.files) {
    let content = await entry.buffer()
    if (entry.path === 'manifest.json') {
      const manifest = JSON.parse(content.toString()) as { format: number; schemaVersion: number; fieldVersion: number; records: BusinessRecord[] }
      manifest.format = 4; manifest.schemaVersion = 5; manifest.fieldVersion = 2
      for (const record of manifest.records) if (record.kind === 'report') delete record.data.comment
      content = Buffer.from(JSON.stringify(manifest))
    }
    archive.append(content, { name: entry.path })
  }
  void archive.finalize()
  return completed
}

test('member report comments queue offline, synchronize and resolve only the conflicting comment field', async () => {
  const f = await fixture()
  try {
    const { vehicle, report, bytes } = await f.seed(), [alpha, beta] = f.clients
    await f.converge()
    await fs.rename(f.shared, `${f.shared}-offline`)
    f.save(1, report.id, '  复核完成\nRetest before release.  ', 'Add shared report comment')
    assert.equal((await f.synchronize(1)).phase, 'offline')
    assert.equal(beta.sync.status().pending, 1)
    await fs.rename(`${f.shared}-offline`, f.shared)
    await f.converge()
    for (const client of f.clients) {
      assert.equal(client.business.get(report.id).data.comment, '复核完成\nRetest before release.')
      const immutable = { ...client.business.get(report.id).data }; delete immutable.comment
      assert.deepEqual(immutable, report.data)
      assert.deepEqual(await client.business.readBlob(String(report.data.checksum)), bytes)
      const change = client.business.history(vehicle.id).find(entry => entry.reason === 'Add shared report comment')!
      assert.equal(change.actor.id, beta.actor!.id)
      assert.equal(change.after?.comment, '复核完成\nRetest before release.')
    }
    f.save(0, report.id, 'Shared review decision', 'Administrator review')
    f.save(1, report.id, 'Local review decision', 'Concurrent member review')
    await f.synchronize(0)
    const conflict = (await f.synchronize(1)).conflicts.find(entry => entry.recordId === report.id)!
    assert.deepEqual(conflict.fields, ['comment'])
    await beta.sync.resolve(f.shared, f.teamId, beta.identity, beta.actor!, report.id, conflict.token, { comment: 'shared' }, 'Keep the reviewed shared comment')
    await f.converge()
    for (const client of f.clients) assert.equal(client.business.get(report.id).data.comment, 'Shared review decision')
    assert.equal(JSON.parse(await fs.readFile(path.join(f.shared, 'business/HEAD.json'), 'utf8')).protocol, 1)
    assert.equal(alpha.store.db.prepare('PRAGMA user_version').get()!.user_version, 6)
  } finally { await f.close() }
})

test('current backups retain report comments and older missing comments are visible in restore previews', async () => {
  const f = await fixture('admin')
  try {
    const { report, bytes } = await f.seed(), [source, target] = f.clients
    await f.converge()
    const legacy = await legacyWithoutComment(await createBackup(source.business, f.teamId))
    f.save(0, report.id, 'Keep this review with the report', 'Review before backup')
    const backup = await createBackup(source.business, f.teamId), zip = await unzipper.Open.buffer(backup)
    const manifest = JSON.parse((await zip.files.find(entry => entry.path === 'manifest.json')!.buffer()).toString())
    assert.equal(manifest.format, 5); assert.equal(manifest.schemaVersion, 6); assert.equal(manifest.fieldVersion, 4)
    await f.synchronize(0)
    const adding = await previewBackup(target.business, backup, f.teamId)
    assert.equal(adding.effects.find(effect => effect.id === report.id)!.fields.find(field => field.key === 'comment')!.after, 'Keep this review with the report')
    await restoreBackup(target.business, backup, f.teamId, target.actor!, 'Recover a reviewed report comment')
    assert.equal(target.business.get(report.id).data.comment, 'Keep this review with the report')
    assert.deepEqual(await target.business.readBlob(String(report.data.checksum)), bytes)
    await f.converge()
    const removing = await previewBackup(target.business, legacy, f.teamId)
    const field = removing.effects.find(effect => effect.id === report.id)!.fields.find(entry => entry.key === 'comment')!
    assert.equal(field.before, 'Keep this review with the report'); assert.equal(field.after, null)
    await restoreBackup(target.business, legacy, f.teamId, target.actor!, 'Restore the reviewed legacy report state')
    assert.equal(target.business.get(report.id).data.comment ?? '', '')
    await f.converge()
    assert.equal(source.business.get(report.id).data.comment ?? '', '')
  } finally { await f.close() }
})

test('reimporting an identical DOVE original preserves its comment while applying confirmed controller data', async () => {
  const f = await fixture()
  try {
    const { vehicle, report, bytes } = await f.seed(), [source] = f.clients
    const annotated = f.save(0, report.id, 'Reviewed original; retain this annotation', 'Record the initial review')
    const draft = await source.dove.preview(bytes, 'same-original-again.xlsx', 'local-account')
    assert.equal(draft.existingId, report.id)
    const retained = await source.dove.save(draft.id, 'local-account', source.actor!, { confirmed: true, reportOnly: false })
    assert.equal(retained.id, report.id); assert.equal(retained.version, annotated.version)
    assert.deepEqual(retained.data, annotated.data)
    assert.equal(source.business.list('report', vehicle.id).length, 1)
    assert.equal(source.business.list('part', vehicle.id).length, 1)
    assert.deepEqual(await source.business.readBlob(String(retained.data.checksum)), bytes)
  } finally { await f.close() }
})
