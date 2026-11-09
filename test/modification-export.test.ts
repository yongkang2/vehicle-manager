import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import unzipper from 'unzipper'
import { buildCsvExport } from '../server/csv-export.js'
import { defaultExportConfiguration, exportColumns, parseExportConfiguration, recordsForExport } from '../shared/csv-export.js'
import type { BusinessRecord } from '../shared/business.js'
import type { ModificationFile } from '../shared/modifications.js'

const date = '2026-11-08T01:02:03.000Z'
const record = (kind: BusinessRecord['kind'], data: BusinessRecord['data'], vehicleId: string | null = null, archived = false): BusinessRecord => ({ id: randomUUID(), kind, vehicleId, data, archived, version: 1, updated: date })
function fixture() {
  const first = record('vehicle', { name: 'Fictional first', vin: 'TEST0000000000001', status: 'available' }), second = record('vehicle', { name: 'Fictional second', vin: 'TEST0000000000002', status: 'available' })
  const file: ModificationFile = { id: randomUUID(), name: '中文,request.eml', checksum: 'a'.repeat(64), size: 321, savedAt: date, archived: false }
  const archivedFile: ModificationFile = { id: randomUUID(), name: 'old.pdf', checksum: 'b'.repeat(64), size: 42, savedAt: date, archived: true }
  const group = record('modificationGroup', { schema: 1, name: 'Shared vehicle modification', description: 'Line one\r\n第二行', requestor: '=SUM(1,2)', lead: '负责人 "乙"', installedAt: '2026-11-01', removedAt: '', notes: '', attachments: [file, archivedFile] })
  const left = record('modification', { groupId: group.id }, first.id), right = record('modification', { groupId: group.id }, second.id)
  const independent = record('modification', { name: 'Independent modification', description: '', requestor: '', lead: '', installedAt: '', removedAt: '', notes: '', attachments: [{ ...file, id: randomUUID(), name: 'independent.txt' }] }, first.id)
  const archived = record('modification', { name: 'Archived modification', requestor: 'Historic requestor', lead: '', attachments: [{ ...file, id: randomUUID(), name: 'archived.txt' }] }, second.id, true)
  const general = record('attachment', { name: 'ordinary.pdf', checksum: 'c'.repeat(64), size: 99, savedAt: date }, first.id)
  return { first, second, group, left, right, independent, archived, file, general, records: [first, second, group, left, right, independent, archived, general] }
}
async function csv(bytes: Buffer, filename: string): Promise<string> {
  const zip = await unzipper.Open.buffer(bytes), entry = zip.files.find(file => file.path === filename)
  assert(entry, `${filename} missing`)
  return (await entry.buffer()).toString('utf8')
}

test('modification CSV resolves one shared group separately for each selected vehicle and preserves fields and dates', async () => {
  const f = fixture(), configuration = defaultExportConfiguration('en')
  configuration.columns = { modification: ['name', 'description', 'requestor', 'lead', 'installedAt', 'removedAt', 'groupId', 'vehicleId', 'vehicleVin', 'id'] }
  const rows = recordsForExport(f.records, 'modification', new Set([f.first.id, f.second.id]), false)
  assert.equal(rows.length, 3); assert(rows.every(row => row.kind === 'modification'))
  assert.equal(rows.find(row => row.id === f.left.id)?.data.requestor, '=SUM(1,2)')
  assert.equal(rows.find(row => row.id === f.right.id)?.data.installedAt, '2026-11-01')
  assert.equal(rows.find(row => row.id === f.independent.id)?.data.requestor, '')
  const result = await buildCsvExport(f.records, { vehicleIds: [f.first.id, f.second.id], configuration }), output = await csv(result.bytes, 'modifications.csv')
  assert.equal(result.counts.modification, 3)
  assert(output.startsWith('\ufeffName,Description,Requestor,Lead,Installed on,Removed on,Linked modification group ID,Vehicle ID,Vehicle VIN,Record ID\r\n'))
  assert(output.includes('"Line one\r\n第二行"')); assert(output.includes('"\'=SUM(1,2)"')); assert(output.includes('"负责人 ""乙"""'))
  assert(output.includes('2026-11-01')); assert(output.includes('TEST0000000000001')); assert(output.includes('TEST0000000000002'))
  assert.equal((output.match(/Shared vehicle modification/g) || []).length, 2)
})

