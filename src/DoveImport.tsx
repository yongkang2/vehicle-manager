import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import { Alert, Button, Checkbox, Descriptions, Empty, Modal, Select, Space, Spin, Table, Tabs, Tag, Upload } from 'antd'
import type { UploadProps } from 'antd'
import type { RcFile } from 'antd/es/upload/interface'
import { Check, FileSpreadsheet, RefreshCw, Trash2, Upload as UploadIcon } from 'lucide-react'
import { controllerFields, controllerSources, doveRecordedTime, keyControllerName, keyControllerNames, validControllerValue, DOVE_BATCH_LIMIT, DOVE_MAX_FILE_BYTES } from '../shared/business'
import type { BusinessRecord, DoveBatchPreviewResult, DoveBatchSaveResult, DoveImportConfirmation, DovePreview } from '../shared/business'
import { createWorkspaceScope } from './api'
import { translateBusiness } from './business-i18n'
import { errorText } from './i18n'
import type { Language } from './i18n'

const ReportViewer = lazy(() => import('./ReportViewer'))
type ImportRow = { uid: string; file: RcFile; preview?: DovePreview; error?: string; savedId?: string }
type ImportChoice = { reportOnly: boolean; allowOlder: boolean; manualVehicleConfirmed: boolean; selections: DoveImportConfirmation['selections'] }
type VehicleSelection = { vehicleId: string; expectedVin: string }
type Operation = 'parse' | 'save' | 'bind' | 'open'
type DoveRequestScope = ReturnType<typeof createWorkspaceScope>
type Props = {
  active: boolean
  vehicles: BusinessRecord[]
  language: Language
  disabled: boolean
  onBusyChange: (busy: boolean) => void
  onRetained: (scope: DoveRequestScope, signal: AbortSignal) => Promise<void>
  onOpenReport: (id: string, scope: DoveRequestScope, signal: AbortSignal) => Promise<void>
  onError: (error: unknown) => void
}
const fileError = (file: File) => !/\.xlsx$/i.test(file.name) ? 'XLSX_REQUIRED' : file.size > DOVE_MAX_FILE_BYTES ? 'FILE_TOO_LARGE' : undefined
const canRetain = (row: ImportRow, time: number) => Boolean(row.preview?.match === 'matched' && !row.savedId && !row.error && row.preview.expires > time)
const canAssign = (row: ImportRow, time: number) => Boolean(row.preview && !row.preview.parsed.vin && !row.savedId && row.preview.expires > time)
const errorCode = (error: unknown) => error instanceof Error ? error.message : 'SERVER_ERROR'
const retainedKey = (preview: DovePreview) => `${preview.vehicle?.id || ''}:${preview.checksum}`
function failedPreview(row: ImportRow, code: string): DovePreview | undefined {
  if (code === 'DRAFT_EXPIRED') return undefined
  if (row.preview && !row.preview.parsed.vin && ['MANUAL_VEHICLE_REQUIRED', 'MANUAL_BINDING_CHANGED', 'VEHICLE_SELECTION_CHANGED'].includes(code)) return { ...row.preview, vehicle: null, currentControllers: [], manualBinding: undefined, match: 'manual-required', existingId: null }
  return row.preview
}

