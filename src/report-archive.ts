import { reportAssociationVin } from '../shared/business.js'
import type { BusinessRecord } from '../shared/business.js'

export function matchesReportSearch(report: BusinessRecord, vehicle: BusinessRecord | undefined, query: string): boolean {
  const source = [vehicle?.data.model, vehicle?.data.name, vehicle?.data.vin, vehicle?.data.project, reportAssociationVin(report), report.data.name, report.data.recordedAt, report.data.savedAt].filter(value => value !== undefined && value !== null).join(' ').replace(/(\d{2})h(\d{2})/g, '$1:$2').toLowerCase()
  return query.trim().toLowerCase().split(/\s+/).every(term => source.includes(term.replace(/(\d{2})h(\d{2})/g, '$1:$2')))
}
