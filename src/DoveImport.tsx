import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import { Alert, Button, Checkbox, Descriptions, Empty, Modal, Select, Space, Spin, Table, Tabs, Tag, Upload } from 'antd'
import type { UploadProps } from 'antd'
import type { RcFile } from 'antd/es/upload/interface'
import { Check, FileSpreadsheet, RefreshCw, Trash2, Upload as UploadIcon } from 'lucide-react'
import { controllerFields, controllerSources, keyControllerName, keyControllerNames, validControllerValue, DOVE_BATCH_LIMIT, DOVE_MAX_FILE_BYTES } from '../shared/business'
import type { BusinessRecord, DoveBatchPreviewResult, DoveBatchSaveResult, DovePreview } from '../shared/business'
import { createWorkspaceScope } from './api'
import { applyBatchSaveResults, canRetainDoveRow, canReviewDoveRow, clearManualDoveBinding, confirmationForReview, failedDoveReviewRow, initialReviewChoice, isDoveReviewRefreshError, needsOlderDoveReview, reviewChoiceBlocked } from './dove-import-review'
import type { DoveReviewChoice, DoveReviewRow } from './dove-import-review'
import { translateBusiness } from './business-i18n'
import { errorText } from './i18n'
import type { Language } from './i18n'

const ReportViewer = lazy(() => import('./ReportViewer'))
type ImportRow = DoveReviewRow & { file: RcFile }
type VehicleSelection = { vehicleId: string; expectedVin: string }
type Operation = 'parse' | 'save' | 'bind' | 'open'
type DoveRequestScope = ReturnType<typeof createWorkspaceScope>
type Props = {
  active: boolean; vehicles: BusinessRecord[]; language: Language; disabled: boolean
  onBusyChange: (busy: boolean) => void
  onRetained: (scope: DoveRequestScope, signal: AbortSignal) => Promise<void>
  onOpenReport: (id: string, scope: DoveRequestScope, signal: AbortSignal) => Promise<void>
  onError: (error: unknown) => void
}
const fileError = (file: File) => !/\.xlsx$/i.test(file.name) ? 'XLSX_REQUIRED' : file.size > DOVE_MAX_FILE_BYTES ? 'FILE_TOO_LARGE' : undefined
const errorCode = (error: unknown) => error instanceof Error ? error.message : 'SERVER_ERROR'

