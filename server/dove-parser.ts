import ExcelJS from 'exceljs'
import unzipper from 'unzipper'
import type { Controller, DoveData, Fault } from '../shared/business.js'

function cellText(cell: ExcelJS.Cell): string {
  const value = cell.value
  if (value == null) return ''
  if (value instanceof Date) return value.toISOString().slice(0, 10)
  if (typeof value === 'object') {
    if ('result' in value) return String(value.result ?? '').trim()
    if ('richText' in value) return value.richText.map(part => part.text).join('').trim()
    return 'text' in value ? String(value.text ?? '').trim() : ''
  }
  return String(value).trim()
}
export const normalizeReportVin = (value: string) => value.toUpperCase().replace(/[\s-]/g, '')

export async function parseDove(bytes: Buffer): Promise<DoveData> {
  if (bytes.length > 10 * 1024 * 1024) throw new Error('FILE_TOO_LARGE')
  const zip = await unzipper.Open.buffer(bytes).catch(() => { throw new Error('DOVE_PARSE_FAILED') })
  if (zip.files.length > 1000 || zip.files.reduce((total, file) => total + file.uncompressedSize, 0) > 64 * 1024 * 1024 || zip.files.some(file => file.uncompressedSize > 32 * 1024 * 1024 || /(^|\/)vbaProject\.bin$/i.test(file.path))) throw new Error('EXCEL_RESOURCE_LIMIT')
  const book = new ExcelJS.Workbook()
  await book.xlsx.load(bytes as unknown as Parameters<typeof book.xlsx.load>[0])
  if (book.worksheets.length > 64 || book.worksheets.some(sheet => sheet.actualRowCount > 30000 || sheet.actualColumnCount > 200)) throw new Error('EXCEL_RESOURCE_LIMIT')
  const dove = book.getWorksheet('DOVE'), identification = book.getWorksheet('Identification'), defects = book.getWorksheet('Defauts')
  if (!dove || !identification || !defects) throw new Error('UNSUPPORTED_REPORT')
  const metadata = new Map<string, string>()
  dove.eachRow(row => metadata.set(cellText(row.getCell(1)).replace(/\s*:\s*$/, '').toLowerCase(), cellText(row.getCell(2))))
  const rawVin = metadata.get('vin') || '', vin = normalizeReportVin(rawVin)
  if (!/^[A-HJ-NPR-Z0-9]{17}$/.test(vin)) throw new Error('INVALID_VIN')
  const vins = new Set([vin])
  for (const sheet of book.worksheets) for (let row = 1; row <= Math.min(sheet.rowCount, 10); row++) for (let column = 1; column <= 2; column++) {
    const match = cellText(sheet.getCell(row, column)).match(/^Vin\s*:\s*(.+)$/i)
    if (match) vins.add(normalizeReportVin(match[1]))
  }
  if (vins.size !== 1) throw new Error('VIN_MISMATCH')
  const controllers: Controller[] = []
  let header = 0
  identification.eachRow((row, index) => {
    if (cellText(row.getCell(1)) === 'ECU' && /description/i.test(cellText(row.getCell(2)))) header = index
    if (!header || index <= header || !cellText(row.getCell(1))) return
    const value = (column: number) => cellText(row.getCell(column))
    controllers.push({ name: value(1), description: value(2), network: value(3), supplier: value(4), functionalPart: value(5), productPart: value(6), software: value(7), calibrationPart: value(9), calibrationVersion: value(10), flashingDate: value(11), productionDate: value(13), serial: value(14) })
  })
  if (!header || !controllers.length) throw new Error('UNSUPPORTED_REPORT')
  const faults: Fault[] = []
  let controller = ''
  defects.eachRow(row => {
    const name = cellText(row.getCell(1))
    if (name && !['ECU', 'Name'].includes(name) && (cellText(row.getCell(3)).includes('UDS') || controllers.some(item => item.name === name))) controller = name
    const match = cellText(row.getCell(4)).match(/^([PBCU][0-9A-F]{6})\s*\(([^)]*)\)\s*(.*)$/i)
    if (match && controller) faults.push({ controller, code: match[1], status: match[2].replace(/^[0-9a-f]+h\s*-\s*/i, ''), statusByte: match[2].match(/^([0-9a-f]+h)/i)?.[1] || '', description: match[3], context: cellText(row.getCell(5)) })
  })
  const rawMileage = metadata.get('vehicle milage') || '', mileageNumber = Number(rawMileage.replace(/\s*km$/i, '').replace(',', '.'))
  const mileage = rawMileage && Number.isFinite(mileageNumber) && mileageNumber >= 0 ? mileageNumber : null
  const rawSoc = metadata.get('value soc') || '', socNumber = Number(rawSoc)
  const soc = rawSoc && Number.isFinite(socNumber) && socNumber >= 0 && socNumber <= 100 ? socNumber : null
  const warnings: string[] = []
  if (mileage === null) warnings.push('MILEAGE_UNKNOWN')
  if (controllers.some(item => /invalide|FFF\.FFF|FF\/FF|255\/255/i.test([item.software, item.functionalPart, item.calibrationPart, item.calibrationVersion, item.flashingDate].join(' ')))) warnings.push('CONTROLLER_PLACEHOLDER')
  return { vin, rawVin, vehicleId: metadata.get('vehicle id') || '', recordedAt: metadata.get('date of record') || '', software: metadata.get('soft') || '', mileage, soc, vehicleMode: metadata.get('vehicle mode') || '', controllers, faults, warnings, sheets: book.worksheets.map(sheet => sheet.name) }
}