export default function DoveImport({ active, vehicles, language, disabled, onBusyChange, onRetained, onOpenReport, onError }: Props) {
  const text = translateBusiness(language)
  const [scope] = useState(createWorkspaceScope)
  const mounted = useRef(true), operationRef = useRef<Operation | null>(null), requestController = useRef<AbortController | null>(null)
  const busyCallback = useRef(onBusyChange)
  const [rows, setRows] = useState<ImportRow[]>([])
  const [operation, setOperation] = useState<Operation | null>(null)
  const [activeIds, setActiveIds] = useState<string[]>([])
  const [previewId, setPreviewId] = useState<string | null>(null)
  const [confirmationRows, setConfirmationRows] = useState<ImportRow[]>([])
  const [choices, setChoices] = useState<Record<string, ImportChoice>>({})
  const [assignmentRows, setAssignmentRows] = useState<ImportRow[]>([])
  const [assignmentVehicles, setAssignmentVehicles] = useState<BusinessRecord[]>([])
  const [assignmentSelections, setAssignmentSelections] = useState<Record<string, VehicleSelection>>({})
  const [afterAssignment, setAfterAssignment] = useState<ImportRow[]>([])
  const [selectionLimited, setSelectionLimited] = useState(false)
  const [clock, setClock] = useState(Date.now)
  useEffect(() => { busyCallback.current = onBusyChange }, [onBusyChange])
  useEffect(() => {
    mounted.current = true
    const timer = setInterval(() => setClock(Date.now()), 30000)
    return () => {
      mounted.current = false; clearInterval(timer); requestController.current?.abort(); requestController.current = null
      if (operationRef.current) busyCallback.current(false)
      operationRef.current = null
    }
  }, [])
  const locked = disabled || operation !== null
  const pending = rows.filter(row => !row.savedId && !row.preview && !fileError(row.file))
  const eligible = rows.filter(row => canRetain(row, clock))
  const viewed = rows.find(row => row.uid === previewId)
  function beginOperation(kind: Operation, ids: string[]) {
    if (disabled || operationRef.current || !mounted.current) return null
    const controller = new AbortController()
    operationRef.current = kind; requestController.current = controller
    setOperation(kind); setActiveIds(ids); busyCallback.current(true)
    return controller
  }
  const currentRequest = (controller: AbortController) => {
    if (!mounted.current || requestController.current !== controller || controller.signal.aborted) return false
    try { scope.assertCurrent(controller.signal); return true } catch { return false }
  }
  function finishOperation(controller: AbortController) {
    if (requestController.current !== controller) return
    requestController.current = null; operationRef.current = null; busyCallback.current(false)
    if (mounted.current) { setClock(Date.now); setOperation(null); setActiveIds([]) }
  }
  function reviewImport(candidates: ImportRow[]) {
    const targets = candidates.filter(row => canRetain(row, Date.now()))
    setClock(Date.now)
    setChoices(Object.fromEntries(targets.map(row => {
      const sources = controllerSources(row.preview!.parsed.controllers)
      const selections = Object.fromEntries(keyControllerNames.flatMap(name => { const matches = sources.filter(item => keyControllerName(item.controller.name) === name); return matches.length === 1 ? [[name, matches[0].index]] : [] }))
      return [row.uid, { reportOnly: Boolean(row.preview!.manualBinding), allowOlder: false, manualVehicleConfirmed: false, selections }]
    })))
    setConfirmationRows(targets)
  }
  function chooseVehicles(candidates: ImportRow[], reviewAfter = candidates, afterParsing = false) {
    const targets = candidates.filter(row => canAssign(row, Date.now()))
    setClock(Date.now)
    if (!targets.length || (!afterParsing && (operationRef.current || disabled))) return
    setConfirmationRows([]); setPreviewId(null); setAssignmentRows(targets); setAfterAssignment(reviewAfter); setAssignmentSelections({})
    setAssignmentVehicles(vehicles.filter(vehicle => vehicle.kind === 'vehicle' && !vehicle.archived).map(vehicle => ({ ...vehicle, data: { ...vehicle.data } })))
  }
  const needsOlderConfirmation = (row: ImportRow) => row.preview!.currentControllers.some(part => doveRecordedTime(row.preview!.parsed.recordedAt) < doveRecordedTime(part.data.reportRecordedAt) && controllerSources(row.preview!.parsed.controllers).some(item => keyControllerName(item.controller.name) === keyControllerName(part.data.name)))
  const duplicateControllers = (row: ImportRow) => keyControllerNames.some(name => row.preview!.currentControllers.filter(part => keyControllerName(part.data.name) === name).length > 1)
  const confirmationBlocked = confirmationRows.some(row => {
    const choice = choices[row.uid]
    if (!choice || row.preview!.expires <= clock || (row.preview!.manualBinding && !choice.manualVehicleConfirmed)) return true
    if (choice.reportOnly) return false
    const sources = controllerSources(row.preview!.parsed.controllers)
    return duplicateControllers(row) || (needsOlderConfirmation(row) && !choice.allowOlder) || keyControllerNames.some(name => sources.some(item => keyControllerName(item.controller.name) === name) && !sources.some(item => keyControllerName(item.controller.name) === name && item.index === choice.selections?.[name]))
  })
  const beforeUpload: UploadProps['beforeUpload'] = (file, selection) => {
    if (locked || operationRef.current) return Upload.LIST_IGNORE
    setSelectionLimited(rows.length + selection.length > DOVE_BATCH_LIMIT)
    setRows(current => current.length >= DOVE_BATCH_LIMIT || current.some(row => row.uid === file.uid) ? current : [...current, { uid: file.uid, file, error: fileError(file) }])
    return Upload.LIST_IGNORE
  }
  async function parse(targets: ImportRow[]) {
    if (!targets.length) return
    const controller = beginOperation('parse', targets.map(row => row.uid))
    if (!controller) return
    const ids = new Set(targets.map(row => row.uid))
    const form = new FormData()
    for (const row of targets) form.append('files', row.file)
    setRows(current => current.map(row => ids.has(row.uid) ? { ...row, preview: undefined, error: undefined } : row))
    try {
      const results = await scope.request<DoveBatchPreviewResult[]>('/api/business/dove/preview-batch', { method: 'POST', body: form, signal: controller.signal })
      if (!currentRequest(controller)) return
      const byId = new Map(results.map(result => [targets[result.index].uid, result]))
      setRows(current => current.map(row => {
        const result = byId.get(row.uid)
        return result ? { ...row, preview: result.preview, error: result.error } : row
      }))
      const parsedRows = targets.map(row => { const result = byId.get(row.uid); return { ...row, preview: result?.preview, error: result?.error } })
      const manualRows = parsedRows.filter(row => canAssign(row, Date.now()) && !row.preview?.manualBinding)
      if (manualRows.length) chooseVehicles(manualRows, parsedRows, true)
      else reviewImport(parsedRows)
    } catch (error) {
      if (!currentRequest(controller)) return
      if (!['WORKSPACE_CHANGED', 'LOGIN_REQUIRED'].includes(errorCode(error))) setRows(current => current.map(row => ids.has(row.uid) ? { ...row, error: errorCode(error) } : row))
      onError(error)
    } finally { finishOperation(controller) }
  }
  async function assignVehicles() {
    const targets = assignmentRows.filter(row => canAssign(row, Date.now()) && assignmentSelections[row.uid])
    if (!targets.length) { setClock(Date.now); return }
    const controller = beginOperation('bind', targets.map(row => row.uid))
    if (!controller) return
    const results = new Map<string, ImportRow>()
    try {
      for (const row of targets) {
        try {
          const preview = await scope.request<DovePreview>(`/api/business/dove/${encodeURIComponent(row.preview!.id)}/vehicle`, { method: 'POST', body: assignmentSelections[row.uid], signal: controller.signal })
          if (!currentRequest(controller)) return
          results.set(row.uid, { ...row, preview, error: undefined })
        } catch (error) {
          if (!currentRequest(controller)) return
          const code = errorCode(error)
          if (['WORKSPACE_CHANGED', 'LOGIN_REQUIRED'].includes(code)) throw error
          results.set(row.uid, { ...row, error: code, preview: failedPreview(row, code) })
        }
      }
      if (!currentRequest(controller)) return
      setRows(current => current.map(row => results.get(row.uid) || row))
      setAssignmentRows([]); setAssignmentSelections({})
      reviewImport(afterAssignment.map(row => results.get(row.uid) || row))
    } catch (error) { if (currentRequest(controller)) onError(error) }
    finally { finishOperation(controller) }
  }
  async function retain(candidates: ImportRow[]) {
    if (locked || confirmationBlocked) return
    const targets = candidates.filter(row => canRetain(row, Date.now()))
    if (!targets.length) { setClock(Date.now); return }
    const controller = beginOperation('save', targets.map(row => row.uid))
    if (!controller) return
    try {
      const confirmations = Object.fromEntries(targets.map(row => {
        const preview = row.preview!, { manualVehicleConfirmed, ...choice } = choices[row.uid]
        const versions = Object.fromEntries(keyControllerNames.map(name => { const parts = preview.currentControllers.filter(part => keyControllerName(part.data.name) === name); return [name, parts.length === 1 ? parts[0].version : null] }))
        return [preview.id, { confirmed: true, ...choice, versions, ...(preview.manualBinding ? { bindingToken: preview.manualBinding.token, manualVehicleConfirmed } : {}) }]
      }))
      const results = await scope.request<DoveBatchSaveResult[]>('/api/business/dove/save-batch', { method: 'POST', body: { draftIds: targets.map(row => row.preview!.id), confirmations }, signal: controller.signal })
      if (!currentRequest(controller)) return
      const byDraft = new Map(results.map(result => [result.draftId, result]))
      const retained = new Map<string, string>()
      for (const row of targets) {
        const record = byDraft.get(row.preview!.id)?.record
        if (record) retained.set(retainedKey(row.preview!), record.id)
      }
      setRows(current => current.map(row => {
        const result = row.preview ? byDraft.get(row.preview.id) : undefined
        if (result?.record) return { ...row, savedId: result.record.id, error: undefined }
        if (result?.error) return { ...row, error: result.error, preview: failedPreview(row, result.error) }
        const existingId = row.preview && retained.get(retainedKey(row.preview))
        if (existingId && row.preview) return { ...row, preview: { ...row.preview, existingId }, error: undefined }
        return row
      }))
      if (retained.size) { try { await onRetained(scope, controller.signal) } catch (error) { if (currentRequest(controller)) onError(error) } }
      if (!currentRequest(controller)) return
      setConfirmationRows([])
    } catch (error) {
      if (!currentRequest(controller)) return
      const ids = new Set(targets.map(row => row.uid))
      if (!['WORKSPACE_CHANGED', 'LOGIN_REQUIRED'].includes(errorCode(error))) setRows(current => current.map(row => ids.has(row.uid) ? { ...row, error: errorCode(error), preview: failedPreview(row, errorCode(error)) } : row))
      onError(error)
    } finally { finishOperation(controller) }
  }
  async function openReport(id: string) {
    const controller = beginOperation('open', [])
    if (!controller) return
    try { await onOpenReport(id, scope, controller.signal) } catch (error) { if (currentRequest(controller)) onError(error) }
    finally { finishOperation(controller) }
  }
  const status = (row: ImportRow) => {
    if (activeIds.includes(row.uid)) return <Space><Spin size="small" /><span>{text(operation === 'parse' ? 'parsing' : operation === 'bind' ? 'bindingVehicle' : 'retaining')}</span></Space>
    if (row.error) return <div className="dove-batch-result"><Tag color="error">{text('failed')}</Tag><span className="dove-batch-error">{errorText(row.error, language)}</span></div>
    if (row.savedId) return <Tag color="success">{text('retained')}</Tag>
    if (row.preview && row.preview.expires <= clock) return <div className="dove-batch-result"><Tag color="warning">{text('previewExpired')}</Tag><span className="dove-batch-error">{errorText('DRAFT_EXPIRED', language)}</span></div>
    if (row.preview?.existingId) return <Tag color="success">{text('existingReport')}</Tag>
    if (row.preview?.manualBinding) return <Tag className="dove-manual-binding-tag" color="warning">{text('manualVehicleWarning')}</Tag>
    if (row.preview) return <Tag color={row.preview.match === 'matched' ? 'success' : 'warning'}>{text(row.preview.match)}</Tag>
    return <Tag>{text('queued')}</Tag>
  }
  return <div hidden={!active} className="dove-batch-import">
    <div className="dove-upload dove-batch-toolbar">
      <Upload accept=".xlsx" multiple disabled={locked || rows.length >= DOVE_BATCH_LIMIT} showUploadList={false} beforeUpload={beforeUpload}>
        <Button disabled={locked || rows.length >= DOVE_BATCH_LIMIT} icon={<UploadIcon size={16} />}>{text('chooseFiles')} · .xlsx</Button>
      </Upload>
      <Button type="primary" icon={<FileSpreadsheet size={16} />} loading={operation === 'parse'} disabled={locked || !pending.length} onClick={() => void parse(pending)}>{text('uploadPreviews')}{pending.length ? ` (${pending.length})` : ''}</Button>
      <Button icon={<Check size={16} />} loading={operation === 'save'} disabled={locked || !eligible.length} onClick={() => reviewImport(eligible)}>{text('reviewDoveImport')}{eligible.length ? ` (${eligible.length})` : ''}</Button>
      <Button type="text" disabled={locked || !rows.length} onClick={() => { setRows([]); setPreviewId(null); setConfirmationRows([]); setAssignmentRows([]); setAssignmentSelections({}); setAfterAssignment([]); setSelectionLimited(false) }}>{text('clearBatch')}</Button>
      <span className="muted">{text('batchLimits')}</span>
    </div>
    {selectionLimited && <Alert className="business-notice" type="warning" showIcon title={text('batchSelectionLimit')} />}
    {rows.length ? <><p className="dove-batch-count">{text('selectedFiles')}: {rows.length} / {DOVE_BATCH_LIMIT}</p><Table<ImportRow> className="dove-batch-table" rowKey="uid" dataSource={rows} size="small" pagination={false} scroll={{ x: 1000 }} columns={[
      { title: text('file'), width: 240, render: (_, row) => <div className="record-title"><button className="inline-link" disabled={!row.preview} onClick={() => setPreviewId(row.uid)}>{row.file.name}</button><small>{(row.file.size / 1024 / 1024).toFixed(2)} MB</small></div> },
      { title: text('sourceVin'), width: 180, render: (_, row) => <span className="mono">{row.preview?.parsed.vin || '—'}</span> },
      { title: text('vehicle'), width: 180, render: (_, row) => <div className="dove-batch-target">{String(row.preview?.vehicle?.data.name || row.preview?.vehicle?.data.vin || '—')}{row.preview?.manualBinding && <small className="mono">{row.preview.manualBinding.vin}</small>}</div> },
      { title: text('status'), width: 250, render: (_, row) => status(row) },
      { title: text('actions'), width: 250, render: (_, row) => {
        const reportId = row.savedId || row.preview?.existingId
        const retry = !row.savedId && !fileError(row.file) && (!row.preview || row.error || row.preview.match !== 'matched' || row.preview.expires <= clock)
        return <Space wrap size={4}>
          {row.preview && <Button size="small" disabled={locked} onClick={() => setPreviewId(row.uid)}>{text('previewReport')}</Button>}
          {canAssign(row, clock) && <Button size="small" disabled={locked} onClick={() => chooseVehicles([row])}>{text(row.preview?.manualBinding ? 'changeVehicle' : 'chooseVehicle')}</Button>}
          {canRetain(row, clock) && <Button size="small" disabled={locked} onClick={() => reviewImport([row])}>{text('reviewDoveImport')}</Button>}
          {reportId && <Button size="small" disabled={locked} onClick={() => void openReport(reportId)}>{text('openReport')}</Button>}
          {retry && <Button size="small" disabled={locked} icon={<RefreshCw size={13} />} onClick={() => void parse([row])}>{text(row.error || row.preview ? 'retryUpload' : 'upload')}</Button>}
          <Button size="small" type="text" disabled={locked} icon={<Trash2 size={14} />} aria-label={`${text('removeFile')} ${row.file.name}`} onClick={() => { setRows(current => current.filter(item => item.uid !== row.uid)); if (previewId === row.uid) setPreviewId(null) }} />
        </Space>
      } },
    ]} /></> : <Empty description={text('draft')} />}
    <Modal open={active && assignmentRows.length > 0} title={text('manualVehicleAssignmentTitle')} width={850} onCancel={() => { if (!locked) { setAssignmentRows([]); setAssignmentSelections({}); setAfterAssignment([]) } }} onOk={() => void assignVehicles()} confirmLoading={operation === 'bind'} okText={text('manualVehicleAssignmentConfirm')} cancelText={text('cancel')} okButtonProps={{ disabled: locked || !assignmentRows.some(row => canAssign(row, clock) && assignmentSelections[row.uid]) }} cancelButtonProps={{ disabled: locked }} destroyOnHidden>
      <div className="dove-vehicle-assignment"><Alert type="warning" showIcon title={text('manualVehicleAssignmentNotice')} /><p className="muted">{text('manualVehicleAssignmentPartialNotice')}</p>{assignmentRows.map(row => <section className="dove-vehicle-assignment-file" key={row.uid}>
        <h3>{row.file.name}</h3><p>{text('sourceVin')}: <span className="mono">{row.preview?.parsed.vin || '—'}</span></p>
        {row.error && <Alert type="warning" showIcon title={errorText(row.error, language)} />}
        <Select className="dove-vehicle-assignment-select" showSearch optionFilterProp="label" allowClear aria-label={`${text('chooseVehicle')} ${row.file.name}`} placeholder={text('manualVehicleSearchPlaceholder')} disabled={locked || !canAssign(row, clock)} value={assignmentSelections[row.uid]?.vehicleId} notFoundContent={text('manualVehicleNoOptions')} options={assignmentVehicles.map(vehicle => ({ value: vehicle.id, label: `${vehicle.data.name || '—'} · ${vehicle.data.vin} · ${vehicle.data.plate || '—'}` }))} onChange={id => {
          const vehicle = assignmentVehicles.find(item => item.id === id)
          setAssignmentSelections(current => { const next = { ...current }; if (vehicle) next[row.uid] = { vehicleId: vehicle.id, expectedVin: String(vehicle.data.vin) }; else delete next[row.uid]; return next })
        }} />
        {row.preview && row.preview.expires <= clock && <Alert type="warning" title={text('previewExpired')} />}
      </section>)}</div>
    </Modal>
    <Modal open={active && confirmationRows.length > 0} title={text('confirmDoveImport')} width={1050} onCancel={() => { if (!locked) setConfirmationRows([]) }} onOk={() => void retain(confirmationRows)} confirmLoading={operation === 'save'} okText={text('confirmDoveImport')} cancelText={text('cancel')} okButtonProps={{ disabled: locked || confirmationBlocked }} cancelButtonProps={{ disabled: locked }} destroyOnHidden>
      <div className="dove-import-confirmation">{confirmationRows.map(row => {
        const preview = row.preview!, choice = choices[row.uid]
        const sources = controllerSources(preview.parsed.controllers)
        if (!choice) return null
        const unresolved = keyControllerNames.filter(name => sources.filter(item => keyControllerName(item.controller.name) === name).length > 1 && choice.selections?.[name] === undefined)
        const updateChoice = (update: Partial<ImportChoice>) => setChoices(current => ({ ...current, [row.uid]: { ...current[row.uid], ...update } }))
        return <section className="dove-import-confirm-file" key={row.uid}>
          <h3>{row.file.name}</h3>
          <Descriptions size="small" column={{ xs: 1, sm: 2 }} items={[{ key: 'vehicle', label: text('vehicle'), children: String(preview.vehicle?.data.name || '—') }, { key: 'vin', label: text('sourceVin'), children: <span className="mono">{preview.parsed.vin || '—'}</span> }, { key: 'date', label: text('recordedAt'), children: preview.parsed.recordedAt || '—' }, ...(preview.manualBinding ? [{ key: 'targetVin', label: text('manualVehicleTarget'), children: <span className="mono">{preview.manualBinding.vin}</span> }] : [])]} />
          {preview.manualBinding && <><Alert type="warning" showIcon title={text('manualVehicleWarning')} description={<span className="mono">{preview.manualBinding.vin}</span>} /><Checkbox className="dove-manual-vehicle-confirmation" checked={choice.manualVehicleConfirmed} disabled={locked} onChange={event => updateChoice({ manualVehicleConfirmed: event.target.checked })}>{text('manualVehicleConfirmation')} · <span className="mono">{preview.manualBinding.vin}</span></Checkbox></>}
          <Checkbox checked={!choice.reportOnly} disabled={locked} onChange={event => updateChoice({ reportOnly: !event.target.checked })}>{text('importControllerConfiguration')}</Checkbox>
          {!choice.reportOnly && <>
            {duplicateControllers(row) && <Alert type="warning" showIcon title={text('duplicateControllerRecords')} />}
            {unresolved.length > 0 && <Alert type="warning" showIcon title={text('controllerSourceConflict')} description={unresolved.join(', ')} />}
            <Tabs items={keyControllerNames.map(name => {
              const observations = sources.filter(item => keyControllerName(item.controller.name) === name)
              const selected = observations.find(item => item.index === choice.selections?.[name])
              const part = preview.currentControllers.find(record => keyControllerName(record.data.name) === name)
              return { key: name, label: name, children: !observations.length ? <Tag>{text('controllerNotReported')}</Tag> : <>
                <Select className="dove-import-source" aria-label={`${text('source')} ${name}`} value={choice.selections?.[name]} placeholder={text('chooseControllerSource')} disabled={locked || observations.length === 1} onChange={index => updateChoice({ selections: { ...choice.selections, [name]: index } })} options={observations.map(({ controller, index }) => ({ value: index, label: `${controller.name} · ${controller.network} · ${controller.serial || '—'} · ${controller.software || '—'} · #${index + 1}` }))} />
                {selected && <Table rowKey="field" size="small" pagination={false} scroll={{ x: 600 }} dataSource={controllerFields.map(field => ({ field, before: field === 'name' ? name : part?.data[field], after: field === 'name' ? name : selected.controller[field] }))} columns={[{ title: text('name'), width: 180, render: (_, item) => text(item.field) }, { title: text('currentValue'), width: 200, render: (_, item) => <span className="preserve-text">{String(item.before || '—')}</span> }, { title: text('reportValue'), width: 220, render: (_, item) => <span className="preserve-text">{String(item.after || '—')}{item.field !== 'name' && !validControllerValue(item.after) && <Tag>{text('keepCurrentValue')}</Tag>}</span> }]} />}
              </> }
            })} />
            {needsOlderConfirmation(row) && <Alert type="warning" showIcon title={text('olderReport')} description={<Checkbox checked={choice.allowOlder} disabled={locked} onChange={event => updateChoice({ allowOlder: event.target.checked })}>{text('confirmOlderReport')}</Checkbox>} />}
          </>}
          {preview.expires <= clock && <Alert type="warning" title={text('previewExpired')} />}
        </section>
      })}</div>
    </Modal>
    <Modal open={active && Boolean(viewed?.preview)} title={viewed?.file.name} onCancel={() => setPreviewId(null)} footer={null} width={1150} destroyOnHidden>
      {viewed?.preview && <>{viewed.preview.manualBinding && <Alert className="business-notice" type="warning" showIcon title={text('manualVehicleWarning')} description={`${text('manualVehicleTarget')}: ${viewed.preview.manualBinding.vin}`} />}<Suspense fallback={<Spin />}><ReportViewer key={viewed.preview.id} report={viewed.preview.parsed} language={language} /></Suspense></>}
    </Modal>
  </div>
}