test('attachment CSV includes immutable modification-file associations with vehicle, modification and group references', async () => {
  const f = fixture(), configuration = defaultExportConfiguration('en')
  configuration.columns = { attachment: ['name', 'checksum', 'size', 'modificationId', 'groupId', 'fileId', 'vehicleVin', 'id'] }
  const rows = recordsForExport(f.records, 'attachment', new Set([f.first.id, f.second.id]), false)
  assert.equal(rows.length, 4)
  const shared = rows.filter(row => row.data.fileId === f.file.id)
  assert.equal(shared.length, 2); assert.equal(new Set(shared.map(row => row.id)).size, 2)
  assert.deepEqual(shared.map(row => row.data.modificationId).sort(), [f.left.id, f.right.id].sort())
  assert(shared.every(row => row.data.groupId === f.group.id && row.data.checksum === f.file.checksum))
  assert(rows.some(row => row.id === f.general.id && !row.data.modificationId))
  const result = await buildCsvExport(f.records, { vehicleIds: [f.first.id, f.second.id], configuration }), output = await csv(result.bytes, 'attachments.csv')
  assert.equal(result.counts.attachment, 4); assert.equal((output.match(/中文,request.eml/g) || []).length, 2)
  assert(output.includes(f.left.id)); assert(output.includes(f.right.id)); assert(output.includes(f.group.id))
  assert.equal(output.includes('old.pdf'), false); assert.equal(output.includes('archived.txt'), false)
  configuration.includeArchived = true
  const archived = await buildCsvExport(f.records, { vehicleIds: [f.first.id, f.second.id], configuration })
  assert.equal(archived.counts.attachment, 7)
  const all = await csv(archived.bytes, 'attachments.csv')
  assert.equal((all.match(/old.pdf/g) || []).length, 2); assert(all.includes('archived.txt'))
})

test('new modification columns remain optional for existing templates and do not appear in Equipment', async () => {
  const configuration = defaultExportConfiguration('zh')
  configuration.columns = { modification: ['name', 'description', 'installedAt'], equipment: ['name', 'notes'] }
  assert.deepEqual(parseExportConfiguration(configuration), configuration)
  assert.deepEqual(configuration.columns.modification, ['name', 'description', 'installedAt'])
  assert(exportColumns.modification.some(column => column.id === 'requestor' && column.label[1] === '申请人'))
  assert(exportColumns.modification.some(column => column.id === 'lead' && column.label[1] === '负责人'))
  assert.equal(exportColumns.equipment.some(column => column.id === 'requestor' || column.id === 'lead'), false)
  for (const id of ['modificationId', 'groupId', 'fileId']) assert(exportColumns.attachment.some(column => column.id === id))
})

test('Chinese headers and selected-vehicle scope remain accurate for shared modifications and files', async () => {
  const f = fixture(), configuration = defaultExportConfiguration('zh')
  configuration.columns = { modification: ['requestor', 'lead', 'vehicleVin'], attachment: ['name', 'modificationId', 'groupId', 'vehicleVin'] }
  const result = await buildCsvExport(f.records, { vehicleIds: [f.second.id], configuration })
  assert.equal(result.counts.modification, 1); assert.equal(result.counts.attachment, 1)
  const modifications = await csv(result.bytes, 'modifications.csv'), attachments = await csv(result.bytes, 'attachments.csv')
  assert(modifications.startsWith('\ufeff申请人,负责人,车辆 VIN\r\n'))
  assert(attachments.startsWith('\ufeffFilename,车辆改装标识,关联改装组标识,车辆 VIN\r\n') || attachments.startsWith('\ufeff文件名,车辆改装标识,关联改装组标识,车辆 VIN\r\n'))
  assert(attachments.includes(f.right.id)); assert.equal(attachments.includes(f.left.id), false)
  assert.equal(attachments.includes('independent.txt'), false)
})

test('CSV rejects an invalid shared graph rather than exporting mismatched or silently missing group data', async () => {
  const f = fixture(), configuration = defaultExportConfiguration('en')
  configuration.columns = { modification: ['name', 'requestor'] }
  await assert.rejects(buildCsvExport(f.records.filter(record => record.id !== f.group.id), { vehicleIds: [f.first.id], configuration }), { code: 'MODIFICATION_CORRUPTED' })
})
