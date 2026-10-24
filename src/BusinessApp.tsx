import { lazy, Suspense, useEffect, useEffectEvent, useRef, useState } from 'react'
import { App, Alert, Button, Checkbox, Descriptions, Drawer, Empty, Input, Modal, Pagination, Select, Space, Spin, Table, Tabs, Tag, Timeline, Tooltip, Upload } from 'antd'
import { Archive, ArrowUpRight, CarFront, Check, ClipboardCheck, CloudOff, Download, Ellipsis, FileSpreadsheet, FolderSync, GitCompare, Pencil, Plus, RefreshCw, RotateCcw, Search, Trash2, Upload as UploadIcon, Wrench } from 'lucide-react'
import { api, ApiError, download } from './api'
import { errorText } from './i18n'
import type { Language } from './i18n'
import { translateBusiness } from './business-i18n'
import { activeHvBatteries, configurationFields, controllerSources as parsedControllerSources, doveRecordedTime, keyControllerName, keyControllerNames, thermalSystemTypes, validControllerValue, vehicleFields, vehicleHvBatteries } from '../shared/business'
import type { BusinessRecord, Change, Fields, KeyControllerName, QuarantinedOperation, RecordKind, ReportData, RestoreResult, SyncConflict, SyncStatus, VehicleDeletePreview, VehicleDeleteReceipt, VehicleDeleteRequest } from '../shared/business'
import RecordEditor from './RecordEditor'
import DoveImport from './DoveImport'
import CsvExportDialog from './CsvExportDialog'
import ResizableVehicleTable from './ResizableVehicleTable'
import './BusinessApp.css'

const ReportViewer = lazy(() => import('./ReportViewer'))
export type BusinessView = 'vehicles' | 'dove' | 'reports' | 'history' | 'sync' | 'audit'
type AuditEntry = { id: string; actor: string; created: string; action: string; detail: Fields }
type Editor = { kind: RecordKind; record: BusinessRecord | null; vehicleId: string | null; initialName?: string; initialCategory?: 'battery' }
type Action = { record: BusinessRecord; type: 'archive' | 'remove'; archived?: boolean }
type Difference = { key: string; status: string; before: unknown; after: unknown; fields: string[] }
type Comparison = { left: BusinessRecord; right: BusinessRecord; controllers: Difference[]; faults: Difference[] }
type Configuration = { report: BusinessRecord; controllerIndex: number | null; part: BusinessRecord | null; fields: string[]; reason: string; allowOlder: boolean }
type ControllerSlot = { name: KeyControllerName; part: BusinessRecord | null }
const statuses = ['available', 'testing', 'maintenance', 'inactive']
const emptySync: SyncStatus = { phase: 'idle', error: null, pending: 0, conflicts: [], quarantined: 0, lastSync: null, revision: null }
const display = (value: unknown): string => value === null || value === undefined || value === '' ? '—' : typeof value === 'object' ? JSON.stringify(value, null, 2) : String(value)
const reportTime = (record: BusinessRecord) => { const date = doveRecordedTime(record.data.recordedAt); return Number.isFinite(date) ? date : Date.parse(String(record.data.savedAt || record.updated)) }
function controllerSources(report: BusinessRecord) {
  return parsedControllerSources((report.data as unknown as ReportData).parsed.controllers)
}
async function fetchWorkspace(includeAudit = false, includeQuarantined = false) {
  const records = await api<BusinessRecord[]>('/api/business/records')
  const [sync, changes] = await Promise.all([api<SyncStatus>('/api/business/sync'), api<Change[]>('/api/business/history')])
  const audit = includeAudit ? await api<AuditEntry[]>('/api/business/audit') : []
  const quarantined = includeQuarantined ? await api<QuarantinedOperation[]>('/api/business/sync/quarantined') : []
  return { records, sync, changes, audit, quarantined }
}

function DifferenceValue({ value, fields, text }: { value: unknown; fields: string[]; text: (key: string) => string }) {
  if (Array.isArray(value)) return value.length ? <div>{value.map((item, index) => <DifferenceValue key={index} value={item} fields={fields} text={text} />)}</div> : <span>—</span>
  if (!value || typeof value !== 'object') return <span>{display(value)}</span>
  return <Descriptions column={1} size="small" items={Object.entries(value).filter(([key, item]) => item !== '' && (!fields.length || fields.includes(key))).map(([key, item]) => ({ key, label: text(key), children: <span className="preserve-text">{display(item)}</span> }))} />
}

function ConflictForm({ conflict, language, admin, onResolve }: { conflict: SyncConflict; language: Language; admin: boolean; onResolve: (conflict: SyncConflict, choices: Record<string, string>, reason: string) => Promise<void> }) {
  const text = translateBusiness(language), [busy, setBusy] = useState(false)
  return <form className="business-conflict" onSubmit={async event => {
    event.preventDefault(); const values = Object.fromEntries(new FormData(event.currentTarget)) as Record<string, string>; const reason = values.reason; delete values.reason
    setBusy(true); try { await onResolve(conflict, values, reason) } finally { setBusy(false) }
  }}><h3>{conflict.name}</h3>{conflict.fields.map(field => <fieldset key={field}><legend>{text(field)}</legend><div className="conflict-options">{['local', 'shared'].map(side => {
    const state = side === 'local' ? conflict.local : conflict.remote
    return <label key={side}><input type="radio" name={field} value={side} required disabled={side === 'local' && (['_vin', '_parent'].includes(field) || (field === '_permission' && !admin))} /><span><strong>{text(side === 'local' ? 'localValue' : 'sharedValue')}</strong><pre>{field === '_archived' ? text(state?.archived ? 'archived' : 'available') : display(field.startsWith('_') ? state?.data : state?.data[field])}</pre></span></label>
  })}</div></fieldset>)}<label className="standalone-label">{text('reason')}<textarea name="reason" required maxLength={500} rows={2} /></label><div className="conflict-submit"><Button htmlType="submit" type="primary" icon={<Check size={16} />} loading={busy}>{text('resolve')}</Button></div></form>
}

