import { parseWatch } from './vehicle-watch'
import type { VehicleWatch, WatchColor } from './vehicle-watch'
import { lazy, Suspense, useEffect, useEffectEvent, useImperativeHandle, useMemo, useRef, useState } from 'react'
import type { Ref } from 'react'
import { App, Alert, Button, Checkbox, Descriptions, Drawer, Dropdown, Empty, Input, Modal, Select, Space, Spin, Table, Tabs, Tag, Tooltip, Upload } from 'antd'
import { Archive, ArrowUpRight, CarFront, Check, ClipboardCheck, Clock3, ChevronRight, CloudOff, Download, Ellipsis, Eye, FileSpreadsheet, FolderSync, GitCompare, Pencil, Plus, RefreshCw, RotateCcw, Search, Trash2, Upload as UploadIcon, Wrench } from 'lucide-react'
import { api, ApiError, createWorkspaceScope, download } from './api'
import { localReminderDay } from '../shared/backup-reminder'
import { errorText } from './i18n'
import type { Language } from './i18n'
import { translateBusiness } from './business-i18n'
import { activeHvBatteries, configurationFields, controllerSources as parsedControllerSources, doveRecordedTime, keyControllerName, keyControllerNames, reportAssociationVin, reportMatchesVehicle, thermalSystemTypes, validControllerValue, vehicleHvBatteries } from '../shared/business'
import type { BusinessRecord, Fields, KeyControllerName, QuarantinedOperation, RecordKind, ReportData, RestorePreview, RestoreResult, RestoreReceipt, SyncConflict, SyncStatus, VehicleDeletePreview, VehicleDeleteReceipt, VehicleDeleteRequest } from '../shared/business'
import RecordEditor from './RecordEditor'
import EquipmentRecordEditor from './EquipmentRecordEditor'
import { equipmentAttachments, parseEquipmentAttachmentId } from '../shared/equipment-attachments'
import { matchesReportSearch } from './report-archive'
import HistoryPanel from './HistoryPanel'
import DoveImport from './DoveImport'
import CsvExportDialog from './CsvExportDialog'
import ResizableVehicleTable from './ResizableVehicleTable'
import { useVehicleTablePreferences } from './use-vehicle-table-preferences'
import { useVehicleTableFilterSession } from './vehicle-table-filter-session'
import { createVehicleFilterValues, findVehicleTableController, sortedVehicleReports } from './vehicle-table-filters'
import { vehicleOverviewColumnIds } from '../shared/vehicle-table'
import { builtinComponentTypes } from '../shared/configuration-revisions'
import type { ComponentTypeCatalog, ConfigurationRevisionSummary, ConfigurationWorkingView } from '../shared/configuration-revisions'
import ConfigurationRevisions from './ConfigurationRevisions'
import ComponentSections from './ComponentSections'
import { showWorkingComponentType } from './component-review-policy'
import VehicleOverview from './VehicleOverview'
import AttachmentUpload from './AttachmentUpload'
import AttachmentPreview from './AttachmentPreview'
import VehicleModificationSection from './VehicleModificationSection'
import { WorkspaceLoader } from './workspace-loader'
import type { AuditEntry, WorkspaceSnapshot } from '../shared/workspace'
import './BusinessApp.css'

const ReportViewer = lazy(() => import('./ReportViewer'))
export type BusinessView = 'vehicles' | 'dove' | 'reports' | 'history' | 'sync' | 'audit'
export type BusinessRefreshHandle = { refresh: () => Promise<void> }
type Editor = { kind: RecordKind; record: BusinessRecord | null; vehicleId: string | null; initialName?: string; initialCategory?: 'battery' }
type Action = { record: BusinessRecord; type: 'archive' | 'remove'; archived?: boolean; requestId: string; groupVersions?: Record<string, number> }
type Difference = { key: string; status: string; before: unknown; after: unknown; fields: string[] }
type Comparison = { left: BusinessRecord; right: BusinessRecord; controllers: Difference[]; faults: Difference[] }
type Configuration = { report: BusinessRecord; controllerIndex: number | null; part: BusinessRecord | null; fields: string[]; reason: string; allowOlder: boolean }
type ControllerSlot = { name: KeyControllerName; part: BusinessRecord | null }
const statuses = ['available', 'testing', 'maintenance', 'inactive']
const emptySync: SyncStatus = { phase: 'idle', error: null, pending: 0, conflicts: [], quarantined: 0, lastSync: null, revision: null }
const display = (value: unknown): string => value === null || value === undefined || value === '' ? '—' : typeof value === 'object' ? JSON.stringify(value, null, 2) : String(value)
function controllerSources(report: BusinessRecord) {
  return parsedControllerSources((report.data as unknown as ReportData).parsed.controllers)
}

function AuditDetails({ entry, language, text }: { entry: AuditEntry; language: Language; text: (key: string) => string }) {
  const identity = entry.identity, zh = language === 'zh'
  const identityItems = identity ? [
    { key: 'identitySource', label: zh ? '身份依据' : 'Identity source', children: identity.source === 'recorded' ? (zh ? '操作时快照' : 'Recorded at operation time') : identity.source === 'resolved' ? (zh ? '旧日志：当前资料解析' : 'Legacy log: current profile lookup') : (zh ? '历史身份未确认' : 'Unconfirmed historical identity') },
    { key: 'actorId', label: zh ? '原始操作人 ID' : 'Original actor ID', children: identity.actorId },
    { key: 'deviceId', label: zh ? '设备 ID' : 'Device ID', children: identity.deviceId },
    ...(identity.account ? [
      { key: 'localAccount', label: zh ? '本地账号' : 'Local account', children: `${identity.account.displayName} (${identity.account.username})` },
      { key: 'localAccountId', label: zh ? '本地账号 ID' : 'Local account ID', children: identity.account.id },
    ] : []),
    ...(identity.member ? [
      { key: 'teamMember', label: zh ? '团队身份' : 'Team identity', children: identity.member.name },
      { key: 'teamMemberId', label: zh ? '团队成员 ID' : 'Team member ID', children: identity.member.id },
    ] : []),
  ] : []
  return <details><summary>{text('details')}</summary><Descriptions column={1} size="small" items={[...identityItems, ...Object.entries(entry.detail).map(([key, value]) => ({ key: `detail-${key}`, label: text(key), children: display(value) }))]} /></details>
}

function DifferenceValue({ value, fields, text }: { value: unknown; fields: string[]; text: (key: string) => string }) {
  if (Array.isArray(value)) return value.length ? <div>{value.map((item, index) => <DifferenceValue key={index} value={item} fields={fields} text={text} />)}</div> : <span>—</span>
  if (!value || typeof value !== 'object') return <span>{display(value)}</span>
  return <Descriptions column={1} size="small" items={Object.entries(value).filter(([key, item]) => item !== '' && (!fields.length || fields.includes(key))).map(([key, item]) => ({ key, label: text(key), children: <span className="preserve-text">{display(item)}</span> }))} />
}