export default function DoveImport({ active, vehicles, language, disabled, onBusyChange, onRetained, onOpenReport, onError }: Props) {
  const text = translateBusiness(language), [scope] = useState(createWorkspaceScope)
  const mounted = useRef(true), operationRef = useRef<Operation | null>(null), requestController = useRef<AbortController | null>(null), reviewGeneration = useRef(0)
  const busyCallback = useRef(onBusyChange)
  const [rows, setRows] = useState<ImportRow[]>([]), rowsRef = useRef<ImportRow[]>([])
  const [operation, setOperation] = useState<Operation | null>(null), [activeIds, setActiveIds] = useState<string[]>([])
  const [previewId, setPreviewId] = useState<string | null>(null)
  const [reviewIds, setReviewIds] = useState<string[]>([]), reviewIdsRef = useRef<string[]>([])
  const [choices, setChoices] = useState<Record<string, DoveReviewChoice>>({}), choicesRef = useRef<Record<string, DoveReviewChoice>>({})
  const [reviewVehicles, setReviewVehicles] = useState<BusinessRecord[]>([])
  const [vehicleSelections, setVehicleSelections] = useState<Record<string, VehicleSelection>>({}), selectionsRef = useRef<Record<string, VehicleSelection>>({})
  const [partialFailure, setPartialFailure] = useState(false), [selectionLimited, setSelectionLimited] = useState(false), [clock, setClock] = useState(Date.now)
  useEffect(() => { busyCallback.current = onBusyChange }, [onBusyChange])
  useEffect(() => {
    mounted.current = true
    const timer = setInterval(() => setClock(Date.now()), 30000)
    return () => {
      mounted.current = false; reviewGeneration.current += 1; clearInterval(timer)
      requestController.current?.abort(); requestController.current = null
      if (operationRef.current) busyCallback.current(false)
      operationRef.current = null
    }
  }, [])
  function replaceRows(next: ImportRow[]) { rowsRef.current = next; setRows(next) }
  function changeRows(update: (current: ImportRow[]) => ImportRow[]) { replaceRows(update(rowsRef.current)) }
  function replaceChoices(next: Record<string, DoveReviewChoice>) { choicesRef.current = next; setChoices(next) }
  function replaceSelections(next: Record<string, VehicleSelection>) { selectionsRef.current = next; setVehicleSelections(next) }
  function replaceReviewIds(next: string[]) { reviewIdsRef.current = next; setReviewIds(next) }
  function beginOperation(kind: Operation, ids: string[]) {
    if (disabled || operationRef.current || !mounted.current) return null
    const controller = new AbortController()
    try { scope.assertCurrent(controller.signal) } catch { return null }
    operationRef.current = kind; requestController.current = controller
    setOperation(kind); setActiveIds(ids); busyCallback.current(true)
    return controller
  }
  function currentRequest(controller: AbortController) {
    if (!mounted.current || requestController.current !== controller || controller.signal.aborted) return false
    try { scope.assertCurrent(controller.signal); return true } catch { return false }
  }
  function finishOperation(controller: AbortController) {
    if (requestController.current !== controller) return
    requestController.current = null; operationRef.current = null; busyCallback.current(false)
    if (mounted.current) { setClock(Date.now); setOperation(null); setActiveIds([]) }
  }
  const locked = disabled || operation !== null
  const pending = rows.filter(row => !row.savedId && !row.preview && !fileError(row.file))
  const eligible = rows.filter(row => canReviewDoveRow(row, clock))
  const viewed = rows.find(row => row.uid === previewId)
  const reviewRows = reviewIds.flatMap(id => { const row = rows.find(item => item.uid === id); return row?.preview && !row.savedId ? [row] : [] })
  const readyRows = reviewRows.filter(row => canRetainDoveRow(row, clock))
  const importCount = readyRows.filter(row => !reviewChoiceBlocked(row, choices[row.uid], clock)).length
  const confirmationBlocked = readyRows.some(row => reviewChoiceBlocked(row, choices[row.uid], clock))
  function reviewImport(candidates: ImportRow[], afterParsing = false) {
    if (!afterParsing && (disabled || operationRef.current)) return
    const candidateIds = new Set(candidates.map(row => row.uid)), targets = rowsRef.current.filter(row => candidateIds.has(row.uid) && canReviewDoveRow(row, Date.now()))
    reviewGeneration.current += 1; setClock(Date.now); setPreviewId(null); setPartialFailure(false)
    replaceReviewIds(targets.map(row => row.uid))
    replaceChoices(Object.fromEntries(targets.map(row => [row.uid, initialReviewChoice(row.preview!)])))
    replaceSelections(Object.fromEntries(targets.flatMap(row => row.preview?.manualBinding ? [[row.uid, { vehicleId: row.preview.manualBinding.vehicleId, expectedVin: row.preview.manualBinding.vin }]] : [])))
    setReviewVehicles(vehicles.filter(vehicle => vehicle.kind === 'vehicle' && !vehicle.archived).map(vehicle => ({ ...vehicle, data: { ...vehicle.data } })))
  }
  function cancelReview() {
    if (operationRef.current && operationRef.current !== 'bind') return
    reviewGeneration.current += 1
    if (operationRef.current === 'bind' && requestController.current) {
      const controller = requestController.current
      controller.abort(); finishOperation(controller)
    }
    replaceReviewIds([]); replaceSelections({}); setPartialFailure(false)
  }
  function updateChoice(uid: string, update: Partial<DoveReviewChoice>) {
    if (disabled || operationRef.current) return
    const row = rowsRef.current.find(item => item.uid === uid)
    if (!row?.preview) return
    replaceChoices({ ...choicesRef.current, [uid]: { ...(choicesRef.current[uid] || initialReviewChoice(row.preview)), ...update } })
    if (row.error && !isDoveReviewRefreshError(row.error)) changeRows(current => current.map(item => item.uid === uid ? { ...item, error: undefined } : item))
  }
  const beforeUpload: UploadProps['beforeUpload'] = (file, selection) => {
    if (disabled || operationRef.current) return Upload.LIST_IGNORE
    const selectionIds = new Set(selection.map(item => item.uid))
    setSelectionLimited(rowsRef.current.filter(row => !selectionIds.has(row.uid)).length + selection.length > DOVE_BATCH_LIMIT)
    if (rowsRef.current.length < DOVE_BATCH_LIMIT && !rowsRef.current.some(row => row.uid === file.uid)) replaceRows([...rowsRef.current, { uid: file.uid, file, error: fileError(file) }])
    return Upload.LIST_IGNORE
  }
  async function parse(candidates: ImportRow[]) {
    const ids = new Set(candidates.map(row => row.uid)), targets = rowsRef.current.filter(row => ids.has(row.uid) && !row.savedId && !fileError(row.file))
    if (!targets.length) return
    const controller = beginOperation('parse', targets.map(row => row.uid))
    if (!controller) return
    changeRows(current => current.map(row => ids.has(row.uid) ? { ...row, preview: undefined, error: undefined } : row))
    try {
      const form = new FormData(); for (const row of targets) form.append('files', row.file)
      const results = await scope.request<DoveBatchPreviewResult[]>('/api/business/dove/preview-batch', { method: 'POST', body: form, signal: controller.signal })
      if (!currentRequest(controller)) return
      const byId = new Map(results.flatMap(result => targets[result.index] ? [[targets[result.index].uid, result] as const] : []))
      const next = rowsRef.current.map(row => { const result = byId.get(row.uid); return result ? { ...row, preview: result.preview, error: result.error } : row })
      replaceRows(next); reviewImport(next.filter(row => ids.has(row.uid)), true)
    } catch (error) {
      if (!currentRequest(controller)) return
      changeRows(current => current.map(row => ids.has(row.uid) ? { ...row, error: errorCode(error) } : row)); onError(error)
    } finally { finishOperation(controller) }
  }
  async function selectVehicle(uid: string, selected: VehicleSelection | undefined, eventTime: number) {
    if (disabled || operationRef.current) return
    const row = rowsRef.current.find(item => item.uid === uid)
    if (!row?.preview || row.preview.parsed.vin || row.savedId || row.preview.expires <= eventTime || !reviewIdsRef.current.includes(uid)) return
    const previous = row.preview, cleared = clearManualDoveBinding(previous)
    // Invalidate the old token and controller snapshot in the canonical row ref
    // before any asynchronous work or React render can admit a final save.
    changeRows(current => current.map(item => item.uid === uid ? { ...item, preview: cleared, error: undefined } : item))
    replaceChoices({ ...choicesRef.current, [uid]: initialReviewChoice(cleared) })
    const nextSelections = { ...selectionsRef.current }; if (selected) nextSelections[uid] = selected; else delete nextSelections[uid]; replaceSelections(nextSelections)
    if (!selected) return
    const controller = beginOperation('bind', [uid]), generation = reviewGeneration.current
    if (!controller) return
    try {
      const preview = await scope.request<DovePreview>(`/api/business/dove/${encodeURIComponent(previous.id)}/vehicle`, { method: 'POST', body: selected, signal: controller.signal })
      if (!currentRequest(controller) || generation !== reviewGeneration.current || !reviewIdsRef.current.includes(uid)) return
      changeRows(current => current.map(item => item.uid === uid ? { ...item, preview, error: undefined } : item))
      replaceChoices({ ...choicesRef.current, [uid]: initialReviewChoice(preview) })
    } catch (error) {
      if (!currentRequest(controller) || generation !== reviewGeneration.current) return
      const code = errorCode(error)
      changeRows(current => current.map(item => item.uid === uid ? failedDoveReviewRow(item, code) : item))
      if (['VEHICLE_SELECTION_CHANGED', 'VEHICLE_DELETED', 'RECORD_NOT_FOUND', 'RECORD_ARCHIVED'].includes(code)) { const next = { ...selectionsRef.current }; delete next[uid]; replaceSelections(next) }
    } finally { finishOperation(controller) }
  }
  async function retain() {
    if (disabled || operationRef.current) return
    const currentRows = reviewIdsRef.current.flatMap(id => { const row = rowsRef.current.find(item => item.uid === id); return row && !row.savedId ? [row] : [] })
    const targets = currentRows.filter(row => canRetainDoveRow(row, Date.now()))
    if (!targets.length || targets.some(row => reviewChoiceBlocked(row, choicesRef.current[row.uid], Date.now()))) { setClock(Date.now); return }
    const controller = beginOperation('save', targets.map(row => row.uid))
    if (!controller) return
    try {
      const confirmations = Object.fromEntries(targets.map(row => [row.preview!.id, confirmationForReview(row, choicesRef.current[row.uid], Date.now())]))
      const results = await scope.request<DoveBatchSaveResult[]>('/api/business/dove/save-batch', { method: 'POST', body: { draftIds: targets.map(row => row.preview!.id), confirmations }, signal: controller.signal })
      if (!currentRequest(controller)) return
      const next = applyBatchSaveResults(rowsRef.current, results), nextChoices = { ...choicesRef.current }, nextSelections = { ...selectionsRef.current }
      for (const row of next) {
        const before = rowsRef.current.find(item => item.uid === row.uid)
        if (row.preview && !row.preview.parsed.vin && before?.preview?.manualBinding && !row.preview.manualBinding) nextChoices[row.uid] = initialReviewChoice(row.preview)
        if (row.error && ['MANUAL_BINDING_CHANGED', 'VEHICLE_SELECTION_CHANGED', 'VEHICLE_DELETED', 'RECORD_NOT_FOUND', 'RECORD_ARCHIVED', 'PARENT_ARCHIVED'].includes(row.error)) delete nextSelections[row.uid]
      }
      replaceRows(next); replaceChoices(nextChoices); replaceSelections(nextSelections)
      replaceReviewIds(reviewIdsRef.current.filter(id => !next.find(row => row.uid === id)?.savedId))
      setPartialFailure(results.some(result => result.error !== undefined))
      if (results.some(result => result.record)) { try { await onRetained(scope, controller.signal) } catch (error) { if (currentRequest(controller)) onError(error) } }
    } catch (error) {
      if (!currentRequest(controller)) return
      const failed = new Set(targets.map(row => row.uid)), code = errorCode(error)
      const next = rowsRef.current.map(row => failed.has(row.uid) ? failedDoveReviewRow(row, code) : row), nextChoices = { ...choicesRef.current }, nextSelections = { ...selectionsRef.current }
      for (const row of next) if (failed.has(row.uid) && row.preview && !row.preview.parsed.vin && !row.preview.manualBinding) {
        nextChoices[row.uid] = initialReviewChoice(row.preview)
        if (['MANUAL_BINDING_CHANGED', 'VEHICLE_SELECTION_CHANGED', 'VEHICLE_DELETED', 'RECORD_NOT_FOUND', 'RECORD_ARCHIVED', 'PARENT_ARCHIVED'].includes(code)) delete nextSelections[row.uid]
      }
      replaceRows(next); replaceChoices(nextChoices); replaceSelections(nextSelections); setPartialFailure(true); onError(error)
    } finally { finishOperation(controller) }
  }
  async function openReport(id: string) {
    const controller = beginOperation('open', [])
    if (!controller) return
    try { await onOpenReport(id, scope, controller.signal) } catch (error) { if (currentRequest(controller)) onError(error) }
    finally { finishOperation(controller) }
  }
  function refreshFile(row: ImportRow) { if (disabled || operationRef.current) return; cancelReview(); void parse([row]) }
  const status = (row: ImportRow) => {
    if (activeIds.includes(row.uid)) return <Space><Spin size="small" /><span>{text(operation === 'parse' ? 'parsing' : operation === 'bind' ? 'bindingVehicle' : 'retaining')}</span></Space>
    if (row.savedId) return <Tag color="success">{text('retained')}</Tag>
    if (row.error) return <div className="dove-batch-result"><Tag color="error">{text('failed')}</Tag><span className="dove-batch-error">{errorText(row.error, language)}</span></div>
    if (row.preview && row.preview.expires <= clock) return <Tag color="warning">{text('previewExpired')}</Tag>
    if (row.preview?.existingId) return <Tag color="success">{text('existingReport')}</Tag>
    if (row.preview?.manualBinding) return <Tag className="dove-manual-binding-tag" color="warning">{text('manualVehicleWarning')}</Tag>
    return row.preview ? <Tag color={row.preview.match === 'matched' ? 'success' : 'warning'}>{text(row.preview.match)}</Tag> : <Tag>{text('queued')}</Tag>
  }
  return <div hidden={!active} className="dove-batch-import">
    <div className="dove-upload dove-batch-toolbar"><Upload accept=".xlsx" multiple disabled={locked || rows.length >= DOVE_BATCH_LIMIT} showUploadList={false} beforeUpload={beforeUpload}><Button disabled={locked || rows.length >= DOVE_BATCH_LIMIT} icon={<UploadIcon size={16} />}>{text('chooseFiles')} · .xlsx</Button></Upload>
      <Button type="primary" icon={<FileSpreadsheet size={16} />} loading={operation === 'parse'} disabled={locked || !pending.length} onClick={() => void parse(pending)}>{text('uploadPreviews')}{pending.length ? ` (${pending.length})` : ''}</Button>
      <Button icon={<Check size={16} />} loading={operation === 'save'} disabled={locked || !eligible.length} onClick={() => reviewImport(eligible)}>{text('reviewDoveImport')}{eligible.length ? ` (${eligible.length})` : ''}</Button>
      <Button type="text" disabled={locked || !rows.length} onClick={() => { replaceRows([]); replaceReviewIds([]); replaceSelections({}); setPreviewId(null); setSelectionLimited(false) }}>{text('clearBatch')}</Button><span className="muted">{text('batchLimits')}</span>
    </div>
    {selectionLimited && <Alert className="business-notice" type="warning" showIcon title={text('batchSelectionLimit')} />}
    {rows.length ? <><p className="dove-batch-count">{text('selectedFiles')}: {rows.length} / {DOVE_BATCH_LIMIT}</p><Table<ImportRow> className="dove-batch-table" rowKey="uid" dataSource={rows} size="small" pagination={false} scroll={{ x: 1000 }} columns={[
      { title: text('file'), width: 240, render: (_, row) => <div className="record-title"><button className="inline-link" disabled={locked || !row.preview} onClick={() => setPreviewId(row.uid)}>{row.file.name}</button><small>{(row.file.size / 1024 / 1024).toFixed(2)} MB</small></div> },
      { title: text('sourceVin'), width: 180, render: (_, row) => <span className="mono">{row.preview?.parsed.vin || '—'}</span> },
      { title: text('vehicle'), width: 180, render: (_, row) => <div className="dove-batch-target">{String(row.preview?.vehicle?.data.name || row.preview?.vehicle?.data.vin || '—')}{row.preview?.manualBinding && <small className="mono">{row.preview.manualBinding.vin}</small>}</div> },
      { title: text('status'), width: 250, render: (_, row) => status(row) },
      { title: text('actions'), width: 250, render: (_, row) => { const reportId = row.savedId || row.preview?.existingId; const retry = !row.savedId && !fileError(row.file) && (!row.preview || row.error || row.preview.match !== 'matched' || row.preview.expires <= clock); return <Space wrap size={4}>
        {row.preview && <Button size="small" disabled={locked} onClick={() => setPreviewId(row.uid)}>{text('previewReport')}</Button>}
        {canReviewDoveRow(row, clock) && <Button size="small" disabled={locked} onClick={() => reviewImport([row])}>{text(row.preview && !row.preview.parsed.vin && !row.preview.manualBinding ? 'chooseVehicle' : 'reviewDoveImport')}</Button>}
        {reportId && <Button size="small" disabled={locked} onClick={() => void openReport(reportId)}>{text('openReport')}</Button>}
        {retry && <Button size="small" disabled={locked} icon={<RefreshCw size={13} />} onClick={() => void parse([row])}>{text(row.error || row.preview ? 'retryUpload' : 'upload')}</Button>}
        <Button size="small" type="text" disabled={locked} icon={<Trash2 size={14} />} aria-label={`${text('removeFile')} ${row.file.name}`} onClick={() => { changeRows(current => current.filter(item => item.uid !== row.uid)); if (previewId === row.uid) setPreviewId(null) }} />
      </Space> } },
    ]} /></> : <Empty description={text('draft')} />}
    <Modal className="dove-single-review-modal" open={active && reviewRows.length > 0} title={text('confirmDoveImport')} width={1050} onCancel={cancelReview} footer={<div className="dove-import-review-footer"><div className="dove-import-review-counts" role="status"><span>{text('doveImportReadyCount')}: {importCount}</span><span>{text('doveImportPendingCount')}: {reviewRows.length - importCount}</span></div><Space><Button disabled={operation !== null && operation !== 'bind'} onClick={cancelReview}>{text('cancel')}</Button><Button type="primary" loading={operation === 'save'} disabled={locked || !readyRows.length || confirmationBlocked} onClick={() => void retain()}>{text('confirmDoveImport')} ({importCount})</Button></Space></div>} destroyOnHidden>
      <div className="dove-import-confirmation"><Alert type="info" showIcon title={text('doveImportFinalNotice')} />{partialFailure && <Alert type="warning" showIcon title={text('doveImportPartialFailure')} />}{reviewRows.map(row => {
        const preview = row.preview!, choice = choices[row.uid] || initialReviewChoice(preview), manual = !preview.parsed.vin, bound = Boolean(preview.manualBinding), sources = controllerSources(preview.parsed.controllers)
        const unresolved = keyControllerNames.filter(name => sources.filter(item => keyControllerName(item.controller.name) === name).length > 1 && choice.selections?.[name] === undefined)
        const duplicate = keyControllerNames.some(name => preview.currentControllers.filter(part => keyControllerName(part.data.name) === name).length > 1)
        return <section className="dove-import-confirm-file" data-dove-row={row.uid} key={row.uid}><h3>{row.file.name}</h3>
          <Descriptions size="small" column={{ xs: 1, sm: 2 }} items={[{ key: 'vehicle', label: text('vehicle'), children: String(preview.vehicle?.data.name || '—') }, { key: 'vin', label: text('sourceVin'), children: <span className="mono">{preview.parsed.vin || '—'}</span> }, { key: 'date', label: text('recordedAt'), children: preview.parsed.recordedAt || '—' }, ...(preview.manualBinding ? [{ key: 'targetVin', label: text('manualVehicleTarget'), children: <span className="mono">{preview.manualBinding.vin}</span> }] : [])]} />
          {row.error && <Alert type="error" showIcon title={errorText(row.error, language)} />}
          {manual && <div className="dove-review-vehicle"><Alert type="warning" showIcon title={text(bound ? 'manualVehicleWarning' : 'manual-required')} description={!bound ? text('manualVehicleAssignmentNotice') : undefined} /><Select className="dove-vehicle-assignment-select" showSearch optionFilterProp="label" allowClear aria-label={`${text('chooseVehicle')} ${row.file.name}`} placeholder={text('manualVehicleSearchPlaceholder')} disabled={locked || preview.expires <= clock} value={vehicleSelections[row.uid]?.vehicleId} notFoundContent={text('manualVehicleNoOptions')} options={reviewVehicles.map(vehicle => ({ value: vehicle.id, label: `${vehicle.data.name || '—'} · ${vehicle.data.vin} · ${vehicle.data.plate || '—'}` }))} onChange={id => { const selected = reviewVehicles.find(vehicle => vehicle.id === id); void selectVehicle(row.uid, selected ? { vehicleId: selected.id, expectedVin: String(selected.data.vin) } : undefined, Date.now()) }} />
            {operation === 'bind' && activeIds.includes(row.uid) && <p className="muted"><Spin size="small" /> {text('bindingVehicle')}</p>}
            {!bound && vehicleSelections[row.uid] && preview.expires > clock && <Button size="small" disabled={locked} icon={<RefreshCw size={13} />} onClick={() => void selectVehicle(row.uid, vehicleSelections[row.uid], Date.now())}>{text('doveImportRetryBinding')}</Button>}
            {!bound && <p className="muted">{text('manualVehicleAssignmentPartialNotice')}</p>}
          </div>}
          {row.error && isDoveReviewRefreshError(row.error) && (!manual || preview.expires <= clock) && <Button size="small" disabled={locked} icon={<RefreshCw size={13} />} onClick={() => refreshFile(row)}>{text('doveImportRetryFile')}</Button>}
          <Checkbox checked={!choice.reportOnly} disabled={locked || (manual && !bound) || preview.expires <= clock} onChange={event => updateChoice(row.uid, { reportOnly: !event.target.checked })}>{text('importControllerConfiguration')}</Checkbox>
          {!choice.reportOnly && <>{duplicate && <Alert type="warning" showIcon title={text('duplicateControllerRecords')} />}{unresolved.length > 0 && <Alert type="warning" showIcon title={text('controllerSourceConflict')} description={unresolved.join(', ')} />}
            <Tabs items={keyControllerNames.map(name => { const observations = sources.filter(item => keyControllerName(item.controller.name) === name), selected = observations.find(item => item.index === choice.selections?.[name]), part = preview.currentControllers.find(record => keyControllerName(record.data.name) === name); return { key: name, label: name, children: !observations.length ? <Tag>{text('controllerNotReported')}</Tag> : <><Select className="dove-import-source" aria-label={`${text('source')} ${name}`} value={choice.selections?.[name]} placeholder={text('chooseControllerSource')} disabled={locked || observations.length === 1} onChange={index => updateChoice(row.uid, { selections: { ...choice.selections, [name]: index } })} options={observations.map(({ controller, index }) => ({ value: index, label: `${controller.name} · ${controller.network} · ${controller.serial || '—'} · ${controller.software || '—'} · #${index + 1}` }))} />{selected && <Table rowKey="field" size="small" pagination={false} scroll={{ x: 600 }} dataSource={controllerFields.map(field => ({ field, before: field === 'name' ? name : part?.data[field], after: field === 'name' ? name : selected.controller[field] }))} columns={[{ title: text('name'), width: 180, render: (_, item) => text(item.field) }, { title: text('currentValue'), width: 200, render: (_, item) => <span className="preserve-text">{String(item.before || '—')}</span> }, { title: text('reportValue'), width: 220, render: (_, item) => <span className="preserve-text">{String(item.after || '—')}{item.field !== 'name' && !validControllerValue(item.after) && <Tag>{text('keepCurrentValue')}</Tag>}</span> }]} />}</> } })} />
            {needsOlderDoveReview(preview) && <Alert type="warning" showIcon title={text('olderReport')} description={manual ? text('manualOlderFinalNotice') : <Checkbox checked={choice.allowOlder} disabled={locked} onChange={event => updateChoice(row.uid, { allowOlder: event.target.checked })}>{text('confirmOlderReport')}</Checkbox>} />}
          </>}
          {preview.expires <= clock && <Alert type="warning" title={text('previewExpired')} />}
        </section>
      })}</div>
    </Modal>
    <Modal open={active && Boolean(viewed?.preview)} title={viewed?.file.name} onCancel={() => setPreviewId(null)} footer={null} width={1150} destroyOnHidden>{viewed?.preview && <>{viewed.preview.manualBinding && <Alert className="business-notice" type="warning" showIcon title={text('manualVehicleWarning')} description={`${text('manualVehicleTarget')}: ${viewed.preview.manualBinding.vin}`} />}<Suspense fallback={<Spin />}><ReportViewer key={viewed.preview.id} report={viewed.preview.parsed} language={language} /></Suspense></>}</Modal>
  </div>
}