function VehicleDeleteDialog({ vehicle, language, allowed, syncPaused, onCancel, onBusyChange, onDeleted, onError }: { vehicle: BusinessRecord; language: Language; allowed: boolean; syncPaused: boolean; onCancel: () => void; onBusyChange: (busy: boolean) => void; onDeleted: (receipt: VehicleDeleteReceipt) => Promise<void>; onError: (error: unknown) => void }) {
  const text = translateBusiness(language)
  const [preview, setPreview] = useState<VehicleDeletePreview | null>(null), [loading, setLoading] = useState(true), [saving, setSaving] = useState(false)
  const [vin, setVin] = useState(''), [confirmation, setConfirmation] = useState(''), [reason, setReason] = useState(''), [error, setError] = useState<string | null>(null)
  const [requestId, setRequestId] = useState(() => crypto.randomUUID()), [submitted, setSubmitted] = useState<VehicleDeleteRequest | null>(null)
  const [now, setNow] = useState(Date.now)
  const reportError = useEffectEvent(onError)
  useEffect(() => {
    if (!allowed || syncPaused) return
    let active = true
    void Promise.resolve().then(async () => {
      if (!active) return
      setLoading(true); setVin(''); setConfirmation('')
      try { const value = await api<VehicleDeletePreview>(`/api/business/vehicles/${encodeURIComponent(vehicle.id)}/delete-preview`); if (active) setPreview(value) }
      catch (cause) { if (active) { setError(cause instanceof ApiError ? cause.message : 'SERVER_ERROR'); reportError(cause) } }
      finally { if (active) setLoading(false) }
    })
    return () => { active = false }
  }, [vehicle.id, allowed, syncPaused])
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer) }, [])
  const expired = !preview || preview.expires <= now
  const ready = Boolean(allowed && !syncPaused && preview && !loading && (submitted || (!expired && vin === preview.vin && confirmation === 'DELETE' && reason.trim())))
  async function refreshPreview() {
    if (saving || submitted || !allowed || syncPaused) return
    setLoading(true); setPreview(null); setError(null); setVin(''); setConfirmation(''); setRequestId(crypto.randomUUID())
    try { setPreview(await api<VehicleDeletePreview>(`/api/business/vehicles/${encodeURIComponent(vehicle.id)}/delete-preview`)); setNow(Date.now()) }
    catch (cause) { setError(cause instanceof ApiError ? cause.message : 'SERVER_ERROR'); onError(cause) } finally { setLoading(false) }
  }
  async function removeVehicle() {
    if (!ready || !preview || saving) return
    const request: VehicleDeleteRequest = submitted || { previewToken: preview.token, version: preview.version, vin, confirmation, reason: reason.trim(), requestId }
    setSubmitted(request); setSaving(true); setError(null); onBusyChange(true)
    try { await onDeleted(await api<VehicleDeleteReceipt>(`/api/business/vehicles/${encodeURIComponent(vehicle.id)}`, { method: 'DELETE', body: request })) }
    catch (cause) {
      const code = cause instanceof ApiError ? cause.message : 'SERVER_ERROR'
      setError(code)
      if (!['NETWORK_ERROR', 'SERVER_ERROR', 'SHARE_IO_ERROR', 'SHARE_UNAVAILABLE', 'SHARE_BUSY'].includes(code)) {
        setSubmitted(null)
        if (['DELETE_PREVIEW_CHANGED', 'DELETE_PREVIEW_EXPIRED', 'VERSION_CONFLICT', 'DELETE_REQUEST_MISMATCH'].includes(code)) { setPreview(null); setVin(''); setConfirmation('') }
      }
      onError(cause)
    } finally { setSaving(false); onBusyChange(false) }
  }
  return <Modal open title={text('deleteVehicle')} width={700} onCancel={() => { if (!saving) onCancel() }} onOk={() => void removeVehicle()} okText={text(submitted ? 'retryDelete' : 'deletePermanently')} cancelText={text('cancel')} confirmLoading={saving} okButtonProps={{ danger: true, disabled: !ready }} destroyOnHidden>
    <div className="configuration-form"><Alert type="error" showIcon title={text('deleteVehicleWarning')} />
      <p className="operation-name">{display(vehicle.data.name)} · <span className="mono">{display(preview?.vin || vehicle.data.vin)}</span></p>
      {error && <Alert type="warning" showIcon title={submitted ? text('deleteRetryNotice') : errorText(error, language)} />}
      {loading && allowed && !syncPaused ? <Spin /> : preview && <>
        {preview.protocolUpgrade && <Alert type="warning" showIcon title={text('deleteProtocolUpgrade')} />}
        <Descriptions size="small" column={2} title={text('deleteAffectedRecords')} items={Object.entries(preview.counts).map(([kind, count]) => ({ key: kind, label: text(kind), children: count }))} />
        <p className="muted">{text('deletePreviewExpires')}: {new Date(preview.expires).toLocaleTimeString(language === 'zh' ? 'zh-CN' : 'en-GB')}</p>
        {expired && !submitted && <Alert type="warning" showIcon title={text('deletePreviewExpired')} />}
        <label>{text('deleteVinConfirmation')}<Input value={submitted?.vin ?? vin} maxLength={30} disabled={saving || Boolean(submitted)} autoComplete="off" onChange={event => setVin(event.target.value)} /></label>
        <label>{text('deleteWordConfirmation')}<Input value={submitted?.confirmation ?? confirmation} maxLength={20} disabled={saving || Boolean(submitted)} autoComplete="off" onChange={event => setConfirmation(event.target.value)} /></label>
        <label>{text('reason')}<Input.TextArea value={submitted?.reason ?? reason} maxLength={500} rows={3} disabled={saving || Boolean(submitted)} onChange={event => setReason(event.target.value)} /></label>
      </>}
      <Button icon={<RefreshCw size={15} />} loading={loading} disabled={saving || Boolean(submitted) || !allowed || syncPaused} onClick={() => void refreshPreview()}>{text('refreshDeletePreview')}</Button>
      {syncPaused && <Alert type="warning" showIcon title={errorText('CONFIRM_RESUME', language)} />}
      {!allowed && <Alert type="warning" showIcon title={text('deleteRequiresOnlineAdmin')} />}
    </div>
  </Modal>
}