function ReportDifference({ record, text, leftLabel, rightLabel }: { record: Difference; text: (key: string) => string; leftLabel: string; rightLabel: string }) {
  if (record.status === 'ambiguous') return <div className="report-difference-detail"><div><strong>{leftLabel}</strong><DifferenceValue value={record.before} fields={[]} text={text} /></div><div><strong>{rightLabel}</strong><DifferenceValue value={record.after} fields={[]} text={text} /></div></div>
  const before = (Array.isArray(record.before) ? record.before[0] : record.before) as Record<string, unknown> | undefined
  const after = (Array.isArray(record.after) ? record.after[0] : record.after) as Record<string, unknown> | undefined
  const fields = record.fields.length ? record.fields : Array.from(new Set([...Object.keys(before || {}), ...Object.keys(after || {})]))
  return <div className="report-field-differences"><table><thead><tr><th>{text('changedFields')}</th><th>{leftLabel}</th><th>{rightLabel}</th></tr></thead><tbody>{fields.map(field => <tr key={field}><th>{text(field)}</th><td>{display(before?.[field])}</td><td>{display(after?.[field])}</td></tr>)}</tbody></table></div>
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
      if (!['NETWORK_ERROR', 'SERVER_ERROR', 'SHARE_IO_ERROR', 'SHARE_UNAVAILABLE', 'SHARE_BUSY', 'SHARE_LOCK_LOST'].includes(code)) {
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

export default function BusinessApp({ view, language, admin, online, syncPaused, onError, refreshRef, personalScope }: { personalScope?: string; view: BusinessView; language: Language; admin: boolean; online: boolean; syncPaused: boolean; onError: (error: unknown) => void; refreshRef?: Ref<BusinessRefreshHandle> }) {
  const text = translateBusiness(language), { message, modal } = App.useApp()
  const tablePreferences = useVehicleTablePreferences(view === 'vehicles')
  const watchStorageKey = personalScope ? `vdm-vehicle-watch:${personalScope}` : null
  const readWatch = () => { try { return parseWatch(watchStorageKey ? localStorage.getItem(watchStorageKey) : null) } catch { return parseWatch(null) } }
  const [watchState, setWatchState] = useState(() => ({ key: watchStorageKey, value: readWatch() }))
  const watch = watchState.key === watchStorageKey ? watchState.value : readWatch()
  function saveWatch(next: VehicleWatch) {
    try {
      if (watchStorageKey) localStorage.setItem(watchStorageKey, JSON.stringify(next))
      setWatchState({ key: watchStorageKey, value: next })
    } catch { message.error(language === 'zh' ? '无法保存个人关注，请检查浏览器存储权限。' : 'Could not save personal favorites. Check browser storage permissions.') }
  }
  function markVehicle(id: string, color?: WatchColor) {
    const vehicles = { ...watch.vehicles }
    if (color) vehicles[id] = color; else delete vehicles[id]
    saveWatch({ ...watch, vehicles })
  }

  const { filters: vehicleColumnFilters, setFilters: setVehicleColumnFilters } = useVehicleTableFilterSession()
  const [records, setRecords] = useState<BusinessRecord[]>([]), [historyRevision, setHistoryRevision] = useState(0), [sync, setSync] = useState<SyncStatus>(emptySync)
  const [catalog, setCatalog] = useState<ComponentTypeCatalog>({ enabled: false, types: builtinComponentTypes })
  const [revisionSummaries, setRevisionSummaries] = useState<ConfigurationRevisionSummary[]>([])
  const [modificationEnabled, setModificationEnabled] = useState(false)
  const [revisionBusy, setRevisionBusy] = useState(false)
  const vehicleFilterValues = useMemo(() => createVehicleFilterValues(records, language, revisionSummaries), [records, language, revisionSummaries])
  const [loading, setLoading] = useState(true), [busy, setBusy] = useState(false), [query, setQuery] = useState(''), [filter, setFilter] = useState<string | undefined>(), [archived, setArchived] = useState(false)
  const [hasSnapshot, setHasSnapshot] = useState(false), [loadError, setLoadError] = useState<string | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null), [editor, setEditor] = useState<Editor | null>(null), [action, setAction] = useState<Action | null>(null), [actionReason, setActionReason] = useState('')
  const [detailTab, setDetailTab] = useState('overview')
  const [reportId, setReportId] = useState<string | null>(null)
  const [attachmentPreview, setAttachmentPreview] = useState<BusinessRecord | null>(null)
  const comparisonRequest = useRef<AbortController | null>(null)
  useEffect(() => () => { comparisonRequest.current?.abort() }, [])
  const [csvExportOpen, setCsvExportOpen] = useState(false)
  const [reportVehicle, setReportVehicle] = useState<string | undefined>()
  const [batchArchive, setBatchArchive] = useState(false), [batchReason, setBatchReason] = useState(''), [compareOpen, setCompareOpen] = useState(false), [onlyDifferences, setOnlyDifferences] = useState(true)
  const [reportSelection, setReportSelection] = useState<string[]>([]), [comparison, setComparison] = useState<Comparison | null>(null), [configuration, setConfiguration] = useState<Configuration | null>(null)
  const [restoreOpen, setRestoreOpen] = useState(false), [restoreFile, setRestoreFile] = useState<File | null>(null), [restorePreview, setRestorePreview] = useState<RestorePreview | null>(null), [archiveRecordIds, setArchiveRecordIds] = useState<string[]>([]), [confirmDroppedFields, setConfirmDroppedFields] = useState(false), [confirmation, setConfirmation] = useState(''), [restoreReason, setRestoreReason] = useState('')
  const attachmentCancel = useRef<(() => void) | null>(null)
  const equipmentCancel = useRef<(() => void) | null>(null)
  const [audit, setAudit] = useState<AuditEntry[]>([])
  const [quarantined, setQuarantined] = useState<QuarantinedOperation[]>([]), [deleteVehicle, setDeleteVehicle] = useState<BusinessRecord | null>(null), [deleteReceipt, setDeleteReceipt] = useState<VehicleDeleteReceipt | null>(null)
  const deletedRecordIds = useRef(new Set<string>())
  const [workspaceLoader] = useState(() => new WorkspaceLoader())
  const [today, setToday] = useState(() => new Date().toISOString().slice(0, 10))
  useEffect(() => { const timer = setInterval(() => setToday(new Date().toISOString().slice(0, 10)), 60000); return () => clearInterval(timer) }, [])
  function acceptWorkspace(result: WorkspaceSnapshot) {
    if (result.data) {
      const data = result.data
      setHasSnapshot(true)
      setRecords(data.records.filter(record => !deletedRecordIds.current.has(record.id) && !deletedRecordIds.current.has(record.vehicleId || record.id)))
      setCatalog(data.catalog); setRevisionSummaries(data.revisionSummaries.filter(summary => !deletedRecordIds.current.has(summary.vehicleId)))
      setModificationEnabled(Boolean(data.modificationEnabled))
      setReportSelection(current => current.filter(id => data.records.some(record => record.id === id && record.kind === 'report')))

      setHistoryRevision(value => value + 1); setAudit(data.audit); setQuarantined(data.quarantined)
    }
    setSync(current => JSON.stringify(current) === JSON.stringify(result.sync) ? current : result.sync)
    setLoadError(null)
    setLoading(false)
  }
  function reportWorkspaceError(error: unknown) {
    setLoadError(error instanceof ApiError ? error.message : 'SERVER_ERROR')
    onError(error)
  }
  async function load(options: { background?: boolean; full?: boolean } = {}) {
    if (!options.background) setLoading(true)
    try {
      const scope = createWorkspaceScope()
      await workspaceLoader.load(url => scope.request(url), acceptWorkspace, { audit: view === 'audit', quarantined: view === 'sync', localFirst: !options.background, full: options.full })
    } catch (error) { reportWorkspaceError(error) } finally { setLoading(false) }
  }
  useImperativeHandle(refreshRef, () => ({ refresh: () => load({ full: true }) }))
  async function loadScoped(scope: ReturnType<typeof createWorkspaceScope>, signal: AbortSignal) {
    await workspaceLoader.load(url => scope.request(url, { signal }), result => { scope.assertCurrent(signal); acceptWorkspace(result) }, { audit: view === 'audit', quarantined: view === 'sync', localOnly: true })
    scope.assertCurrent(signal)
  }
  const reportInitialError = useEffectEvent(reportWorkspaceError)
  useEffect(() => {
    const controller = new AbortController(), scope = createWorkspaceScope()
    void workspaceLoader.load(url => scope.request(url, { signal: controller.signal }), acceptWorkspace, { audit: view === 'audit', quarantined: view === 'sync', localFirst: true }).catch(error => { if (!controller.signal.aborted) { reportInitialError(error); setLoading(false) } })
    return () => { workspaceLoader.invalidate(); controller.abort() }
  }, [view, workspaceLoader])
  const periodicLoad = useEffectEvent(async () => {
    if (!workspaceLoader.busy && !editor && !action && !selectedId && !reportId && !configuration && !comparison && !restoreOpen && !deleteVehicle && !csvExportOpen && !busy && document.visibilityState === 'visible' && !document.activeElement?.matches('input,textarea,select')) await load({ background: true })
  })
  useEffect(() => { const timer = setInterval(() => { void periodicLoad() }, 30000); return () => clearInterval(timer) }, [])
  useEffect(() => {
    if (view !== 'sync' || !busy && sync.phase !== 'syncing') return
    const controller = new AbortController(), scope = createWorkspaceScope()
    const timer = setInterval(() => { void scope.request<SyncStatus>('/api/business/sync', { signal: controller.signal }).then(state => { if (!controller.signal.aborted) setSync(state) }).catch(() => {}) }, 1000)
    return () => { clearInterval(timer); controller.abort() }
  }, [view, busy, sync.phase])
  const selected = records.find(record => record.id === selectedId) || null
  const openVehicle = (id: string, tab = 'overview') => {
    if (id !== selectedId) { attachmentCancel.current?.(); equipmentCancel.current?.(); setEditor(current => current?.kind === 'equipment' && current.vehicleId !== id ? null : current) }
    setSelectedId(id); setDetailTab(tab)
  }
  const activeReport = records.find(record => record.id === reportId) || null
  const cars = records.filter(record => record.kind === 'vehicle')
  const editorVehicle = editor?.kind === 'equipment' ? cars.find(car => car.id === editor.vehicleId) : null
  const reports = sortedVehicleReports(records)
  const date = (value: string) => value ? new Date(value).toLocaleString(language === 'zh' ? 'zh-CN' : 'en-GB') : '—'
  const statusTag = (value: string) => <Tag color={{ available: 'success', testing: 'processing', maintenance: 'warning', inactive: 'default' }[value]}>{text(value)}</Tag>
  const linkedVehicleGroups = (id: string) => Object.fromEntries(records.filter(record => record.kind === 'modification' && record.vehicleId === id && typeof record.data.groupId === 'string').map(record => records.find(group => group.kind === 'modificationGroup' && group.id === record.data.groupId)).filter((group): group is BusinessRecord => Boolean(group)).map(group => [group.id, group.version]))
  const openAction = (record: BusinessRecord, type: Action['type']) => { setAction({ record, type, archived: !record.archived, requestId: crypto.randomUUID(), ...(record.kind === 'vehicle' ? { groupVersions: linkedVehicleGroups(record.id) } : {}) }); setActionReason('') }
  async function vehicleDeleted(receipt: VehicleDeleteReceipt) {
    const affected = new Set([receipt.vehicleId, ...receipt.recordIds])
    for (const id of affected) deletedRecordIds.current.add(id)
    const belongs = (record: BusinessRecord) => affected.has(record.id) || record.vehicleId === receipt.vehicleId
    setRecords(current => current.filter(record => !belongs(record)))
    setRevisionSummaries(current => current.filter(summary => summary.vehicleId !== receipt.vehicleId))
    setSelectedId(current => current && affected.has(current) ? null : current)
    setReportId(current => current && affected.has(current) ? null : current)
    setReportSelection(current => current.filter(id => !affected.has(id)))
    setEditor(current => current && (current.vehicleId === receipt.vehicleId || (current.record && belongs(current.record))) ? null : current)
    setAction(current => current && belongs(current.record) ? null : current)
    setComparison(current => current && (belongs(current.left) || belongs(current.right)) ? null : current)
    setConfiguration(current => current && (belongs(current.report) || (current.part && belongs(current.part))) ? null : current)
    if (selectedId === receipt.vehicleId) { attachmentCancel.current?.(); equipmentCancel.current?.() }
    setDeleteVehicle(null); setDeleteReceipt(receipt)
    await load()
    if (receipt.localSynced) void message.success(text('vehicleDeleted'))
    else void message.warning(text('deleteCommittedPending'), 8)
  }
  async function saveRecord(data: Fields, reason: string) {
    if (!editor) return
    setBusy(true)
    try {
      await api(`/api/business/records${editor.record ? `/${editor.record.id}` : ''}`, { method: editor.record ? 'PUT' : 'POST', body: { kind: editor.kind, vehicleId: editor.vehicleId, data, reason, version: editor.record?.version } })
      setEditor(null); void message.success(text('saved')); void load()
    } catch (error) { onError(error) } finally { setBusy(false) }
  }
  async function applyAction() {
    if (!action || !actionReason.trim()) return
    setBusy(true)
    try {
      const record = action.record
      await api(`/api/business/records/${record.id}${action.type === 'archive' ? '/archive' : ''}`, { method: action.type === 'archive' ? 'POST' : 'PUT', body: { data: { ...record.data, removedAt: today }, archived: action.archived, version: record.version, reason: actionReason, requestId: action.requestId, ...(action.groupVersions ? { groupVersions: action.groupVersions } : {}) } })
      setAction(null); await load(); void message.success(text('saved'))
    } catch (error) { onError(error) } finally { setBusy(false) }
  }
  async function compare() {
    if (!canCompare || busy) return
    const controller = new AbortController(); comparisonRequest.current?.abort(); comparisonRequest.current = controller
    const scope = createWorkspaceScope()
    setCompareOpen(true); setComparison(null); setOnlyDifferences(true); setBusy(true)
    const ordered = selectedReports.slice().sort((a, b) => (doveRecordedTime(a.data.recordedAt) - doveRecordedTime(b.data.recordedAt) || Date.parse(String(a.data.savedAt || a.updated)) - Date.parse(String(b.data.savedAt || b.updated))))
    try { setComparison(await scope.request<Comparison>(`/api/business/reports/compare?left=${encodeURIComponent(ordered[0].id)}&right=${encodeURIComponent(ordered[1].id)}`, { signal: controller.signal })) }
    catch (error) { if (!controller.signal.aborted) onError(error) } finally { if (comparisonRequest.current === controller) setBusy(false) }
  }
  async function archiveReports() {
    setBusy(true)
    const failed: string[] = []
    const scope = createWorkspaceScope()
    try {
      for (const id of reportSelection) {
        const record = reports.find(item => item.id === id)
        if (!record || record.archived) continue
        try { await scope.request(`/api/business/records/${id}/archive`, { method: 'POST', body: { version: record.version, archived: true, reason: batchReason } }) }
        catch (error) { failed.push(id); onError(error); scope.assertCurrent() }
      }
      setReportSelection(failed); setBatchArchive(false); await load()
      if (!failed.length) void message.success(text('saved'))
    } finally { setBusy(false) }
  }
  async function downloadReports() {
    setBusy(true)
    try {
      if (reportSelection.length === 1) {
        const record = reports.find(item => item.id === reportSelection[0])!
        await download(`/api/business/files/${record.id}`, String(record.data.name))
      } else await download('/api/business/reports/download', 'reports.zip', { method: 'POST', body: { ids: reportSelection } })
    } catch (error) { onError(error) } finally { setBusy(false) }
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
  const restoreRequestId = useRef(crypto.randomUUID())
  const [restoreSearch, setRestoreSearch] = useState('')
  const [receipts, setReceipts] = useState<RestoreReceipt[]>([])
  const [receiptsOpen, setReceiptsOpen] = useState(false)
  const backupActive = useRef(false)
  async function startBackup() {
    if (backupActive.current) return
    backupActive.current = true
    const scope = createWorkspaceScope()
    modal.confirm({ afterClose: () => { backupActive.current = false }, title: language === 'zh' ? '备份数据' : 'Back up data', okText: language === 'zh' ? '下载备份' : 'Download backup', cancelText: text('cancel'), content: language === 'zh' ? '将先同步团队数据，再下载备份文件，包含车辆记录和附件。请将文件妥善保存。' : 'Sync team data, then download a backup containing vehicle records and attachments. Keep the file in a safe location.', onOk: async () => {
      try {
        scope.assertCurrent()
        const status = await scope.request<{ teamId: string }>('/api/business/backup/status')
        scope.assertCurrent()
        await download('/api/business/backup', `vehicle-team-backup-${status.teamId}-${new Date().toISOString().replace(/[:.]/g, '-')}.zip`)
      } catch (error) { onError(error); throw error }
    } })
  }
  const reminderOpen = useRef(false)
  const reminderEpoch = useRef(0)
  const reminderDialog = useRef<{ destroy: () => void } | null>(null)
  const mayRemind = useEffectEvent(() => admin && online && view === 'vehicles' && !busy && !revisionBusy && !selectedId && !editor && !action && !reportId && !configuration && !comparison && !deleteVehicle && !csvExportOpen && !restoreOpen && !receiptsOpen && !backupActive.current && !reminderOpen.current && !document.querySelector('.component-type-management-modal, .vehicle-column-settings-modal'))
  const checkBackupReminder = useEffectEvent(async () => {
    if (!mayRemind()) return
    const scope = createWorkspaceScope(), epoch = reminderEpoch.current
    try {
      const status = await scope.request<{ due: boolean; dismissedDay: string | null; lastBackupAt: string | null }>('/api/business/backup/reminder')
      scope.assertCurrent()
      if (!mayRemind() || epoch !== reminderEpoch.current || !status.due || status.dismissedDay === localReminderDay() || reminderOpen.current) return
      reminderOpen.current = true
      const dismiss = async () => { try { await scope.request('/api/business/backup/reminder/dismiss', { method: 'POST', body: { day: localReminderDay() } }) } finally { reminderOpen.current = false } }
      reminderDialog.current = modal.confirm({ title: language === 'zh' ? '备份提醒' : 'Backup reminder', content: language === 'zh' ? (status.lastBackupAt ? '本团队已连续 7 天未备份，建议现在备份。' : '尚无团队备份记录，建议先备份一次。') : (status.lastBackupAt ? 'This team has not been backed up for at least 7 days. Back up now.' : 'No team backup is recorded. Create your first backup.'), okText: language === 'zh' ? '立即备份' : 'Back up now', cancelText: language === 'zh' ? '今天不再提醒' : 'Dismiss for today', onCancel: dismiss, onOk: async () => { await dismiss(); scope.assertCurrent(); await startBackup() } })
    } catch { /* Offline or revoked access must not produce an unverified reminder. */ }
  })
  const closeReminder = useEffectEvent(() => { reminderEpoch.current++; reminderDialog.current?.destroy(); reminderDialog.current = null; reminderOpen.current = false })
  useEffect(() => {
    void checkBackupReminder()
    const timer = setInterval(() => void checkBackupReminder(), 60000)
    return () => { clearInterval(timer); closeReminder() }
  }, [admin, online, view])
  async function showReceipts() {
    try { setReceipts(await api<RestoreReceipt[]>('/api/business/restore/receipts')); setReceiptsOpen(true) } catch (error) { onError(error) }
  }
  function reviewSharedRestore(receipt: RestoreReceipt) {
    let explanation = ''
    modal.confirm({
      title: language === 'zh' ? '保留载荷并重新审核恢复' : 'Retain payload and review restore again',
      content: <><p>{language === 'zh' ? '将保留待恢复的共享改装数据及文件，刷新为团队当前值。其他待同步修改保留；请同步后重新预览备份，不会回退团队共享版本。' : 'Retain the desired shared modification payload and files, then refresh current team values. Other pending work stays queued. Synchronize before a fresh backup preview; the shared revision is never rolled back.'}</p><Input.TextArea maxLength={500} placeholder={text('reason')} onChange={event => { explanation = event.target.value }} /></>,
      okText: text('save'), cancelText: text('cancel'),
      onOk: async () => {
        if (!explanation.trim()) { void message.warning(text('reason')); throw new Error('REASON_REQUIRED') }
        setBusy(true)
        try { await api(`/api/business/restore/${receipt.requestId}/abandon-modifications`, { method: 'POST', body: { reason: explanation } }); await showReceipts(); await load() }
        catch (error) { onError(error); throw error } finally { setBusy(false) }
      },
    })
  }
  async function previewRestore(file: File) {
    restoreRequestId.current = crypto.randomUUID()

    setRestoreFile(file); setRestorePreview(null); setArchiveRecordIds([]); setConfirmDroppedFields(false); setConfirmation(''); setRestoreReason(''); setBusy(true)
    try {
      const form = new FormData(); form.append('file', file)
      const preview = await api<RestorePreview>('/api/business/restore/preview', { method: 'POST', body: form })
      setRestorePreview(preview)
    } catch (error) { onError(error) } finally { setBusy(false) }
  }
  async function restore() {
    if (syncPaused) { onError(new ApiError('CONFIRM_RESUME')); return }
    if (!restoreFile || !restorePreview) return
    const form = new FormData(); form.append('file', restoreFile); form.append('requestId', restoreRequestId.current); form.append('confirmation', confirmation); form.append('reason', restoreReason); form.append('archiveRecordIds', JSON.stringify(archiveRecordIds)); form.append('previewFingerprint', restorePreview.fingerprint); form.append('confirmDroppedFields', String(confirmDroppedFields))
    setBusy(true)
    try {
      const result = await api<RestoreResult>('/api/business/restore', { method: 'POST', body: form })
      setRestoreOpen(false); setRestoreFile(null); setRestorePreview(null); setArchiveRecordIds([]); setConfirmDroppedFields(false); setConfirmation(''); setRestoreReason(''); await load(); await showReceipts()
      if (result.syncError) void message.warning(`${text('restoredBackup')} · ${errorText(result.syncError, language)}`, 8)
      else if (result.skippedVehicles || result.skippedRecords) void message.warning(`${text('restoredBackup')} · ${text('skippedVehicles')}: ${result.skippedVehicles} · ${text('skippedRecords')}: ${result.skippedRecords}`, 8)
      else void message.success(text('restoredBackup'))
    }
    catch (error) { onError(error) } finally { setBusy(false) }
  }
  const downloadFile = (record: BusinessRecord) => { void download(`/api/business/files/${record.id}`, String(record.data.name)).catch(onError) }
  const attachmentEquipment = (record: BusinessRecord) => {
    const id = parseEquipmentAttachmentId(record.data.equipmentId)
    if (!id) return '—'
    const equipment = records.find(item => item.id === id && item.kind === 'equipment' && item.vehicleId === record.vehicleId)
    return equipment ? display(equipment.data.name) : text('equipmentUnavailable')
  }
  const recordActions = (record: BusinessRecord) => <Space size={3}>
    {!record.archived && !['report', 'attachment'].includes(record.kind) && <Tooltip title={text('edit')}><Button type="text" icon={<Pencil size={15} />} aria-label={`${text('edit')} ${record.data.name}`} onClick={() => setEditor({ kind: record.kind, record, vehicleId: record.vehicleId })} /></Tooltip>}
    {!record.archived && ['part', 'equipment'].includes(record.kind) && !record.data.removedAt && <Tooltip title={text('recordRemoval')}><Button type="text" icon={<Wrench size={15} />} aria-label={text('recordRemoval')} onClick={() => openAction(record, 'remove')} /></Tooltip>}
    {admin && <Tooltip title={record.kind === 'vehicle' && syncPaused && Object.keys(linkedVehicleGroups(record.id)).length ? text('modificationOnlineNotice') : text(record.archived ? 'restore' : 'archive')}><Button type="text" disabled={!online || record.kind === 'vehicle' && syncPaused && Object.keys(linkedVehicleGroups(record.id)).length > 0} icon={record.archived ? <RotateCcw size={15} /> : <Archive size={15} />} aria-label={`${text(record.archived ? 'restore' : 'archive')} ${record.data.name}`} onClick={() => openAction(record, 'archive')} /></Tooltip>}
    {admin && record.kind === 'vehicle' && record.archived && <Tooltip title={syncPaused ? errorText('CONFIRM_RESUME', language) : text('deleteVehicle')}><Button type="text" danger disabled={!online || busy || syncPaused} icon={<Trash2 size={15} />} aria-label={`${text('deleteVehicle')} ${record.data.vin}`} onClick={() => setDeleteVehicle(record)}>{text('delete')}</Button></Tooltip>}
  </Space>
  const reportTable = (items: BusinessRecord[], selectable = false) => <Table<BusinessRecord> rowKey="id" dataSource={items} size="small" loading={loading} scroll={{ x: selectable ? 700 : 800 }} pagination={{ pageSize: 10, hideOnSinglePage: true }} rowSelection={selectable ? { preserveSelectedRowKeys: true, selectedRowKeys: reportSelection, onChange: keys => setReportSelection(keys.map(String)) } : undefined} columns={[
    { title: text('file'), width: 280, render: (_, record) => <button className="record-link" onClick={() => setReportId(record.id)}><FileSpreadsheet size={17} /><span>{display(record.data.name)}{record.archived && <small>{text('archived')}</small>}</span></button> },
    { title: text('vehicle'), width: 220, render: (_, record) => { const car = cars.find(item => item.id === record.vehicleId); return <div className="report-vehicle"><strong>{display(car?.data.model || car?.data.name || text('vehicleUnavailable'))}</strong><small>{display(car?.data.vin || reportAssociationVin(record))}</small></div> } }, { title: text('recordedAt'), width: 160, render: (_, record) => display(record.data.recordedAt) },
    ...(!selectable ? [{ title: text('actions'), width: 110, render: (_: unknown, record: BusinessRecord) => <Space><Tooltip title={text('download')}><Button type="text" icon={<Download size={16} />} aria-label={text('download')} onClick={() => downloadFile(record)} /></Tooltip>{recordActions(record)}</Space> }] : []),
  ]} />
  const matchedReports = (vehicle: BusinessRecord) => reports.filter(report => !report.archived && reportMatchesVehicle(report, vehicle) && controllerSources(report).length > 0)
  const controllerFor = (vehicleId: string, name: KeyControllerName) => findVehicleTableController(records, vehicleId, name)
  const controllerTable = (vehicle: BusinessRecord, editable: boolean) => {
    const slots: ControllerSlot[] = keyControllerNames.map(name => ({ name, part: controllerFor(vehicle.id, name) }))
    const available = matchedReports(vehicle)
    return <div className="vehicle-controller-section"><div className="section-toolbar"><h3>{text(editable ? 'parts' : 'controllers')}</h3>{editable && <Tooltip title={!available.length ? text('noMatchedReports') : text('updateConfiguration')}><Button type="primary" icon={<ClipboardCheck size={15} />} disabled={vehicle.archived || !available.length} onClick={() => openConfiguration(available[0])}>{text('updateConfiguration')}</Button></Tooltip>}</div>
      <Table<ControllerSlot> rowKey="name" className="controller-summary-table" dataSource={slots} size="small" pagination={false} scroll={{ x: 875 }} columns={[
        { title: text('name'), width: 110, render: (_, slot) => <strong>{slot.name}</strong> },
        { title: text('controllerType'), width: 140, render: (_, slot) => <span className="preserve-text">{display(slot.part?.data.controllerType)}</span> },
        ...(['supplier', 'productPart', 'calibrationPart', 'calibrationVersion'] as const).map(field => ({ title: text(field === 'calibrationPart' ? 'softwarePart' : field), width: field === 'calibrationVersion' ? 110 : 150, render: (_: unknown, slot: ControllerSlot) => <span className="preserve-text">{display(slot.part?.data[field])}</span> })),
        { title: text('more'), width: 65, render: (_, slot) => <Tooltip title={text('more')}><Button type="text" icon={<Ellipsis size={17} />} aria-label={`${text('more')} ${slot.name}`} onClick={() => setEditor({ kind: 'part', record: slot.part, vehicleId: vehicle.id, initialName: slot.name })} /></Tooltip> },
      ]} />
    </div>
  }
  const hvBatteryTable = (vehicle: BusinessRecord) => <div className="vehicle-hv-battery-section">
    <div className="section-toolbar"><h3>{text('hvBattery')}</h3><Button type="primary" icon={<Plus size={15} />} disabled={vehicle.archived} onClick={() => setEditor({ kind: 'part', vehicleId: vehicle.id, record: null, initialCategory: 'battery' })}>{text('addHvBattery')}</Button></div>
    {activeHvBatteries(records, vehicle.id).length > 1 && <Alert className="business-notice" type="warning" showIcon title={text('multipleHvBatteries')} />}
    <Table<BusinessRecord> rowKey="id" className="hv-battery-table" dataSource={vehicleHvBatteries(records, vehicle.id, archived)} size="small" scroll={{ x: 970 }} pagination={{ pageSize: 8, hideOnSinglePage: true }} columns={[
      { title: text('partNumber'), width: 190, render: (_, record) => <span className="preserve-text">{display(record.data.productPart)}</span> },
      { title: text('serialNumber'), width: 190, render: (_, record) => <span className="preserve-text">{display(record.data.serial)}</span> },
      { title: text('partMaturityLevel'), width: 180, render: (_, record) => <span className="preserve-text">{display(record.data.maturity)}</span> },
      { title: text('lifeStatus'), width: 150, render: (_, record) => <span className="preserve-text">{display(record.data.lifeStatus)}</span> },
      { title: text('status'), width: 130, render: (_, record) => record.archived ? text('archived') : record.data.removedAt ? `${text('removed')} · ${record.data.removedAt}` : text('installed') },
      { title: text('actions'), width: 130, render: (_, record) => recordActions(record) },
    ]} />
  </div>
  const entryTable = (kind: RecordKind, vehicle: BusinessRecord) => {
    const items = records.filter(record => record.kind === kind && record.vehicleId === vehicle.id && (!record.archived || archived))
    return <><div className="section-toolbar"><h3>{text(kind === 'modification' ? 'modifications' : kind)}</h3><Button type="primary" icon={<Plus size={15} />} disabled={vehicle.archived} onClick={() => setEditor({ kind, vehicleId: vehicle.id, record: null })}>{text('addEntry')}</Button></div><Table<BusinessRecord> rowKey="id" dataSource={items} size="small" scroll={{ x: kind === 'equipment' ? 920 : 760 }} pagination={{ pageSize: 8, hideOnSinglePage: true }} columns={[
      { title: text('name'), width: 160, render: (_, record) => <div className="record-title">{display(record.data.name)}{kind === 'equipment' && <small>{text('attachments')}: {equipmentAttachments(records, record, archived).length}</small>}</div> },
      ...(kind === 'equipment' ? [{ title: text('equipmentType'), width: 160, render: (_: unknown, record: BusinessRecord) => <span className="preserve-text">{display(record.data.equipmentType)}</span> }] : []),
      { title: text('description'), width: 300, render: (_, record) => <span className="preserve-text">{display(record.data.description)}</span> },
      { title: text('status'), width: 120, render: (_, record) => record.archived ? text('archived') : record.data.removedAt ? `${text('removed')} · ${record.data.removedAt}` : text('installed') },
      { title: text('actions'), width: 130, render: (_, record) => recordActions(record) },
    ]} expandable={{ expandedRowRender: record => <><Descriptions column={{ xs: 1, sm: 2 }} size="small" items={Object.entries(kind === 'equipment' ? { ...record.data, equipmentType: record.data.equipmentType || '' } : record.data).filter(([key, value]) => value !== '' || key === 'equipmentType').map(([key, value]) => ({ key, label: text(key), children: <span className="preserve-text">{display(value)}</span> }))} />{kind === 'equipment' && <section aria-label={text('equipmentAttachments')}><h4>{text('attachments')}</h4><Table<BusinessRecord> rowKey="id" size="small" dataSource={equipmentAttachments(records, record, archived)} pagination={{ pageSize: 8, hideOnSinglePage: true }} scroll={{ x: 480 }} columns={[
      { title: text('name'), render: (_, file) => <span className="preserve-text">{display(file.data.name)}</span> },
      { title: text('size'), width: 110, render: (_, file) => `${(Number(file.data.size) / 1024).toFixed(1)} KB` },
      { title: text('actions'), width: 150, render: (_, file) => <Space><Button icon={<Download size={15} />} onClick={() => downloadFile(file)}>{text('download')}</Button>{recordActions(file)}</Space> },
    ]} /></section>}</> }} /></>
  }
  const filters = <div className="business-filters"><Input prefix={<Search size={15} />} value={query} onChange={event => setQuery(event.target.value)} placeholder={text('search')} aria-label={text('search')} allowClear />{view === 'vehicles' && <Select allowClear placeholder={text('status')} value={filter} onChange={setFilter} options={statuses.map(value => ({ value, label: text(value) }))} />}<Checkbox checked={archived} onChange={event => setArchived(event.target.checked)}>{text('showArchived')}</Checkbox></div>
  const reportVehicles = new Map(cars.map(car => [car.id, car]))
  const visibleReports = view === 'reports' ? reports.filter(record => (!reportVehicle || record.vehicleId === reportVehicle) && matchesReportSearch(record, reportVehicles.get(record.vehicleId || ''), query)) : []
  const selectedReports = reports.filter(record => reportSelection.includes(record.id))
  const canCompare = reportSelection.length === 2 && selectedReports.length === 2 && selectedReports.every(record => !record.archived) && selectedReports[0].vehicleId === selectedReports[1].vehicleId && Boolean(reportAssociationVin(selectedReports[0])) && reportAssociationVin(selectedReports[0]) === reportAssociationVin(selectedReports[1])

  const visibleAudit = view === 'audit' ? audit.filter(entry => `${entry.actor} ${text(entry.action)} ${JSON.stringify(entry.detail)} ${JSON.stringify(entry.identity || {})}`.toLowerCase().includes(query.toLowerCase())) : []
  const selectedController = configuration?.controllerIndex !== null && configuration?.controllerIndex !== undefined ? (configuration.report.data as unknown as ReportData).parsed.controllers[configuration.controllerIndex] : null
  const targetParts = configuration && selectedController ? records.filter(record => record.kind === 'part' && record.vehicleId === configuration.report.vehicleId && record.data.category === 'controller' && !record.archived && keyControllerName(record.data.name) === keyControllerName(selectedController.name)) : []
  const olderReport = Boolean(configuration?.part && doveRecordedTime(configuration.report.data.recordedAt) < doveRecordedTime(configuration.part.data.reportRecordedAt))
  const duplicateTarget = targetParts.length > 1
  const conflictingSources = configuration ? controllerSources(configuration.report).filter(item => keyControllerName(item.controller.name) && controllerSources(configuration.report).filter(other => keyControllerName(other.controller.name) === keyControllerName(item.controller.name)).length > 1) : []
  if (!hasSnapshot) return <section className="business-workspace"><div className="page-heading"><h1>{text(view)}</h1></div>{loadError ? <Alert type="error" showIcon title={language === 'zh' ? '暂时无法加载数据' : 'Data could not be loaded'} description={errorText(loadError, language)} action={<Button icon={<RefreshCw size={16} />} loading={loading} onClick={() => void load()}>{language === 'zh' ? '重新加载' : 'Retry loading'}</Button>} /> : <Spin />}</section>
  return <section className="business-workspace"><div className="page-heading"><h1>{text(view)}</h1><Space wrap>{view === 'vehicles' && <Button type="primary" icon={<Plus size={16} />} onClick={() => setEditor({ kind: 'vehicle', vehicleId: null, record: null })}>{text('addVehicle')}</Button>}{view === 'sync' && <Button type="primary" loading={busy} icon={<FolderSync size={16} />} onClick={() => void synchronize()}>{text('syncNow')}</Button>}</Space></div>
    {loadError && <Alert className="connection-alert" type="warning" showIcon title={language === 'zh' ? '刷新未完成，当前显示上次加载的数据' : 'Refresh failed. Showing the last loaded data.'} description={errorText(loadError, language)} action={<Button icon={<RefreshCw size={16} />} loading={loading} onClick={() => void load()}>{language === 'zh' ? '重新加载' : 'Retry loading'}</Button>} />}
    {(sync.error || sync.pending > 0 || sync.conflicts.length > 0 || sync.quarantined > 0) && view !== 'sync' && <Alert className="business-notice" type="warning" showIcon title={sync.error ? errorText(sync.error, language) : `${text('pending')}: ${sync.pending} · ${text('conflicts')}: ${sync.conflicts.length} · ${text('quarantined')}: ${sync.quarantined}`} />}
    {deleteReceipt && !deleteReceipt.localSynced && <Alert className="business-notice" type="warning" showIcon title={text('deleteCommittedPending')} />}
    {view === 'vehicles' && <><div className="fleet-stats"><div><span>{text('vehicles')}</span><strong>{cars.filter(car => !car.archived).length}</strong></div>{statuses.slice(0, 3).map(status => <div key={status}><span>{text(status)}</span><strong>{cars.filter(car => !car.archived && car.data.status === status).length}</strong></div>)}</div>
      <ResizableVehicleTable language={language} preferences={tablePreferences.layout} onPreferencesChange={tablePreferences.onChange} saveStatus={tablePreferences.saveStatus} retry={tablePreferences.retry}
        toolbarFilters={filters}
        toolbarActions={<><Button icon={<FileSpreadsheet size={16} />} onClick={() => setCsvExportOpen(true)}>{text('exportCsv')}</Button></>}
        toolbarMenu={admin && <Dropdown trigger={['click']} menu={{
          items: [
            { key: 'backup', label: language === 'zh' ? '备份数据' : 'Back up data', icon: <Download size={16} />, disabled: !online, onClick: () => void startBackup() },
            { key: 'restore', label: text('restoreBackup'), icon: <RotateCcw size={16} />, disabled: !online || syncPaused, onClick: () => setRestoreOpen(true) },
            { key: 'restore-results', label: language === 'zh' ? '恢复记录' : 'Restore history', icon: <ClipboardCheck size={16} />, onClick: () => void showReceipts() },
          ]
        }}><Button icon={<Ellipsis size={18} />} aria-label={text('more')} title={text('more')} /></Dropdown>}
        filters={vehicleColumnFilters} onFiltersChange={setVehicleColumnFilters} filterVehicles={cars.filter(car => archived || !car.archived)} filterValues={vehicleFilterValues} filterScopeKey={JSON.stringify([query, filter, archived])}
        rowKey="id" loading={loading} size="middle" pagination={{ pageSize: 10, hideOnSinglePage: true }} dataSource={cars.filter(car => (archived || !car.archived) && (!filter || car.data.status === filter) && Object.values(car.data).join(' ').toLowerCase().includes(query.toLowerCase()))} columns={[
          { key: 'vehicle', title: text('vehicle'), width: 250, fixed: 'left', render: (_, record) => {
            const watched = Object.hasOwn(watch.vehicles, record.id)
            return <div className="vehicle-identity"><Tooltip title={text(watched ? 'unwatchVehicle' : 'watchVehicle')}><button type="button" className={`car-symbol vehicle-watch-toggle${watched ? ' car-symbol-watched' : ''}`} aria-label={`${text('watchVehicle')} · ${display(record.data.name)}`} aria-pressed={watched} onClick={() => markVehicle(record.id, watched ? undefined : 'gold')}><CarFront size={21} aria-hidden="true" /></button></Tooltip><button className="record-link vehicle-details-link" title={text('openVehicleDetails')} onClick={() => openVehicle(record.id)}><span><strong>{display(record.data.name)}</strong><small className="mono">{display(record.data.vin)}</small></span><ChevronRight size={14} className="vehicle-details-chevron" aria-hidden="true" /></button></div>
          } },
          { key: 'project', title: text('project'), width: 100, render: (_, record) => display(record.data.project) }, { key: 'plate', title: text('plate'), width: 140, render: (_, record) => <div className="record-title">{display(record.data.plate)}<small className={record.data.plateExpiry && String(record.data.plateExpiry) < today ? 'expired-date' : ''}>{display(record.data.plateExpiry)}</small></div> },
          { key: 'status', title: text('status'), width: 110, render: (_, record) => record.archived ? <Tag>{text('archived')}</Tag> : statusTag(String(record.data.status)) },
          { key: 'physicalLocation', title: text('physicalLocation'), width: 180, ellipsis: { showTitle: false }, render: (_, record) => <Tooltip title={display(record.data.physicalLocation)}><span>{display(record.data.physicalLocation)}</span></Tooltip> },
          {
            key: 'hvBatteryMaturityLevel', title: text('hvBatteryMaturityLevel'), width: 220, ellipsis: { showTitle: false }, render: (_, record) => {
              const maturity = activeHvBatteries(records, record.id).map(battery => display(battery.data.maturity)).join(' / ') || '—'
              return <Tooltip title={maturity}><button className="inline-link hv-battery-maturity-link" aria-label={`${text('hvBatteryMaturityLevel')} ${record.data.vin}`} onClick={() => openVehicle(record.id, 'hvBattery')}>{maturity}</button></Tooltip>
            }
          },
          { key: 'owner', title: text('owner'), width: 130, render: (_, record) => display(record.data.owner) },
          { key: 'latestDove', title: text('latestDove'), width: 150, render: (_, record) => { const report = reports.find(item => item.vehicleId === record.id && !item.archived); return report ? <button className="inline-link" onClick={() => setReportId(report.id)}>{display(report.data.recordedAt)}</button> : '—' } },
          { key: 'updated', title: text('updated'), width: 160, render: (_, record) => <div className="record-title">{date(record.updated)}<small>v{record.version}</small></div> }, { key: 'actions', title: text('actions'), width: 100, render: (_, record) => <Button type="text" icon={<ArrowUpRight size={17} />} aria-label={`${text('details')} ${record.data.name}`} onClick={() => openVehicle(record.id)} /> },
          ...(['model', 'color', 'thermal', 'notes'] as const).map(field => ({
            key: field, title: text(field), width: field === 'notes' ? 240 : field === 'thermal' ? 200 : 160, ellipsis: { showTitle: false }, render: (_: unknown, record: BusinessRecord) => {
              const value = field === 'thermal' && thermalSystemTypes.some(type => type === record.data[field]) ? text(String(record.data[field])) : display(record.data[field])
              return <Tooltip title={value}><span>{value}</span></Tooltip>
            }
          })),
          ...([{ key: 'hvBatteryPartNumber', field: 'productPart' }, { key: 'hvBatterySerialNumber', field: 'serial' }] as const).map(({ key, field }) => ({
            key, title: text(key), width: 220, ellipsis: { showTitle: false }, render: (_: unknown, record: BusinessRecord) => {
              const value = activeHvBatteries(records, record.id).map(battery => display(battery.data[field])).join(' / ') || '—'
              return <Tooltip title={value}><span>{value}</span></Tooltip>
            }
          })),
          {
            key: 'vcuType', title: text('vcuType'), width: 160, ellipsis: { showTitle: false }, render: (_, record) => {
              const value = display(controllerFor(record.id, 'VCU')?.data.controllerType)
              return <Tooltip title={value}><span className="vehicle-vcu-type">
                {value === 'Open ECU' && <img className="vehicle-vcu-type-icon" src="/open-ecu.png" width={35} height={32} alt="" aria-hidden="true" />}
                <span className="vehicle-vcu-type-label">{value}</span>
              </span></Tooltip>
            }
          },
          ...([{ field: 'name', width: 180 }, { field: 'vin', width: 220 }, { field: 'plateExpiry', width: 180 }, { field: 'complianceLevel', width: 180 }, { field: 'coolingArchitecture', width: 200 }] as const).map(({ field, width }) => ({
            key: vehicleOverviewColumnIds[field], title: text(field === 'name' ? 'nickName' : field), width, ellipsis: { showTitle: false }, render: (_: unknown, record: BusinessRecord) => {
              const value = display(record.data[field])
              return <Tooltip title={value}><span className={field === 'vin' ? 'mono' : undefined}>{value}</span></Tooltip>
            },
          })),
          { key: 'configurationRevision', title: text('configurationRevision'), width: 220, ellipsis: { showTitle: false }, render: (_, record) => {
            const current = revisionSummaries.find(summary => summary.vehicleId === record.id)
            return current ? <Space direction="vertical" size={3}><button className="inline-link" onClick={() => openVehicle(record.id, 'configurationRevisions')}>{current.label}</button>{current.hasChanges && <Tag color="warning">{text('unpublishedConfigurationChanges')}</Tag>}</Space> : '—'
          } },
        ]} /></>}
    <DoveImport active={view === 'dove'} language={language} vehicles={cars} disabled={busy} onBusyChange={setBusy} onRetained={loadScoped} onOpenReport={async (id, scope, signal) => { await loadScoped(scope, signal); scope.assertCurrent(signal); setReportId(id) }} onError={onError} />
    {view === 'reports' && <section className="report-archive workspace-panel"><div className="business-table-controls"><div className="business-filters report-filters"><Select showSearch allowClear optionFilterProp="label" aria-label={text('selectReportVehicle')} placeholder={text('selectReportVehicle')} value={reportVehicle} onChange={value => { setReportVehicle(value); setReportSelection([]) }} options={cars.map(car => ({ value: car.id, label: `${display(car.data.model || car.data.name)} · ${display(car.data.vin)}` }))} /><Input allowClear prefix={<Search size={15} />} aria-label={text('reportCompoundSearch')} placeholder={text('reportCompoundSearch')} value={query} onChange={event => { setQuery(event.target.value); setReportSelection([]) }} /></div></div><div className="report-selection-bar"><div className="report-selection-summary"><span>{text('reports')} · {visibleReports.length}</span><span className="muted">{text('selected')}: {reportSelection.length}</span><Button type="text" size="small" disabled={!reportSelection.length || busy} onClick={() => setReportSelection([])}>{text('clearSelection')}</Button></div><Space className="report-bulk-actions"><Button size="small" disabled={!reportSelection.length || busy} icon={<Download size={16} />} onClick={() => void downloadReports()}>{text('downloadSelected')}</Button>{admin && <Button size="small" disabled={!online || busy || !selectedReports.some(record => !record.archived)} onClick={() => { setBatchReason(''); setBatchArchive(true) }}>{text('archive')}</Button>}<Tooltip title={!canCompare ? text('selectTwoReports') : ''}><Button size="small" disabled={!canCompare || busy} icon={<GitCompare size={16} />} onClick={() => void compare()}>{text('compare')}</Button></Tooltip></Space></div>{reportTable(visibleReports, true)}</section>}

    {view === 'history' && <HistoryPanel language={language} refreshToken={historyRevision} reportIds={records.filter(record => record.kind === 'report').map(record => record.id)} onOpenReport={setReportId} />}
    {view === 'audit' && <section className="workspace-panel audit-panel"><div className="business-table-controls"><div className="business-filters"><Input prefix={<Search size={15} />} placeholder={text('search')} aria-label={text('search')} allowClear value={query} onChange={event => setQuery(event.target.value)} /></div></div><div className="business-list-heading"><h3>{text('audit')}</h3><span>{visibleAudit.length}</span></div><Table<AuditEntry> rowKey="id" size="small" dataSource={visibleAudit} scroll={{ x: 870 }} pagination={{ pageSize: 15 }} columns={[{ title: text('created'), width: 180, render: (_, entry) => date(entry.created) }, { title: text('actor'), width: 150, render: (_, entry) => entry.identity?.source === 'unknown' ? <span>{language === 'zh' ? '历史身份未确认' : 'Unconfirmed historical identity'}<small className="mono">{entry.actor}</small></span> : entry.actor }, { title: text('actions'), width: 180, render: (_, entry) => text(entry.action) }, { title: text('details'), width: 360, render: (_, entry) => <AuditDetails entry={entry} language={language} text={text} /> }]} /></section>}
    {view === 'sync' && <section className="workspace-panel sync-panel">
      <Alert type={sync.error || sync.conflicts.length || sync.quarantined ? 'warning' : 'success'} showIcon icon={sync.error ? <CloudOff size={18} /> : undefined} title={sync.error ? errorText(sync.error, language) : text(sync.phase)} />
      {sync.progress && <p role="status" aria-live="polite">{({ opening: ['Reading shared data', '正在读取共享数据'], operations: ['Saving change files', '正在保存变更文件'], records: ['Applying records', '正在处理记录'], publishing: ['Publishing team data', '正在发布团队数据'], refreshing: ['Refreshing this device', '正在刷新本机数据'] }[sync.progress.stage])[language === 'zh' ? 1 : 0]}{sync.progress.total > 0 ? ` · ${sync.progress.completed} / ${sync.progress.total}` : ''}</p>}
      <div className="sync-metrics">{[{ key: 'pending', value: sync.pending }, { key: 'conflicts', value: sync.conflicts.length }, { key: 'quarantined', value: sync.quarantined }].map(item => <div key={item.key}><span>{text(item.key)}</span><strong>{item.value}</strong></div>)}</div>
      <div className="sync-update-meta"><Tooltip title={`${text('lastSync')}: ${sync.lastSync ? date(sync.lastSync) : '—'}`}><span tabIndex={0}><Clock3 size={13} aria-hidden="true" />{text('lastSync')} · {sync.lastSync ? new Date(sync.lastSync).toLocaleTimeString(language === 'zh' ? 'zh-CN' : 'en-GB', { hour: '2-digit', minute: '2-digit', hour12: false }) : '—'}</span></Tooltip><span>{text('revision')} · {sync.revision || '—'}</span></div>
      <div className="business-list-heading"><h3>{text('conflicts')}</h3><span>{sync.conflicts.length}</span></div>
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
    </section>}

    <Drawer className="vehicle-detail-drawer" open={Boolean(selected)} closable={!revisionBusy} onClose={() => { if (revisionBusy) return; attachmentCancel.current?.(); equipmentCancel.current?.(); setEditor(current => current?.kind === 'equipment' ? null : current); setSelectedId(null) }} title={selected ? display(selected.data.name) : ''} size={1000} destroyOnHidden extra={selected && recordActions(selected)}><Tabs className="vehicle-detail-tabs" activeKey={detailTab} onChange={setDetailTab} items={selected ? [
      { key: 'overview', label: text('overview'), children: <VehicleOverview vehicle={selected} language={language} busy={busy} onEdit={() => setEditor({ kind: 'vehicle', vehicleId: null, record: selected })} onChanged={load} onError={onError} onBusyChange={setBusy} /> },
      { key: 'configurationRevisions', label: text('configurationRevisions'), children: <ConfigurationRevisions key={selected.id} vehicle={selected} records={records} language={language} online={online} syncPaused={syncPaused} admin={admin} catalog={catalog} current={revisionSummaries.find(summary => summary.vehicleId === selected.id)} onChanged={loadScoped} onBusyChange={value => { setRevisionBusy(value); setBusy(value) }} onError={onError} /> },
      { key: 'parts', label: text('parts'), children: controllerTable(selected, true) },
      { key: 'hvBattery', label: text('hvBattery'), children: hvBatteryTable(selected) },
      { key: 'emotor', label: text('emotor'), children: <ComponentSections key={`${selected.id}:emotor`} vehicle={selected} records={records} typeId="emotor" language={language} catalog={catalog} disabled={busy} includeArchived={archived} onChanged={loadScoped} onBusyChange={setBusy} onError={onError} /> },
      { key: 'thermal-management', label: text('thermalManagement'), children: <ComponentSections key={`${selected.id}:thermal`} vehicle={selected} records={records} typeId="thermal-management" language={language} catalog={catalog} disabled={busy} includeArchived={archived} onChanged={loadScoped} onBusyChange={setBusy} onError={onError} /> },
      ...catalog.types.filter(type => !type.builtin && showWorkingComponentType(type, catalog.policyEnabled, records.some(record => record.kind === 'part' && record.vehicleId === selected.id && record.data.componentTypeId === type.id))).map(type => ({ key: `component:${type.id}`, label: type.label[language === 'zh' ? 1 : 0], children: <ComponentSections key={`${selected.id}:${type.id}`} vehicle={selected} records={records} typeId={type.id} language={language} catalog={catalog} disabled={busy} includeArchived={archived} onChanged={loadScoped} onBusyChange={setBusy} onError={onError} /> })),
      { key: 'modifications', label: text('modifications'), children: <VehicleModificationSection key={selected.id} vehicle={selected} records={records} language={language} enabled={modificationEnabled} admin={admin} online={online} syncPaused={syncPaused} disabled={busy} includeArchived={archived} onChanged={loadScoped} onBusyChange={setBusy} onCancelReady={cancel => { attachmentCancel.current = cancel }} onError={onError} /> }, { key: 'equipment', label: text('equipment'), children: entryTable('equipment', selected) },
      { key: 'reports', label: text('reports'), children: <section><div className="section-toolbar"><h3>{text('reports')}</h3></div>{reportTable(reports.filter(record => record.vehicleId === selected.id && (!record.archived || archived)))}</section> },
      { key: 'attachments', label: text('attachments'), children: <section className="vehicle-attachments"><AttachmentUpload heading={text('attachments')} key={selected.id} vehicle={selected} language={language} disabled={busy} onRefresh={loadScoped} onBusyChange={setBusy} onCancelReady={cancel => { attachmentCancel.current = cancel }} onError={onError} /><Table<BusinessRecord> rowKey="id" size="small" dataSource={records.filter(record => record.kind === 'attachment' && record.vehicleId === selected.id && (archived || !record.archived))} columns={[{ title: text('name'), render: (_, record) => display(record.data.name) }, { title: text('equipmentAttachmentEquipment'), render: (_, record) => attachmentEquipment(record) }, { title: text('size'), render: (_, record) => `${(Number(record.data.size) / 1024).toFixed(1)} KB` }, { title: text('actions'), render: (_, record) => <Space>{/\.(xlsx|xls|pdf|png|jpe?g|jfif)$/i.test(String(record.data.name)) && <Button icon={<Eye size={15} />} onClick={() => setAttachmentPreview(record)}>{language === 'zh' ? '预览' : 'Preview'}</Button>}<Button icon={<Download size={15} />} onClick={() => downloadFile(record)}>{text('download')}</Button>{recordActions(record)}</Space> }]} locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={text('noRecords')} /> }} /></section> },
      { key: 'history', label: text('history'), children: <section><div className="section-toolbar"><h3>{text('history')}</h3></div><HistoryPanel key={selected.id} language={language} vehicleId={selected.id} refreshToken={historyRevision} reportIds={records.filter(record => record.kind === 'report').map(record => record.id)} onOpenReport={setReportId} /></section> },
    ] : []} /></Drawer>
    {csvExportOpen && <CsvExportDialog records={records} language={language} online={online} syncPaused={syncPaused} syncStatus={sync} onCancel={() => setCsvExportOpen(false)} onBusyChange={setBusy} onError={onError} onRefresh={async () => { const next = await api<ConfigurationWorkingView>('/api/business/export/working-view'); const available = next.records.filter(record => !deletedRecordIds.current.has(record.id) && !deletedRecordIds.current.has(record.vehicleId || record.id)); workspaceLoader.invalidate(); setRecords(available); setCatalog(next.catalog); setModificationEnabled(Boolean(next.modificationEnabled)); setRevisionSummaries(next.revisionSummaries.filter(summary => !deletedRecordIds.current.has(summary.vehicleId))); return available }} />}
    {deleteVehicle && <VehicleDeleteDialog key={deleteVehicle.id} vehicle={deleteVehicle} language={language} allowed={admin && online} syncPaused={syncPaused} onCancel={() => setDeleteVehicle(null)} onBusyChange={setBusy} onDeleted={vehicleDeleted} onError={onError} />}
    {editor && (editor.kind === 'equipment' ? editorVehicle && <EquipmentRecordEditor key={`${editorVehicle.id}:${editor.record?.id || 'new'}`} vehicle={editorVehicle} record={editor.record} records={records} language={language} onCancel={() => setEditor(null)} onSaved={loadScoped} onBusyChange={setBusy} onCancelReady={cancel => { equipmentCancel.current = cancel }} onError={onError} /> : <RecordEditor record={editor.record} kind={editor.kind} initialName={editor.initialName} initialCategory={editor.initialCategory} language={language} busy={busy} onCancel={() => { if (!busy) setEditor(null) }} onSave={(data, reason) => void saveRecord(data, reason)} />)}
    <Modal open={Boolean(action)} title={action ? text(action.type === 'remove' ? 'recordRemoval' : action.archived ? 'archive' : 'restore') : ''} onCancel={() => { if (!busy) setAction(null) }} onOk={() => void applyAction()} confirmLoading={busy} okText={text('save')} cancelText={text('cancel')} okButtonProps={{ disabled: !actionReason.trim() || Boolean(action?.groupVersions && Object.keys(action.groupVersions).length && (!online || syncPaused)) }}><p className="operation-name">{display(action?.record.data.name)}</p>{action?.archived && action.groupVersions && Object.keys(action.groupVersions).length > 0 && <Alert type="info" showIcon title={text('modificationArchiveVehicleNotice')} />}<label className="standalone-label">{text('reason')}<Input.TextArea value={actionReason} maxLength={500} rows={3} onChange={event => setActionReason(event.target.value)} /></label></Modal>
    <Modal open={Boolean(activeReport)} onCancel={() => setReportId(null)} title={activeReport ? display(activeReport.data.name) : ''} footer={null} width={1150} destroyOnHidden>{activeReport && <><div className="report-actions"><Button icon={<Download size={16} />} onClick={() => downloadFile(activeReport)}>{text('download')}</Button><Button type="primary" icon={<ClipboardCheck size={16} />} disabled={activeReport.archived || !cars.some(car => !car.archived && reportMatchesVehicle(activeReport, car))} onClick={() => openConfiguration(activeReport)}>{text('updateConfiguration')}</Button>{recordActions(activeReport)}</div><Suspense fallback={<Spin />}><ReportViewer report={(activeReport.data as unknown as ReportData).parsed} record={activeReport} language={language} /></Suspense></>}</Modal>
    <AttachmentPreview record={attachmentPreview} language={language} onClose={() => setAttachmentPreview(null)} />
    <Modal open={batchArchive} onCancel={() => !busy && setBatchArchive(false)} title={`${text('archive')} · ${selectedReports.filter(record => !record.archived).length}`} onOk={() => void archiveReports()} confirmLoading={busy} okButtonProps={{ disabled: !batchReason.trim() }}><label>{text('reason')}<Input.TextArea value={batchReason} onChange={event => setBatchReason(event.target.value)} maxLength={500} rows={3} /></label></Modal>
    <Modal open={compareOpen} onCancel={() => { comparisonRequest.current?.abort(); setCompareOpen(false); setComparison(null) }} title={text('compare')} footer={null} width={1200} destroyOnHidden>{busy ? <Spin /> : comparison ? <><div className="comparison-names">{[comparison.left, comparison.right].map((report, index) => <div className="comparison-report-identity" key={report.id}><span>{text(index === 0 ? 'baselineReport' : 'comparedReport')}</span><strong>{display(report.data.recordedAt).replace(/(\d{2})h(\d{2})/, '$1:$2')}</strong><div>{display(report.data.name)}</div></div>)}</div><Checkbox checked={onlyDifferences} onChange={event => setOnlyDifferences(event.target.checked)}>{text('onlyDifferences')}</Checkbox><Tabs items={['controllers', 'faults'].map(kind => { const rows = comparison[kind as 'controllers' | 'faults']; const changed = rows.filter(row => row.status !== 'unchanged'); return { key: kind, label: `${text(kind)} · ${changed.length} / ${rows.length}`, children: <Table<Difference> rowKey="key" dataSource={onlyDifferences ? changed : rows} locale={{ emptyText: text('noReportDifferences') }} size="small" pagination={{ pageSize: 10, hideOnSinglePage: true }} expandable={{ expandedRowRender: record => <ReportDifference record={record} text={text} leftLabel={`${text('baselineReport')} · ${display(comparison.left.data.recordedAt).replace(/(\d{2})h(\d{2})/, '$1:$2')}`} rightLabel={`${text('comparedReport')} · ${display(comparison.right.data.recordedAt).replace(/(\d{2})h(\d{2})/, '$1:$2')}`} /> }} columns={[{ title: text(kind === 'controllers' ? 'controller' : 'code'), dataIndex: 'key' }, { title: text('status'), render: (_, record) => <Tag color={record.status === 'changed' || record.status === 'ambiguous' ? 'warning' : record.status === 'added' ? 'processing' : 'default'}>{text(record.status)}</Tag> }, { title: text('changedFields'), render: (_, record) => record.fields.length ? record.fields.map(text).join(' · ') : '—' }]} /> } })} /></> : <Button onClick={() => void compare()}>{text('retry')}</Button>}</Modal>

    <Modal open={Boolean(configuration)} onCancel={() => { if (!busy) setConfiguration(null) }} title={text('updateConfiguration')} width={950} confirmLoading={busy} onOk={() => void applyConfiguration()} okText={text('save')} cancelText={text('cancel')} okButtonProps={{ disabled: !configuration || configuration.controllerIndex === null || !configuration.fields.length || !configuration.reason.trim() || duplicateTarget || (olderReport && !configuration.allowOlder) }} destroyOnHidden>{configuration && <div className="configuration-form">
      <label>{text('matchedDoveReport')}<Select value={configuration.report.id} onChange={id => { const report = reports.find(record => record.id === id); if (report) openConfiguration(report, selectedController ? keyControllerName(selectedController.name) || undefined : undefined) }} options={reports.filter(report => report.vehicleId === configuration.report.vehicleId && !report.archived && cars.some(car => !car.archived && reportMatchesVehicle(report, car)) && controllerSources(report).length > 0).map(report => ({ value: report.id, label: `${report.data.name} · ${report.data.recordedAt || '—'}` }))} /></label>
      {Boolean(configuration.report.data.association) && <Alert type="warning" showIcon title={text('manualVehicleWarning')} description={`${text('manualVehicleTarget')}: ${reportAssociationVin(configuration.report) || '—'}`} />}
      {conflictingSources.length > 0 && <Alert type="warning" showIcon title={text('controllerSourceConflict')} />}
      <label>{text('controller')}<Select value={configuration.controllerIndex} placeholder={text('controller')} onChange={value => chooseController(configuration.report, value)} options={controllerSources(configuration.report).map(({ controller, index }) => ({ value: index, label: `${keyControllerName(controller.name) || controller.name} (${controller.name}) · ${controller.network} · ${controller.serial || '—'} · ${controller.software || '—'} · #${index + 1}` }))} /></label>
      {duplicateTarget && <Alert type="warning" showIcon title={text('duplicateControllerRecords')} />}
      {selectedController && <Table rowKey="field" dataSource={configurationFields.map(field => ({ field, current: configuration.part?.data[field], incoming: selectedController[field] }))} rowSelection={{ selectedRowKeys: configuration.fields, onChange: keys => setConfiguration({ ...configuration, fields: keys.map(String) }), getCheckboxProps: record => ({ disabled: !validControllerValue(record.incoming) }) }} pagination={false} size="small" scroll={{ x: 600 }} columns={[{ title: text('applyFields'), render: (_, record) => text(record.field) }, { title: text('currentValue'), render: (_, record) => <span className="preserve-text">{display(record.current)}</span> }, { title: text('reportValue'), render: (_, record) => <span className="preserve-text">{display(record.incoming)}{!validControllerValue(record.incoming) && <Tag>{text('invalidReportValue')}</Tag>}</span> }]} />}
      {olderReport && <Alert type="warning" showIcon title={text('olderReport')} description={<Checkbox checked={configuration.allowOlder} onChange={event => setConfiguration({ ...configuration, allowOlder: event.target.checked })}>{text('confirmOlderReport')}</Checkbox>} />}
      <label>{text('configurationReason')}<Input.TextArea value={configuration.reason} maxLength={500} rows={2} onChange={event => setConfiguration({ ...configuration, reason: event.target.value })} /></label>
    </div>}</Modal>
    <Modal width={850} styles={{ body: { maxHeight: '65vh', overflowY: 'auto' } }} open={receiptsOpen} title={language === 'zh' ? '恢复记录' : 'Restore history'} onCancel={() => setReceiptsOpen(false)} footer={<Button onClick={() => void showReceipts()}>{text('refresh')}</Button>}><p>{language === 'zh' ? '本机数据目录 restore-backups 中的保护副本保留至管理员手动清理。待发布状态可安全重试，不会再次应用备份。' : 'Safety copies in restore-backups in the local data directory are retained until manually removed. Retrying publication never reapplies the backup.'}</p><Table rowKey="requestId" size="small" pagination={{ pageSize: 5 }} dataSource={receipts} columns={[{ title: language === 'zh' ? '时间 / 编号' : 'Time / ID', render: (_, receipt) => <>{receipt.created}<br /><small>{receipt.requestId}</small></> }, { title: language === 'zh' ? '状态' : 'State', render: (_, receipt) => <>{receipt.error === 'MODIFICATION_RESTORE_REVIEW_REQUIRED' ? (language === 'zh' ? '载荷已保留，需重新审核' : 'Payload retained; review required') : language === 'zh' ? ({ prepared: '未执行恢复，请重新选择备份', applied: '已恢复到本机，需核对团队同步', published: '恢复完成，已同步到团队', failed: '恢复未完成，业务数据未改变' }[receipt.state]) : receipt.state}{receipt.result && <div>{receipt.result.changed} {language === 'zh' ? '项变更' : 'changes'}</div>}{receipt.error && <div>{errorText(receipt.error, language)}</div>}</> }, { title: language === 'zh' ? '操作' : 'Action', render: (_, receipt) => <Space direction="vertical">{receipt.state === 'applied' && <Button disabled={busy || syncPaused || !online} onClick={async () => { setBusy(true); try { await api(`/api/business/restore/${receipt.requestId}/publish`, { method: 'POST' }); await showReceipts(); await load() } catch (error) { onError(error) } finally { setBusy(false) } }}>{language === 'zh' ? '检查并继续同步' : 'Check and finish syncing'}</Button>}{Boolean(receipt.pendingModificationImportIds?.length) && <><Button disabled={busy} onClick={() => void download(`/api/business/restore/${receipt.requestId}/modification-import`, 'retained-modification-restore.zip').catch(onError)}>{language === 'zh' ? '导出保留载荷' : 'Export retained payload'}</Button><Button disabled={busy || syncPaused || !online} onClick={() => reviewSharedRestore(receipt)}>{language === 'zh' ? '保留并重新审核' : 'Retain and review again'}</Button></>}</Space> }]} expandable={{ expandedRowRender: receipt => <p className="preserve-text">{receipt.safetyFile || '—'}<br />SHA-256: {receipt.safetySha256 || '—'}<br />{receipt.result?.syncError ? errorText(receipt.result.syncError, language) : ''}</p> }} /></Modal>
    <Modal width={900} styles={{ body: { maxHeight: '65vh', overflowY: 'auto' } }} open={restoreOpen} title={text('restoreBackup')} onCancel={() => { if (!busy) { setRestoreOpen(false); setRestoreFile(null); setRestorePreview(null); setArchiveRecordIds([]); setConfirmDroppedFields(false); setConfirmation(''); setRestoreReason('') } }} onOk={() => void restore()} okText={text('restore')} cancelText={text('cancel')} confirmLoading={busy} okButtonProps={{ disabled: syncPaused || !restoreFile || !restorePreview || confirmation !== 'RESTORE' || !restoreReason.trim() || sync.pending > 0 || Boolean(restorePreview?.conflicts.length) || Boolean(restorePreview?.archiveCandidates.some(record => !archiveRecordIds.includes(record.id))) || Boolean(restorePreview?.droppedFields.length && !confirmDroppedFields) }} destroyOnHidden><div className="configuration-form">{!restorePreview && <p>{language === 'zh' ? '请选择以前保存的备份，下一步查看恢复影响。' : 'Choose a saved backup to review its effects.'}</p>}{syncPaused && <Alert type="warning" showIcon title={errorText('CONFIRM_RESUME', language)} />}{sync.pending > 0 && <Alert type="warning" title={text('pendingBeforeRestore')} />}<Upload disabled={busy} accept=".zip" maxCount={1} fileList={restoreFile ? [{ uid: 'backup', name: restoreFile.name, status: 'done' }] : []} beforeUpload={file => { void previewRestore(file); return false }} onRemove={() => { setRestoreFile(null); setRestorePreview(null); setArchiveRecordIds([]); setConfirmDroppedFields(false); setConfirmation(''); setRestoreReason('') }}><Button icon={<UploadIcon size={16} />} loading={busy}>{text('chooseFile')} · .zip</Button></Upload>{restorePreview && <div className="configuration-form"><h3>{text('restorePreview')}</h3><Alert type="info" showIcon title={language === 'zh' ? '执行前自动保存本机保护副本，请另做独立冷备份。恢复不回退权限、永久删除或不可变配置历史。' : 'A local safety copy is saved before applying. Keep an independent cold backup. Permissions, permanent deletion and immutable history are not rolled back.'} /><p>{restorePreview.teamId} · {restorePreview.created} · {language === 'zh' ? '格式' : 'Format'} {restorePreview.format}</p>{restorePreview.source && <Alert type={restorePreview.source.pending || restorePreview.source.conflicts ? 'warning' : 'info'} title={`${language === 'zh' ? '备份时待同步 / 冲突' : 'Pending / conflicts at backup'}: ${restorePreview.source.pending} / ${restorePreview.source.conflicts}`} description={restorePreview.source.revision || '—'} />}<Input.Search allowClear value={restoreSearch} onChange={event => setRestoreSearch(event.target.value)} placeholder={language === 'zh' ? '搜索车辆、记录或字段' : 'Search vehicles, records or fields'} /><Table size="small" rowKey="id" scroll={{ x: 650 }} pagination={{ pageSize: 8 }} dataSource={restorePreview.effects.filter(effect => JSON.stringify(effect).toLowerCase().includes(restoreSearch.toLowerCase()))} columns={[{ title: language === 'zh' ? '记录 / 车辆' : 'Record / vehicle', render: (_, effect) => <>{effect.name}<br /><small>{effect.vehicleName || effect.vehicleId || effect.id}</small></> }, { title: language === 'zh' ? '类别' : 'Kind', dataIndex: 'kind', render: value => text(value) }, { title: language === 'zh' ? '影响' : 'Effect', dataIndex: 'action', render: (value: string) => language === 'zh' ? ({ add: '新增', change: '覆盖', unchanged: '保持', skip: '跳过已删除', archive: '归档' }[value] || value) : value }]} expandable={{ rowExpandable: effect => effect.fields.length > 0, expandedRowRender: effect => <Descriptions column={1} size="small" items={effect.fields.map(field => ({ key: field.key, label: text(field.key), children: <span className="preserve-text">{display(field.before)} → {display(field.after)}</span> }))} /> }} /><p>{text('restoreVersion')} {restorePreview.appVersion || 'legacy'} · {restorePreview.records} {text('restoreRecords')} · {restorePreview.additions} {text('restoreAdditions')} · {restorePreview.changes} {text('restoreChanges')}</p>{restorePreview.conflicts.length > 0 && <Alert type="error" showIcon title={text('restoreConflicts')} description={restorePreview.conflicts.join(', ')} />}{restorePreview.archiveCandidates.length > 0 && <div><p>{text('restoreArchiveConfirm')}</p><Checkbox checked={archiveRecordIds.length === restorePreview.archiveCandidates.length} onChange={event => setArchiveRecordIds(event.target.checked ? restorePreview.archiveCandidates.map(record => record.id) : [])}>{language === 'zh' ? `确认归档全部 ${restorePreview.archiveCandidates.length} 项及其关联记录` : `Confirm archiving all ${restorePreview.archiveCandidates.length} items and their children`}</Checkbox></div>}{restorePreview.droppedFields.length > 0 && <Alert type="warning" showIcon title={text('restoreDroppedFields')} description={<><ul>{restorePreview.droppedFields.map(item => <li key={item.recordId}>{item.recordId}: {item.fields.join(', ')}</li>)}</ul><Checkbox checked={confirmDroppedFields} onChange={event => setConfirmDroppedFields(event.target.checked)}>{text('restoreDroppedConfirm')}</Checkbox></>} />}</div>}<label>{text('restoreConfirmation')}<Input value={confirmation} onChange={event => setConfirmation(event.target.value)} /></label><label>{text('reason')}<Input.TextArea maxLength={500} rows={2} value={restoreReason} onChange={event => setRestoreReason(event.target.value)} /></label></div></Modal>
  </section>
}
