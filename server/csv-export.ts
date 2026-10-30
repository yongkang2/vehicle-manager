import { ZipArchive } from 'archiver'
import type { BusinessRecord } from '../shared/business.js'
import { configurationRevisionSummaries } from '../shared/configuration-revisions.js'
import { exportColumns, exportKinds, matchesExportVehicle, MAX_EXPORT_ID_LENGTH, MAX_EXPORT_VEHICLES, parseExportConfiguration, recordsForExport } from '../shared/csv-export.js'
import type { CsvExportRequest, ExportRecordKind } from '../shared/csv-export.js'
import { AppError } from './team.js'

const exportLimit = 200 * 1024 * 1024
const filenames: Record<ExportRecordKind, string> = { vehicle: 'vehicles.csv', part: 'parts-controllers.csv', modification: 'modifications.csv', equipment: 'equipment.csv', report: 'report-summaries.csv', attachment: 'attachments.csv' }
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)

function cell(value: unknown): string {
  let text = typeof value === 'string' ? value : typeof value === 'number' && Number.isFinite(value) || typeof value === 'boolean' ? String(value) : ''
  // A leading apostrophe makes untrusted text literal, including formulas preceded by whitespace/control characters.
  if (typeof value === 'string' && /^[\s\p{Cc}\p{Cf}]*[=+\-@]/u.test(text)) text = "'" + text
  return /[",\r\n]/.test(text) ? '"' + text.replace(/"/g, '""') + '"' : text
}

function columnValue(record: BusinessRecord, id: string, vehicles: Map<string, BusinessRecord>, revisions: ReadonlyMap<string, string>): unknown {
  if (id === 'configurationRevision' && record.kind === 'vehicle') return revisions.get(record.id) || ''
  if (id === 'id' || id === 'archived' || id === 'version' || id === 'updated') return record[id]
  if (id === 'vehicleId') return record.vehicleId
  if (id === 'vehicleVin') return record.vehicleId ? vehicles.get(record.vehicleId)?.data.vin : null
  if (record.kind === 'report' && ['reportVin', 'rawVin', 'software', 'mileage', 'soc', 'vehicleMode'].includes(id)) {
    const parsed = record.data.parsed
    return object(parsed) ? parsed[id === 'reportVin' ? 'vin' : id] : null
  }
  return record.data[id]
}

export async function buildCsvExport(records: BusinessRecord[], request: CsvExportRequest): Promise<{ bytes: Buffer; counts: Record<ExportRecordKind, number> }> {
  const configuration = parseExportConfiguration(request?.configuration)
  if (!configuration || !Array.isArray(request.vehicleIds) || !request.vehicleIds.length || request.vehicleIds.length > MAX_EXPORT_VEHICLES || Array.from(request.vehicleIds).some(id => typeof id !== 'string' || !id.length || id.length > MAX_EXPORT_ID_LENGTH) || new Set(request.vehicleIds).size !== request.vehicleIds.length) throw new AppError('INVALID_INPUT')
  if (records.length > 200000) throw new AppError('EXPORT_TOO_LARGE', 413)
  const vehicles = new Map(records.filter(record => record.kind === 'vehicle').map(record => [record.id, record]))
  for (const id of request.vehicleIds) {
    const vehicle = vehicles.get(id)
    if (!vehicle || !matchesExportVehicle(vehicle, configuration)) throw new AppError('EXPORT_SELECTION_CHANGED', 409)
  }
  const selected = new Set(request.vehicleIds), counts: Record<ExportRecordKind, number> = { vehicle: 0, part: 0, modification: 0, equipment: 0, report: 0, attachment: 0 }
  const revisions = new Map(configurationRevisionSummaries(records).map(summary => [summary.vehicleId, summary.label]))
  const entries: { name: string; bytes: Buffer }[] = []
  let uncompressedSize = 0
  // Materialize all cells from this single working snapshot before the asynchronous ZIP workflow.
  for (const kind of exportKinds) {
    const columns = configuration.columns[kind]
    if (!columns) continue
    const rows = recordsForExport(records, kind, selected, configuration.includeArchived)
    counts[kind] = rows.length
    const headers = new Map(exportColumns[kind].map(column => [column.id, column.label[configuration.language === 'zh' ? 1 : 0]]))
    const lines: string[] = ['\ufeff' + columns.map(id => cell(headers.get(id))).join(',') + '\r\n']
    uncompressedSize += Buffer.byteLength(lines[0])
    if (uncompressedSize > exportLimit) throw new AppError('EXPORT_TOO_LARGE', 413)
    for (const record of rows) {
      const line = columns.map(id => cell(columnValue(record, id, vehicles, revisions))).join(',') + '\r\n'
      uncompressedSize += Buffer.byteLength(line)
      if (uncompressedSize > exportLimit) throw new AppError('EXPORT_TOO_LARGE', 413)
      lines.push(line)
    }
    entries.push({ name: filenames[kind], bytes: Buffer.from(lines.join(''), 'utf8') })
  }
  const archive = new ZipArchive({ zlib: { level: 6 } }), chunks: Buffer[] = []
  let compressedSize = 0
  const completed = new Promise<Buffer>((resolve, reject) => {
    archive.on('data', (chunk: Buffer) => {
      compressedSize += chunk.length
      if (compressedSize > exportLimit) { archive.abort(); reject(new AppError('EXPORT_TOO_LARGE', 413)) }
      else chunks.push(chunk)
    })
    archive.once('error', reject)
    archive.once('warning', reject)
    archive.once('end', () => resolve(Buffer.concat(chunks)))
  })
  try {
    for (const entry of entries) archive.append(entry.bytes, { name: entry.name })
    const [bytes] = await Promise.all([completed, archive.finalize()])
    return { bytes, counts }
  } catch (error) { archive.abort(); throw error }
}
