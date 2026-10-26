import { test } from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ZipArchive } from 'archiver'
import unzipper from 'unzipper'
import { Business, normalizeFields, validateManualRecordFields } from '../server/business.js'
import { LocalStore } from '../server/store.js'
import { createBackup, restoreBackup } from '../server/backup.js'
import { buildCsvExport } from '../server/csv-export.js'
import { complianceLevels, vehicleFields } from '../shared/business.js'
import type { Actor } from '../shared/business.js'
import { defaultExportConfiguration, exportColumns } from '../shared/csv-export.js'

const base = { vin: 'TEST0000000000001', status: 'available' }
async function fixture() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'vehicle-compliance-')), stores = ['source', 'target'].map(name => new LocalStore(path.join(directory, name))), [source, target] = stores.map(store => new Business(store))
  const actor: Actor = { id: 'admin', name: 'Compliance tester', role: 'admin', deviceId: stores[0].deviceId }
  return { source, target, actor, stores, async close() { for (const store of stores) store.db.close(); await fs.rm(directory, { recursive: true, force: true }) } }
}

test('compliance options are exact, trimmed, centrally validated and blank-compatible only outside manual saves', () => {
  assert.deepEqual(complianceLevels, ['Eu7', 'CN6', 'Eu6', 'PL8'])
  assert(vehicleFields.includes('complianceLevel'))
  for (const value of complianceLevels) {
    assert.equal(normalizeFields('vehicle', { ...base, complianceLevel: `  ${value}  ` }).complianceLevel, value)
    assert.doesNotThrow(() => validateManualRecordFields('vehicle', { ...base, complianceLevel: value }))
  }
  for (const value of [undefined, null, '', '   ']) {
    assert.equal(normalizeFields('vehicle', { ...base, complianceLevel: value }).complianceLevel, '')
    assert.throws(() => validateManualRecordFields('vehicle', { ...base, complianceLevel: value }), { code: 'COMPLIANCE_LEVEL_REQUIRED' })
  }
  for (const value of [123, false, [], {}, 'EU7', 'Euro 7', 'CN7', 'x'.repeat(4001)]) assert.throws(() => normalizeFields('vehicle', { ...base, complianceLevel: value }), { code: 'INVALID_INPUT' })
})

test('compliance persists in history, CSV headers/data and current backups without changing stored option spelling', async () => {
  const f = await fixture()
  try {
    const car = f.source.write({ kind: 'vehicle', data: { ...base, complianceLevel: 'PL8' }, actor: f.actor, reason: 'Classify synthetic vehicle' })
    const bytes = await createBackup(f.source, 'compliance-team')
    assert.equal((await restoreBackup(f.target, bytes, 'compliance-team', f.actor, 'Restore compliance classification')).changed, 1)
    assert.equal(f.target.get(car.id).data.complianceLevel, 'PL8')
    assert(f.target.history(car.id).some(change => change.after.complianceLevel === 'PL8'))
    for (const language of ['en', 'zh'] as const) {
      const configuration = { ...defaultExportConfiguration(language), columns: { vehicle: ['vin', 'complianceLevel'] } }, result = await buildCsvExport(f.target.list(), { vehicleIds: [car.id], configuration }), zip = await unzipper.Open.buffer(result.bytes)
      const csv = (await zip.files.find(file => file.path === 'vehicles.csv')!.buffer()).toString('utf8'), header = exportColumns.vehicle.find(column => column.id === 'complianceLevel')!.label[language === 'zh' ? 1 : 0]
      assert.equal(csv, `\ufeffVIN,${header}\r\n${base.vin},PL8\r\n`)
    }
  } finally { await f.close() }
})

for (const format of [1, 2]) test(`format ${format} backups without compliance restore blank without an invented default`, async () => {
  const f = await fixture()
  try {
    const data = normalizeFields('vehicle', base); delete data.complianceLevel
    const car = f.source.write({ kind: 'vehicle', data, actor: f.actor, reason: 'Synthetic pre-compliance vehicle', internal: true })
    assert.equal(Object.hasOwn(f.source.get(car.id).data, 'complianceLevel'), false)
    const original = await unzipper.Open.buffer(await createBackup(f.source, 'compliance-team')), archive = new ZipArchive(), chunks: Buffer[] = []
    const complete = new Promise<Buffer>((resolve, reject) => { archive.on('data', chunk => chunks.push(chunk)); archive.once('error', reject); archive.once('end', () => resolve(Buffer.concat(chunks))) })
    for (const entry of original.files) {
      const bytes = await entry.buffer()
      if (entry.path === 'manifest.json') { const manifest = JSON.parse(bytes.toString()); manifest.format = format; if (format === 1) { delete manifest.deletions; delete manifest.quarantinedOperations } archive.append(JSON.stringify(manifest), { name: entry.path }) }
      else archive.append(bytes, { name: entry.path })
    }
    void archive.finalize()
    assert.equal((await restoreBackup(f.target, await complete, 'compliance-team', f.actor, 'Restore old compliance-free backup')).changed, 1)
    assert.equal(f.target.get(car.id).data.complianceLevel, '')
    assert(f.target.history(car.id).some(change => !Object.hasOwn(change.after, 'complianceLevel')))
  } finally { await f.close() }
})

for (const format of [1, 2]) test(`format ${format} backups reject invalid nonblank compliance before writing records, history or queues`, async () => {
  const f = await fixture()
  try {
    f.source.write({ kind: 'vehicle', data: { ...base, complianceLevel: 'Eu7' }, actor: f.actor, reason: 'Valid source classification' })
    const original = await unzipper.Open.buffer(await createBackup(f.source, 'compliance-team')), archive = new ZipArchive(), chunks: Buffer[] = []
    const complete = new Promise<Buffer>((resolve, reject) => { archive.on('data', chunk => chunks.push(chunk)); archive.once('error', reject); archive.once('end', () => resolve(Buffer.concat(chunks))) })
    for (const entry of original.files) {
      const bytes = await entry.buffer()
      if (entry.path === 'manifest.json') { const manifest = JSON.parse(bytes.toString()); manifest.format = format; manifest.records[0].data.complianceLevel = 'EU7'; if (format === 1) { delete manifest.deletions; delete manifest.quarantinedOperations } archive.append(JSON.stringify(manifest), { name: entry.path }) }
      else archive.append(bytes, { name: entry.path })
    }
    void archive.finalize()
    await assert.rejects(restoreBackup(f.target, await complete, 'compliance-team', f.actor, 'Reject invalid compliance'), { code: 'INVALID_INPUT' })
    assert.deepEqual(f.target.list(), [])
    assert.deepEqual(f.target.history(), [])
    assert.equal(f.stores[1].db.prepare('SELECT COUNT(*) AS n FROM outbox').get()!.n, 0)
  } finally { await f.close() }
})