export default function BusinessApp({ view, language, admin, online, syncPaused, onError }: { view: BusinessView; language: Language; admin: boolean; online: boolean; syncPaused: boolean; onError: (error: unknown) => void }) {
  const text = translateBusiness(language), { message } = App.useApp()
  const [records, setRecords] = useState<BusinessRecord[]>([]), [changes, setChanges] = useState<Change[]>([]), [sync, setSync] = useState<SyncStatus>(emptySync)
  const [loading, setLoading] = useState(true), [busy, setBusy] = useState(false), [query, setQuery] = useState(''), [filter, setFilter] = useState<string | undefined>(), [archived, setArchived] = useState(false)
  const [selectedId, setSelectedId] = useState<string | null>(null), [editor, setEditor] = useState<Editor | null>(null), [action, setAction] = useState<Action | null>(null), [actionReason, setActionReason] = useState('')
  const [detailTab, setDetailTab] = useState('overview')
  const [reportId, setReportId] = useState<string | null>(null)
  const [csvExportOpen, setCsvExportOpen] = useState(false)
  const [reportSelection, setReportSelection] = useState<string[]>([]), [comparison, setComparison] = useState<Comparison | null>(null), [configuration, setConfiguration] = useState<Configuration | null>(null)
  const [restoreOpen, setRestoreOpen] = useState(false), [restoreFile, setRestoreFile] = useState<File | null>(null), [confirmation, setConfirmation] = useState(''), [restoreReason, setRestoreReason] = useState(''), [historyPage, setHistoryPage] = useState(1)
  const [attachmentFile, setAttachmentFile] = useState<File | null>(null)
  const [audit, setAudit] = useState<AuditEntry[]>([])
  const [quarantined, setQuarantined] = useState<QuarantinedOperation[]>([]), [deleteVehicle, setDeleteVehicle] = useState<BusinessRecord | null>(null), [deleteReceipt, setDeleteReceipt] = useState<VehicleDeleteReceipt | null>(null)
  const deletedRecordIds = useRef(new Set<string>())
  const [today, setToday] = useState(() => new Date().toISOString().slice(0, 10))
  useEffect(() => { const timer = setInterval(() => setToday(new Date().toISOString().slice(0, 10)), 60000); return () => clearInterval(timer) }, [])
  function acceptWorkspace(result: Awaited<ReturnType<typeof fetchWorkspace>>) {
    setRecords(result.records.filter(record => !deletedRecordIds.current.has(record.id) && !deletedRecordIds.current.has(record.vehicleId || record.id)))
    setSync(result.sync); setChanges(result.changes); setAudit(result.audit); setQuarantined(result.quarantined)
  }
  async function load() {
    try {
      acceptWorkspace(await fetchWorkspace(view === 'audit', view === 'sync'))
    } catch (error) { onError(error) } finally { setLoading(false) }
  }
  const reportInitialError = useEffectEvent(onError)
  useEffect(() => {
    let active = true
    void fetchWorkspace(view === 'audit', view === 'sync').then(result => { if (active) { acceptWorkspace(result); setLoading(false) } }).catch(error => { if (active) { reportInitialError(error); setLoading(false) } })
    return () => { active = false }
  }, [view])
  const periodicLoad = useEffectEvent(async () => {
    if (!editor && !action && !selectedId && !reportId && !configuration && !comparison && !restoreOpen && !deleteVehicle && !csvExportOpen && !busy && document.visibilityState === 'visible' && !document.activeElement?.matches('input,textarea,select')) await load()
  })
  useEffect(() => { const timer = setInterval(() => { void periodicLoad() }, 30000); return () => clearInterval(timer) }, [])
  const selected = records.find(record => record.id === selectedId) || null
  const openVehicle = (id: string, tab = 'overview') => { setSelectedId(id); setDetailTab(tab); setHistoryPage(1) }
  const activeReport = records.find(record => record.id === reportId) || null
  const cars = records.filter(record => record.kind === 'vehicle')
  const reports = records.filter(record => record.kind === 'report').sort((left, right) => reportTime(right) - reportTime(left) || right.updated.localeCompare(left.updated))
  const vehicleName = (id: string | null) => cars.find(car => car.id === id)?.data.name || id || '—'
  const date = (value: string) => value ? new Date(value).toLocaleString(language === 'zh' ? 'zh-CN' : 'en-GB') : '—'
  const statusTag = (value: string) => <Tag color={{ available: 'success', testing: 'processing', maintenance: 'warning', inactive: 'default' }[value]}>{text(value)}</Tag>
  const openAction = (record: BusinessRecord, type: Action['type']) => { setAction({ record, type, archived: !record.archived }); setActionReason('') }
  async function vehicleDeleted(receipt: VehicleDeleteReceipt) {
    const affected = new Set([receipt.vehicleId, ...receipt.recordIds])
    for (const id of affected) deletedRecordIds.current.add(id)
    const belongs = (record: BusinessRecord) => affected.has(record.id) || record.vehicleId === receipt.vehicleId
    setRecords(current => current.filter(record => !belongs(record)))
    setSelectedId(current => current && affected.has(current) ? null : current)
    setReportId(current => current && affected.has(current) ? null : current)
    setReportSelection(current => current.filter(id => !affected.has(id)))
    setEditor(current => current && (current.vehicleId === receipt.vehicleId || (current.record && belongs(current.record))) ? null : current)
    setAction(current => current && belongs(current.record) ? null : current)
    setComparison(current => current && (belongs(current.left) || belongs(current.right)) ? null : current)
    setConfiguration(current => current && (belongs(current.report) || (current.part && belongs(current.part))) ? null : current)
    if (selectedId === receipt.vehicleId) setAttachmentFile(null)
    setDeleteVehicle(null); setDeleteReceipt(receipt); setHistoryPage(1)
    await load()
    if (receipt.localSynced) void message.success(text('vehicleDeleted'))
    else void message.warning(text('deleteCommittedPending'), 8)
  }
  async function saveRecord(data: Fields, reason: string) {
    if (!editor) return
    setBusy(true)
    try {
      await api(`/api/business/records${editor.record ? `/${editor.record.id}` : ''}`, { method: editor.record ? 'PUT' : 'POST', body: { kind: editor.kind, vehicleId: editor.vehicleId, data, reason, version: editor.record?.version } })
      setEditor(null); await load(); void message.success(text('saved'))
    } catch (error) { onError(error) } finally { setBusy(false) }
  }
  async function applyAction() {
    if (!action || !actionReason.trim()) return
    setBusy(true)
    try {
      const record = action.record
      await api(`/api/business/records/${record.id}${action.type === 'archive' ? '/archive' : ''}`, { method: action.type === 'archive' ? 'POST' : 'PUT', body: { data: { ...record.data, removedAt: today }, archived: action.archived, version: record.version, reason: actionReason } })
      setAction(null); await load(); void message.success(text('saved'))
    } catch (error) { onError(error) } finally { setBusy(false) }
  }
  async function saveFile(vehicleId: string) {
    if (!attachmentFile) return
    const form = new FormData(); form.append('file', attachmentFile)
    setBusy(true)
    try { await api(`/api/business/vehicles/${vehicleId}/attachments`, { method: 'POST', body: form }); setAttachmentFile(null); await load(); void message.success(text('saved')) }
    catch (error) { onError(error) } finally { setBusy(false) }
  }
  async function compare() {
    setBusy(true)
    try { setComparison(await api<Comparison>(`/api/business/reports/compare?left=${encodeURIComponent(reportSelection[0])}&right=${encodeURIComponent(reportSelection[1])}`)) }
    catch (error) { onError(error) } finally { setBusy(false) }
  }
  async function applyConfiguration() {
    if (!configuration || configuration.controllerIndex === null) return
    setBusy(true)
    try {
      await api(`/api/business/reports/${configuration.report.id}/configuration`, { method: 'POST', body: { reportVersion: configuration.report.version, reason: configuration.reason, allowOlder: configuration.allowOlder, selections: [{ controllerIndex: configuration.controllerIndex, partId: configuration.part?.id || null, version: configuration.part?.version, fields: configuration.fields }] } })
      setConfiguration(null); await load(); void message.success(text('saved'))
    } catch (error) { onError(error) } finally { setBusy(false) }
  }
  function chooseController(report: BusinessRecord, controllerIndex: number | null, target?: BusinessRecord) {
    const controller = controllerIndex === null ? null : (report.data as unknown as ReportData).parsed.controllers[controllerIndex]
    const name = keyControllerName(controller?.name)
    const matches = records.filter(record => record.kind === 'part' && record.vehicleId === report.vehicleId && record.data.category === 'controller' && !record.archived && keyControllerName(record.data.name) === name)
    const part = target || (matches.length === 1 ? matches[0] : null)
    setConfiguration({ report, controllerIndex, part, fields: controller ? configurationFields.filter(field => validControllerValue(controller[field]) && controller[field] !== part?.data[field]) : [], reason: '', allowOlder: false })
  }
  function openConfiguration(report: BusinessRecord, name?: string, target?: BusinessRecord) {
    const sources = controllerSources(report)
    const candidates = name ? sources.filter(item => keyControllerName(item.controller.name) === keyControllerName(name)) : sources
    const first = candidates[0]
    const conflicting = first && keyControllerName(first.controller.name) && candidates.filter(item => keyControllerName(item.controller.name) === keyControllerName(first.controller.name)).length > 1
    chooseController(report, !first || conflicting ? null : first.index, target)
  }
  async function synchronize() {
    setBusy(true)
    try { const state = await api<SyncStatus>('/api/business/sync', { method: 'POST' }); setSync(state); await load(); if (state.error) onError(new ApiError(state.error)); else { if (state.phase === 'ready') setDeleteReceipt(null); void message.success(text(state.conflicts.length ? 'conflict' : 'synced')) } }
    catch (error) { onError(error) } finally { setBusy(false) }
  }
  async function restore() {
    if (syncPaused) { onError(new ApiError('CONFIRM_RESUME')); return }
    if (!restoreFile) return
    const form = new FormData(); form.append('file', restoreFile); form.append('confirmation', confirmation); form.append('reason', restoreReason)
    setBusy(true)
    try {
      const result = await api<RestoreResult>('/api/business/restore', { method: 'POST', body: form })
      setRestoreOpen(false); setRestoreFile(null); setConfirmation(''); setRestoreReason(''); await load()
      if (result.syncError) void message.warning(`${text('restoredBackup')} · ${errorText(result.syncError, language)}`, 8)
      else if (result.skippedVehicles || result.skippedRecords) void message.warning(`${text('restoredBackup')} · ${text('skippedVehicles')}: ${result.skippedVehicles} · ${text('skippedRecords')}: ${result.skippedRecords}`, 8)
      else void message.success(text('restoredBackup'))
    }
    catch (error) { onError(error) } finally { setBusy(false) }
  }
  const downloadFile = (record: BusinessRecord) => { void download(`/api/business/files/${record.id}`, String(record.data.name)).catch(onError) }
  const recordActions = (record: BusinessRecord) => <Space size={3}>
    {!record.archived && !['report', 'attachment'].includes(record.kind) && <Tooltip title={text('edit')}><Button type="text" icon={<Pencil size={15} />} aria-label={`${text('edit')} ${record.data.name}`} onClick={() => setEditor({ kind: record.kind, record, vehicleId: record.vehicleId })} /></Tooltip>}
    {!record.archived && ['part', 'equipment'].includes(record.kind) && !record.data.removedAt && <Tooltip title={text('recordRemoval')}><Button type="text" icon={<Wrench size={15} />} aria-label={text('recordRemoval')} onClick={() => openAction(record, 'remove')} /></Tooltip>}
    {admin && <Tooltip title={text(record.archived ? 'restore' : 'archive')}><Button type="text" disabled={!online} icon={record.archived ? <RotateCcw size={15} /> : <Archive size={15} />} aria-label={`${text(record.archived ? 'restore' : 'archive')} ${record.data.name}`} onClick={() => openAction(record, 'archive')} /></Tooltip>}
    {admin && record.kind === 'vehicle' && record.archived && <Tooltip title={syncPaused ? errorText('CONFIRM_RESUME', language) : text('deleteVehicle')}><Button type="text" danger disabled={!online || busy || syncPaused} icon={<Trash2 size={15} />} aria-label={`${text('deleteVehicle')} ${record.data.vin}`} onClick={() => setDeleteVehicle(record)}>{text('delete')}</Button></Tooltip>}
  </Space>
  const reportTable = (items: BusinessRecord[], selectable = false) => <Table<BusinessRecord> rowKey="id" dataSource={items} size="small" loading={loading} scroll={{ x: 800 }} pagination={{ pageSize: 10, hideOnSinglePage: true }} rowSelection={selectable ? { selectedRowKeys: reportSelection, onChange: keys => setReportSelection(keys.map(String).slice(-2)) } : undefined} columns={[
    { title: text('file'), width: 280, render: (_, record) => <button className="record-link" onClick={() => setReportId(record.id)}><FileSpreadsheet size={17} /><span>{display(record.data.name)}{record.archived && <small>{text('archived')}</small>}</span></button> },
    { title: text('vehicle'), width: 150, render: (_, record) => display(vehicleName(record.vehicleId)) }, { title: text('recordedAt'), width: 160, render: (_, record) => display(record.data.recordedAt) },
    { title: text('savedAt'), width: 170, render: (_, record) => date(String(record.data.savedAt || record.updated)) }, { title: text('actions'), width: 110, render: (_, record) => <Space><Tooltip title={text('download')}><Button type="text" icon={<Download size={16} />} aria-label={text('download')} onClick={() => downloadFile(record)} /></Tooltip>{recordActions(record)}</Space> },
  ]} />
  const matchedReports = (vehicle: BusinessRecord) => reports.filter(report => report.vehicleId === vehicle.id && !report.archived && (report.data as unknown as ReportData).parsed.vin === vehicle.data.vin && controllerSources(report).length > 0)
  const controllerTable = (vehicle: BusinessRecord, editable: boolean) => {
    const slots: ControllerSlot[] = keyControllerNames.map(name => ({ name, part: records.find(record => record.kind === 'part' && record.vehicleId === vehicle.id && !record.archived && record.data.category === 'controller' && keyControllerName(record.data.name) === name) || null }))
    const available = matchedReports(vehicle)
    return <div className="vehicle-controller-section"><div className="section-toolbar"><h3>{text(editable ? 'parts' : 'controllers')}</h3>{editable && <Tooltip title={!available.length ? text('noMatchedReports') : text('updateConfiguration')}><Button icon={<ClipboardCheck size={15} />} disabled={vehicle.archived || !available.length} onClick={() => openConfiguration(available[0])}>{text('updateConfiguration')}</Button></Tooltip>}</div>
      <Table<ControllerSlot> rowKey="name" className="controller-summary-table" dataSource={slots} size="small" pagination={false} scroll={{ x: 700 }} columns={[
        { title: text('name'), width: 110, render: (_, slot) => <strong>{slot.name}</strong> },
        ...(['supplier', 'productPart', 'calibrationPart', 'calibrationVersion'] as const).map(field => ({ title: text(field === 'calibrationPart' ? 'softwarePart' : field), width: field === 'calibrationVersion' ? 110 : 150, render: (_: unknown, slot: ControllerSlot) => <span className="preserve-text">{display(slot.part?.data[field])}</span> })),
        { title: text('more'), width: 65, render: (_, slot) => <Tooltip title={text('more')}><Button type="text" icon={<Ellipsis size={17} />} aria-label={`${text('more')} ${slot.name}`} onClick={() => setEditor({ kind: 'part', record: slot.part, vehicleId: vehicle.id, initialName: slot.name })} /></Tooltip> },
      ]} />
    </div>
  }
  const hvBatteryTable = (vehicle: BusinessRecord) => <div className="vehicle-hv-battery-section">
    <div className="section-toolbar"><h3>{text('hvBattery')}</h3><Button icon={<Plus size={15} />} disabled={vehicle.archived} onClick={() => setEditor({ kind: 'part', vehicleId: vehicle.id, record: null, initialCategory: 'battery' })}>{text('addHvBattery')}</Button></div>
    {activeHvBatteries(records, vehicle.id).length > 1 && <Alert className="business-notice" type="warning" showIcon title={text('multipleHvBatteries')} />}
    <Table<BusinessRecord> rowKey="id" className="hv-battery-table" dataSource={vehicleHvBatteries(records, vehicle.id, archived)} size="small" scroll={{ x: 820 }} pagination={{ pageSize: 8, hideOnSinglePage: true }} columns={[
      { title: text('partNumber'), width: 190, render: (_, record) => <span className="preserve-text">{display(record.data.productPart)}</span> },
      { title: text('serialNumber'), width: 190, render: (_, record) => <span className="preserve-text">{display(record.data.serial)}</span> },
      { title: text('partMaturityLevel'), width: 180, render: (_, record) => <span className="preserve-text">{display(record.data.maturity)}</span> },
      { title: text('status'), width: 130, render: (_, record) => record.archived ? text('archived') : record.data.removedAt ? `${text('removed')} · ${record.data.removedAt}` : text('installed') },
      { title: text('actions'), width: 130, render: (_, record) => recordActions(record) },
    ]} />
  </div>
  const entryTable = (kind: RecordKind, vehicle: BusinessRecord) => {
    const items = records.filter(record => record.kind === kind && record.vehicleId === vehicle.id && (!record.archived || archived))
    return <><div className="section-toolbar"><h3>{text(kind === 'modification' ? 'modifications' : kind)}</h3><Button icon={<Plus size={15} />} disabled={vehicle.archived} onClick={() => setEditor({ kind, vehicleId: vehicle.id, record: null })}>{text('addEntry')}</Button></div><Table<BusinessRecord> rowKey="id" dataSource={items} size="small" scroll={{ x: 760 }} pagination={{ pageSize: 8, hideOnSinglePage: true }} columns={[
      { title: text('name'), width: 160, render: (_, record) => <div className="record-title">{display(record.data.name)}</div> },
      { title: text('description'), width: 300, render: (_, record) => <span className="preserve-text">{display(record.data.description)}</span> },
      { title: text('status'), width: 120, render: (_, record) => record.archived ? text('archived') : record.data.removedAt ? `${text('removed')} · ${record.data.removedAt}` : text('installed') },
      { title: text('actions'), width: 130, render: (_, record) => recordActions(record) },
    ]} expandable={{ expandedRowRender: record => <Descriptions column={{ xs: 1, sm: 2 }} size="small" items={Object.entries(record.data).filter(([, value]) => value !== '').map(([key, value]) => ({ key, label: text(key), children: <span className="preserve-text">{display(value)}</span> }))} /> }} /></>
  }
  const history = (items: Change[]) => !items.length ? <Empty description={text('noRecords')} /> : <>
    <Timeline items={items.slice((historyPage - 1) * 20, historyPage * 20).map(change => ({ color: 'gray', content: <div className="change-entry">
      <div><strong>{change.actor.name}</strong><span>{text(change.action === 'updated' ? 'updatedAction' : change.action)} · {text(change.kind === 'part' && (change.after.category || change.before?.category) === 'battery' ? 'hvBattery' : change.kind)}</span><time>{date(change.created)}</time></div>
      <p>{change.reason}</p>
      {['deleted', 'vehicle.deleted'].includes(change.action) && <p className="mono">VIN: {display(change.after.vin || change.before?.vin)}</p>}
      <small className="mono">{text('device')}: {change.actor.deviceId.slice(0, 12)}{change.sourceId && <> · {records.some(record => record.id === change.sourceId && record.kind === 'report') ? <button className="inline-link" onClick={() => setReportId(change.sourceId)}>{text('source')}</button> : <span>{text('sourceUnavailable')}</span>}</>}</small>
      <details><summary>{text('details')}</summary><div className="change-diff">{Object.keys(change.after).filter(key => JSON.stringify(change.before?.[key]) !== JSON.stringify(change.after[key])).map(key => <div key={key}><strong>{text(key)}</strong><del>{display(change.before?.[key])}</del><span>→</span><ins>{display(change.after[key])}</ins></div>)}{change.archivedBefore !== change.archivedAfter && <div><strong>{text('status')}</strong><del>{change.archivedBefore ? text('archived') : '—'}</del><span>→</span><ins>{change.archivedAfter ? text('archived') : text('restored')}</ins></div>}</div></details>
    </div> }))} />
    <Pagination current={historyPage} onChange={setHistoryPage} total={items.length} pageSize={20} showSizeChanger={false} hideOnSinglePage />
  </>

  const filters = <div className="business-filters"><Input prefix={<Search size={15} />} value={query} onChange={event => setQuery(event.target.value)} placeholder={text('search')} aria-label={text('search')} allowClear />{view === 'vehicles' && <Select allowClear placeholder={text('status')} value={filter} onChange={setFilter} options={statuses.map(value => ({ value, label: text(value) }))} />}<Checkbox checked={archived} onChange={event => setArchived(event.target.checked)}>{text('showArchived')}</Checkbox></div>
  const selectedController = configuration?.controllerIndex !== null && configuration?.controllerIndex !== undefined ? (configuration.report.data as unknown as ReportData).parsed.controllers[configuration.controllerIndex] : null
  const targetParts = configuration && selectedController ? records.filter(record => record.kind === 'part' && record.vehicleId === configuration.report.vehicleId && record.data.category === 'controller' && !record.archived && keyControllerName(record.data.name) === keyControllerName(selectedController.name)) : []
  const olderReport = Boolean(configuration?.part && doveRecordedTime(configuration.report.data.recordedAt) < doveRecordedTime(configuration.part.data.reportRecordedAt))
  const duplicateTarget = targetParts.length > 1
  const conflictingSources = configuration ? controllerSources(configuration.report).filter(item => keyControllerName(item.controller.name) && controllerSources(configuration.report).filter(other => keyControllerName(other.controller.name) === keyControllerName(item.controller.name)).length > 1) : []
  return <section className="business-workspace"><div className="page-heading"><div><span className="eyebrow">{text(view).toUpperCase()}</span><h1>{text(view)}</h1></div><Space wrap><Tooltip title={text('refresh')}><Button icon={<RefreshCw size={16} />} aria-label={text('refresh')} loading={loading} onClick={() => void load()} /></Tooltip>{view === 'vehicles' && <Button type="primary" icon={<Plus size={16} />} onClick={() => setEditor({ kind: 'vehicle', vehicleId: null, record: null })}>{text('addVehicle')}</Button>}{view === 'sync' && <Button type="primary" loading={busy} icon={<FolderSync size={16} />} onClick={() => void synchronize()}>{text('syncNow')}</Button>}</Space></div>
    {(sync.error || sync.pending > 0 || sync.conflicts.length > 0 || sync.quarantined > 0) && view !== 'sync' && <Alert className="business-notice" type="warning" showIcon title={sync.error ? errorText(sync.error, language) : `${text('pending')}: ${sync.pending} · ${text('conflicts')}: ${sync.conflicts.length} · ${text('quarantined')}: ${sync.quarantined}`} />}
    {deleteReceipt && !deleteReceipt.localSynced && <Alert className="business-notice" type="warning" showIcon title={text('deleteCommittedPending')} />}
    {view === 'vehicles' && <><div className="fleet-stats"><div><span>{text('vehicles')}</span><strong>{cars.filter(car => !car.archived).length}</strong></div>{statuses.slice(0, 3).map(status => <div key={status}><span>{text(status)}</span><strong>{cars.filter(car => !car.archived && car.data.status === status).length}</strong></div>)}</div><div className="section-toolbar"><h3>{text('vehicles')}</h3><Space wrap><Button icon={<FileSpreadsheet size={15} />} onClick={() => setCsvExportOpen(true)}>{text('exportCsv')}</Button><Button type="text" icon={<Download size={15} />} onClick={() => void download('/api/business/export', 'vehicle-data.json').catch(onError)}>{text('export')}</Button>{admin && <><Button icon={<Download size={15} />} disabled={!online} onClick={() => void download('/api/business/backup', `vehicle-backup-${new Date().toISOString().slice(0, 10)}.zip`).catch(onError)}>{text('backup')}</Button><Tooltip title={syncPaused ? errorText('CONFIRM_RESUME', language) : undefined}><Button icon={<RotateCcw size={15} />} disabled={!online || syncPaused} onClick={() => setRestoreOpen(true)}>{text('restoreBackup')}</Button></Tooltip></>}</Space></div>{filters}<ResizableVehicleTable language={language} rowKey="id" loading={loading} size="middle" pagination={{ pageSize: 10, hideOnSinglePage: true }} dataSource={cars.filter(car => (archived || !car.archived) && (!filter || car.data.status === filter) && Object.values(car.data).join(' ').toLowerCase().includes(query.toLowerCase()))} columns={[
      { key: 'vehicle', title: text('vehicle'), width: 250, fixed: 'left', render: (_, record) => <button className="record-link" onClick={() => openVehicle(record.id)}><span className="car-symbol"><CarFront size={21} /></span><span><strong>{display(record.data.name)}</strong><small className="mono">{display(record.data.vin)}</small></span></button> },
      { key: 'project', title: text('project'), width: 100, render: (_, record) => display(record.data.project) }, { key: 'plate', title: text('plate'), width: 140, render: (_, record) => <div className="record-title">{display(record.data.plate)}<small className={record.data.plateExpiry && String(record.data.plateExpiry) < today ? 'expired-date' : ''}>{display(record.data.plateExpiry)}</small></div> },
      { key: 'status', title: text('status'), width: 110, render: (_, record) => record.archived ? <Tag>{text('archived')}</Tag> : statusTag(String(record.data.status)) },
      { key: 'physicalLocation', title: text('physicalLocation'), width: 180, ellipsis: { showTitle: false }, render: (_, record) => <Tooltip title={display(record.data.physicalLocation)}><span>{display(record.data.physicalLocation)}</span></Tooltip> },
      { key: 'hvBatteryMaturityLevel', title: text('hvBatteryMaturityLevel'), width: 220, ellipsis: { showTitle: false }, render: (_, record) => {
        const maturity = activeHvBatteries(records, record.id).map(battery => display(battery.data.maturity)).join(' / ') || '—'
        return <Tooltip title={maturity}><button className="inline-link hv-battery-maturity-link" aria-label={`${text('hvBatteryMaturityLevel')} ${record.data.vin}`} onClick={() => openVehicle(record.id, 'hvBattery')}>{maturity}</button></Tooltip>
      } },
      { key: 'owner', title: text('owner'), width: 130, render: (_, record) => display(record.data.owner) },
      { key: 'latestDove', title: text('latestDove'), width: 150, render: (_, record) => { const report = reports.find(item => item.vehicleId === record.id && !item.archived); return report ? <button className="inline-link" onClick={() => setReportId(report.id)}>{display(report.data.recordedAt)}</button> : '—' } },
      { key: 'updated', title: text('updated'), width: 160, render: (_, record) => <div className="record-title">{date(record.updated)}<small>v{record.version}</small></div> }, { key: 'actions', title: text('actions'), width: 100, render: (_, record) => <Button type="text" icon={<ArrowUpRight size={17} />} aria-label={`${text('details')} ${record.data.name}`} onClick={() => openVehicle(record.id)} /> },
    ]} /></>}
    <DoveImport active={view === 'dove'} language={language} disabled={busy} onBusyChange={setBusy} onRetained={load} onOpenReport={async id => { await load(); setReportId(id) }} onError={onError} />
    {view === 'reports' && <>{filters}<div className="section-toolbar"><span className="muted">{reportSelection.length} / 2</span><Button icon={<GitCompare size={16} />} disabled={reportSelection.length !== 2} loading={busy} onClick={() => void compare()}>{text('compare')}</Button></div>{reportTable(reports.filter(record => (archived || !record.archived) && `${record.data.name} ${vehicleName(record.vehicleId)} ${(record.data as unknown as ReportData).parsed.vin}`.toLowerCase().includes(query.toLowerCase())), true)}</>}
    {view === 'history' && history(changes)}
    {view === 'audit' && <><div className="business-filters"><Input prefix={<Search size={15} />} placeholder={text('search')} value={query} onChange={event => setQuery(event.target.value)} /></div><Table<AuditEntry> rowKey="id" size="small" dataSource={audit.filter(entry => `${entry.actor} ${text(entry.action)} ${JSON.stringify(entry.detail)}`.toLowerCase().includes(query.toLowerCase()))} scroll={{ x: 650 }} pagination={{ pageSize: 15 }} columns={[{ title: text('created'), width: 180, render: (_, entry) => date(entry.created) }, { title: text('actor'), width: 150, dataIndex: 'actor' }, { title: text('actions'), width: 180, render: (_, entry) => text(entry.action) }, { title: text('details'), render: (_, entry) => <details><summary>{text('details')}</summary><Descriptions column={1} size="small" items={Object.entries(entry.detail).map(([key, value]) => ({ key, label: text(key), children: display(value) }))} /></details> }]} /></>}
    {view === 'sync' && <>
      <Alert type={sync.error || sync.conflicts.length || sync.quarantined ? 'warning' : 'success'} showIcon icon={sync.error ? <CloudOff size={18} /> : undefined} title={sync.error ? errorText(sync.error, language) : text(sync.phase)} />
      <Descriptions className="sync-summary" column={{ xs: 1, sm: 2 }} items={[{ key: 'pending', label: text('pending'), children: sync.pending }, { key: 'conflicts', label: text('conflicts'), children: sync.conflicts.length }, { key: 'quarantined', label: text('quarantined'), children: sync.quarantined }, { key: 'lastSync', label: text('lastSync'), children: sync.lastSync ? date(sync.lastSync) : '—' }, { key: 'revision', label: text('revision'), children: <span className="mono">{sync.revision || '—'}</span> }]} />
      <h3 className="sync-title">{text('conflicts')}</h3>
      {sync.conflicts.length ? sync.conflicts.map(conflict => <ConflictForm key={conflict.token} conflict={conflict} language={language} admin={admin} onResolve={async (item, choices, reason) => { try { setSync(await api<SyncStatus>(`/api/business/sync/${item.recordId}/resolve`, { method: 'POST', body: { token: item.token, choices, reason } })); await load() } catch (error) { onError(error) } }} />) : <Empty description={text('noRecords')} />}
      <div className="section-toolbar"><h3>{text('quarantined')}</h3><Button icon={<Download size={15} />} disabled={!quarantined.length} onClick={() => void download('/api/business/sync/quarantined/export', 'quarantined-operations.json').catch(onError)}>{text('exportQuarantined')}</Button></div>
      {quarantined.length > 0 && <Alert className="business-notice" type="warning" showIcon title={text('quarantinedNotice')} />}
      <Table<QuarantinedOperation> rowKey="id" size="small" dataSource={quarantined} scroll={{ x: 800 }} pagination={{ pageSize: 10, hideOnSinglePage: true }} columns={[
        { title: text('quarantinedAt'), width: 180, render: (_, entry) => date(entry.quarantinedAt) },
        { title: text('vehicle'), width: 180, render: (_, entry) => <span className="mono">{display(entry.operation.desired.data.vin || entry.vehicleId)}</span> },
        { title: text('record'), width: 180, render: (_, entry) => <div className="record-title">{display(entry.operation.desired.data.name || entry.operation.recordId)}<small>{text(entry.operation.kind)}</small></div> },
        { title: text('quarantineReason'), width: 240, render: (_, entry) => errorText(entry.reason, language) },
        { title: text('details'), render: (_, entry) => <details><summary>{text('details')}</summary><pre className="quarantined-operation-data">{JSON.stringify(entry.operation, null, 2)}</pre></details> },
      ]} />
    </>}

    <Drawer className="vehicle-detail-drawer" open={Boolean(selected)} onClose={() => setSelectedId(null)} title={selected ? display(selected.data.name) : ''} size={1000} destroyOnHidden extra={selected && recordActions(selected)}><Tabs className="vehicle-detail-tabs" activeKey={detailTab} onChange={setDetailTab} items={selected ? [
      { key: 'overview', label: text('overview'), children: <div className="vehicle-overview"><Descriptions column={{ xs: 1, sm: 2 }} items={vehicleFields.map(key => ({ key, label: text(key === 'name' ? 'nickName' : key), children: <span className="preserve-text">{key === 'status' ? statusTag(String(selected.data[key])) : key === 'thermal' && thermalSystemTypes.some(value => value === selected.data[key]) ? text(String(selected.data[key])) : display(selected.data[key])}</span> }))} /><div className="drawer-version">v{selected.version} · {date(selected.updated)}</div></div> },
      { key: 'parts', label: text('parts'), children: controllerTable(selected, true) },
      { key: 'hvBattery', label: text('hvBattery'), children: hvBatteryTable(selected) },
      { key: 'modifications', label: text('modifications'), children: entryTable('modification', selected) }, { key: 'equipment', label: text('equipment'), children: entryTable('equipment', selected) },
      { key: 'reports', label: text('reports'), children: reportTable(reports.filter(record => record.vehicleId === selected.id && (!record.archived || archived))) },
      { key: 'attachments', label: text('attachments'), children: <><div className="dove-upload"><Upload accept=".xlsx,.xls,.pdf,.png,.jpg,.jpeg" maxCount={1} beforeUpload={value => { setAttachmentFile(value); return false }} onRemove={() => setAttachmentFile(null)}><Button icon={<Plus size={15} />}>{text('chooseFile')}</Button></Upload><Button type="primary" disabled={!attachmentFile || selected.archived} loading={busy} onClick={() => void saveFile(selected.id)}>{text('upload')}</Button></div><Table<BusinessRecord> rowKey="id" size="small" dataSource={records.filter(record => record.kind === 'attachment' && record.vehicleId === selected.id && (archived || !record.archived))} columns={[{ title: text('name'), render: (_, record) => display(record.data.name) }, { title: text('size'), render: (_, record) => `${(Number(record.data.size) / 1024).toFixed(1)} KB` }, { title: text('actions'), render: (_, record) => <Space><Button icon={<Download size={15} />} onClick={() => downloadFile(record)}>{text('download')}</Button>{recordActions(record)}</Space> }]} /></> },
      { key: 'history', label: text('history'), children: history(changes.filter(change => change.vehicleId === selected.id)) },
    ] : []} /></Drawer>
    {csvExportOpen && <CsvExportDialog records={records} language={language} online={online} syncPaused={syncPaused} syncStatus={sync} onCancel={() => setCsvExportOpen(false)} onBusyChange={setBusy} onError={onError} onRefresh={async () => { const next = await api<BusinessRecord[]>('/api/business/export/records'); const available = next.filter(record => !deletedRecordIds.current.has(record.id) && !deletedRecordIds.current.has(record.vehicleId || record.id)); setRecords(available); return available }} />}
    {deleteVehicle && <VehicleDeleteDialog key={deleteVehicle.id} vehicle={deleteVehicle} language={language} allowed={admin && online} syncPaused={syncPaused} onCancel={() => setDeleteVehicle(null)} onBusyChange={setBusy} onDeleted={vehicleDeleted} onError={onError} />}
    {editor && <RecordEditor record={editor.record} kind={editor.kind} initialName={editor.initialName} initialCategory={editor.initialCategory} language={language} busy={busy} onCancel={() => { if (!busy) setEditor(null) }} onSave={(data, reason) => void saveRecord(data, reason)} />}
    <Modal open={Boolean(action)} title={action ? text(action.type === 'remove' ? 'recordRemoval' : action.archived ? 'archive' : 'restore') : ''} onCancel={() => { if (!busy) setAction(null) }} onOk={() => void applyAction()} confirmLoading={busy} okText={text('save')} cancelText={text('cancel')} okButtonProps={{ disabled: !actionReason.trim() }}><p className="operation-name">{display(action?.record.data.name)}</p><label className="standalone-label">{text('reason')}<Input.TextArea value={actionReason} maxLength={500} rows={3} onChange={event => setActionReason(event.target.value)} /></label></Modal>
    <Modal open={Boolean(activeReport)} onCancel={() => setReportId(null)} title={activeReport ? display(activeReport.data.name) : ''} footer={null} width={1150} destroyOnHidden>{activeReport && <><div className="report-actions"><Button icon={<Download size={16} />} onClick={() => downloadFile(activeReport)}>{text('download')}</Button><Button type="primary" icon={<ClipboardCheck size={16} />} disabled={activeReport.archived || cars.find(car => car.id === activeReport.vehicleId)?.archived} onClick={() => openConfiguration(activeReport)}>{text('updateConfiguration')}</Button>{recordActions(activeReport)}</div><Suspense fallback={<Spin />}><ReportViewer report={(activeReport.data as unknown as ReportData).parsed} language={language} /></Suspense></>}</Modal>
    <Modal open={Boolean(comparison)} onCancel={() => setComparison(null)} title={text('compare')} footer={null} width={1200} destroyOnHidden>{comparison && <><Alert type="info" showIcon title={text('comparisonNote')} /><div className="comparison-names"><span>{display(comparison.left.data.name)} · {display(comparison.left.data.recordedAt)}</span><span>{display(comparison.right.data.name)} · {display(comparison.right.data.recordedAt)}</span></div><Tabs items={['controllers', 'faults'].map(kind => ({ key: kind, label: text(kind), children: <Table<Difference> rowKey="key" dataSource={comparison[kind as 'controllers' | 'faults']} size="small" scroll={{ x: 900 }} pagination={{ pageSize: 10 }} columns={[{ title: text(kind === 'controllers' ? 'controller' : 'code'), dataIndex: 'key', width: 150 }, { title: text('status'), width: 110, render: (_, record) => <Tag color={record.status === 'changed' ? 'warning' : record.status === 'added' ? 'processing' : 'default'}>{text(record.status)}</Tag> }, { title: text('leftReport'), width: 320, render: (_, record) => <DifferenceValue value={record.before} fields={record.fields} text={text} /> }, { title: text('rightReport'), width: 320, render: (_, record) => <DifferenceValue value={record.after} fields={record.fields} text={text} /> }]} /> }))} /></>}</Modal>
    <Modal open={Boolean(configuration)} onCancel={() => { if (!busy) setConfiguration(null) }} title={text('updateConfiguration')} width={950} confirmLoading={busy} onOk={() => void applyConfiguration()} okText={text('save')} cancelText={text('cancel')} okButtonProps={{ disabled: !configuration || configuration.controllerIndex === null || !configuration.fields.length || !configuration.reason.trim() || duplicateTarget || (olderReport && !configuration.allowOlder) }} destroyOnHidden>{configuration && <div className="configuration-form">
      <label>{text('matchedDoveReport')}<Select value={configuration.report.id} onChange={id => { const report = reports.find(record => record.id === id); if (report) openConfiguration(report, selectedController ? keyControllerName(selectedController.name) || undefined : undefined) }} options={reports.filter(report => report.vehicleId === configuration.report.vehicleId && !report.archived && (report.data as unknown as ReportData).parsed.vin === cars.find(car => car.id === report.vehicleId)?.data.vin && controllerSources(report).length > 0).map(report => ({ value: report.id, label: `${report.data.name} · ${report.data.recordedAt || '—'}` }))} /></label>
      {conflictingSources.length > 0 && <Alert type="warning" showIcon title={text('controllerSourceConflict')} />}
      <label>{text('controller')}<Select value={configuration.controllerIndex} placeholder={text('controller')} onChange={value => chooseController(configuration.report, value)} options={controllerSources(configuration.report).map(({ controller, index }) => ({ value: index, label: `${keyControllerName(controller.name) || controller.name} (${controller.name}) · ${controller.network} · ${controller.serial || '—'} · ${controller.software || '—'} · #${index + 1}` }))} /></label>
      {duplicateTarget && <Alert type="warning" showIcon title={text('duplicateControllerRecords')} />}
      {selectedController && <Table rowKey="field" dataSource={configurationFields.map(field => ({ field, current: configuration.part?.data[field], incoming: selectedController[field] }))} rowSelection={{ selectedRowKeys: configuration.fields, onChange: keys => setConfiguration({ ...configuration, fields: keys.map(String) }), getCheckboxProps: record => ({ disabled: !validControllerValue(record.incoming) }) }} pagination={false} size="small" scroll={{ x: 600 }} columns={[{ title: text('applyFields'), render: (_, record) => text(record.field) }, { title: text('currentValue'), render: (_, record) => <span className="preserve-text">{display(record.current)}</span> }, { title: text('reportValue'), render: (_, record) => <span className="preserve-text">{display(record.incoming)}{!validControllerValue(record.incoming) && <Tag>{text('invalidReportValue')}</Tag>}</span> }]} />}
      {olderReport && <Alert type="warning" showIcon title={text('olderReport')} description={<Checkbox checked={configuration.allowOlder} onChange={event => setConfiguration({ ...configuration, allowOlder: event.target.checked })}>{text('confirmOlderReport')}</Checkbox>} />}
      <label>{text('configurationReason')}<Input.TextArea value={configuration.reason} maxLength={500} rows={2} onChange={event => setConfiguration({ ...configuration, reason: event.target.value })} /></label>
    </div>}</Modal>
    <Modal open={restoreOpen} title={text('restoreBackup')} onCancel={() => { if (!busy) setRestoreOpen(false) }} onOk={() => void restore()} okText={text('restore')} cancelText={text('cancel')} confirmLoading={busy} okButtonProps={{ disabled: syncPaused || !restoreFile || confirmation !== 'RESTORE' || !restoreReason.trim() || sync.pending > 0 }} destroyOnHidden><div className="configuration-form">{syncPaused && <Alert type="warning" showIcon title={errorText('CONFIRM_RESUME', language)} />}{sync.pending > 0 && <Alert type="warning" title={text('pendingBeforeRestore')} />}<Upload accept=".zip" maxCount={1} beforeUpload={value => { setRestoreFile(value); return false }} onRemove={() => setRestoreFile(null)}><Button icon={<UploadIcon size={16} />}>{text('chooseFile')} · .zip</Button></Upload><label>{text('restoreConfirmation')}<Input value={confirmation} onChange={event => setConfirmation(event.target.value)} /></label><label>{text('reason')}<Input.TextArea maxLength={500} rows={2} value={restoreReason} onChange={event => setRestoreReason(event.target.value)} /></label></div></Modal>
  </section>
}
