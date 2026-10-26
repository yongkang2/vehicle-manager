import { controllerSources, doveRecordedTime, keyControllerName, keyControllerNames } from '../shared/business'
import type { DoveBatchSaveResult, DoveImportConfirmation, DovePreview } from '../shared/business'

export type DoveReviewRow = { uid: string; preview?: DovePreview; error?: string; savedId?: string }
export type DoveReviewChoice = { reportOnly: boolean; allowOlder: boolean; selections: DoveImportConfirmation['selections'] }
const blockedErrors = new Set(['DRAFT_EXPIRED', 'VERSION_CONFLICT', 'MANUAL_VEHICLE_REQUIRED', 'MANUAL_BINDING_CHANGED', 'VEHICLE_SELECTION_CHANGED', 'MANUAL_VEHICLE_CONFIRMATION_REQUIRED', 'VEHICLE_DELETED', 'RECORD_NOT_FOUND', 'RECORD_ARCHIVED', 'PARENT_ARCHIVED', 'ACCESS_DISABLED'])
const manualRefreshErrors = new Set([...blockedErrors])
export const isDoveReviewRefreshError = (code: string) => blockedErrors.has(code)

export function initialReviewChoice(preview: DovePreview): DoveReviewChoice {
  const sources = controllerSources(preview.parsed.controllers)
  const selections = Object.fromEntries(keyControllerNames.flatMap(name => { const matches = sources.filter(item => keyControllerName(item.controller.name) === name); return matches.length === 1 ? [[name, matches[0].index]] : [] }))
  return { reportOnly: !preview.parsed.vin, allowOlder: false, selections }
}

export function clearManualDoveBinding(preview: DovePreview): DovePreview {
  return preview.parsed.vin ? preview : { ...preview, vehicle: null, currentControllers: [], manualBinding: undefined, match: 'manual-required', existingId: null }
}

export function needsOlderDoveReview(preview: DovePreview): boolean {
  return preview.currentControllers.some(part => doveRecordedTime(preview.parsed.recordedAt) < doveRecordedTime(part.data.reportRecordedAt) && controllerSources(preview.parsed.controllers).some(item => keyControllerName(item.controller.name) === keyControllerName(part.data.name)))
}

export function canReviewDoveRow(row: DoveReviewRow, time: number): boolean {
  return Boolean(!row.savedId && row.preview && (row.preview.match === 'matched' || !row.preview.parsed.vin) && (row.preview.expires > time || row.error))
}

export function canRetainDoveRow(row: DoveReviewRow, time: number): boolean {
  const preview = row.preview
  if (row.savedId || !preview || preview.match !== 'matched' || preview.expires <= time || (row.error && blockedErrors.has(row.error))) return false
  if (preview.parsed.vin) return true
  const binding = preview.manualBinding
  return Boolean(binding?.token && preview.vehicle && binding.vehicleId === preview.vehicle.id && binding.vin === preview.vehicle.data.vin)
}

export function reviewChoiceBlocked(row: DoveReviewRow, choice: DoveReviewChoice | undefined, time: number): boolean {
  if (!choice || !canRetainDoveRow(row, time)) return true
  if (choice.reportOnly) return false
  const preview = row.preview!, sources = controllerSources(preview.parsed.controllers)
  return keyControllerNames.some(name => preview.currentControllers.filter(part => keyControllerName(part.data.name) === name).length > 1)
    || Boolean(preview.parsed.vin && needsOlderDoveReview(preview) && !choice.allowOlder)
    || keyControllerNames.some(name => sources.some(item => keyControllerName(item.controller.name) === name) && !sources.some(item => keyControllerName(item.controller.name) === name && item.index === choice.selections?.[name]))
}

/** Called at the final import action, never when a vehicle is selected. */
export function confirmationForReview(row: DoveReviewRow, choice: DoveReviewChoice | undefined, time: number): DoveImportConfirmation | null {
  if (!choice || reviewChoiceBlocked(row, choice, time)) return null
  const preview = row.preview!, manual = !preview.parsed.vin
  const versions = Object.fromEntries(keyControllerNames.map(name => { const parts = preview.currentControllers.filter(part => keyControllerName(part.data.name) === name); return [name, parts.length === 1 ? parts[0].version : null] }))
  return { confirmed: true, ...choice, versions, allowOlder: manual ? !choice.reportOnly && needsOlderDoveReview(preview) : choice.allowOlder, ...(manual ? { bindingToken: preview.manualBinding!.token, manualVehicleConfirmed: true } : {}) }
}

export function failedDoveReviewRow<T extends DoveReviewRow>(row: T, code: string): T {
  let preview = row.preview
  if (preview && !preview.parsed.vin && manualRefreshErrors.has(code)) preview = clearManualDoveBinding(preview)
  if (preview && code === 'DRAFT_EXPIRED') preview = { ...preview, expires: 0 }
  return { ...row, preview, error: code }
}

export function applyBatchSaveResults<T extends DoveReviewRow>(rows: T[], results: DoveBatchSaveResult[]): T[] {
  const byDraft = new Map(results.map(result => [result.draftId, result]))
  const key = (preview: DovePreview) => `${preview.vehicle?.id || ''}:${preview.checksum}`
  const retained = new Map(rows.flatMap(row => { const result = row.preview && byDraft.get(row.preview.id); return result?.record && row.preview ? [[key(row.preview), result.record.id] as const] : [] }))
  return rows.map(row => {
    const result = row.preview && byDraft.get(row.preview.id)
    if (result?.record) return { ...row, savedId: result.record.id, error: undefined }
    if (result?.error) return failedDoveReviewRow(row, result.error)
    const existingId = row.preview && retained.get(key(row.preview))
    return existingId && row.preview ? { ...row, preview: { ...row.preview, existingId } } : row
  })
}
