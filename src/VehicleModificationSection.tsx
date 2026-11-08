import { useEffect, useEffectEvent, useLayoutEffect, useRef, useState } from 'react'
import { Alert, App, Button, Descriptions, Empty, Input, Modal, Radio, Select, Space, Table, Tag, Tooltip } from 'antd'
import { Archive, Copy, Download, Link2, Pencil, Plus, RotateCcw, Unlink } from 'lucide-react'
import { modificationFields } from '../shared/business'
import type { BusinessRecord, Fields } from '../shared/business'
import { hasEnhancedModificationText, MODIFICATION_EXTENSIONS, MODIFICATION_MAX_FILE_BYTES, MODIFICATION_MAX_TARGETS, modificationView } from '../shared/modifications'
import type { ModificationFile, ModificationMutation, ModificationReceipt, ModificationView } from '../shared/modifications'
import AttachmentUpload from './AttachmentUpload'
import { ApiError, createWorkspaceScope } from './api'
import { translateBusiness } from './business-i18n'
import { errorText } from './i18n'
import type { Language } from './i18n'
import { matchesModificationVin, modificationDestinations, selectedModificationTargets } from './modification-population'
import RecordEditor from './RecordEditor'
import './VehicleModificationSection.css'

type Scope = ReturnType<typeof createWorkspaceScope>
type Result = ModificationReceipt & { modification?: ModificationView; fileId?: string; enabled?: boolean }
type Props = {
  vehicle: BusinessRecord; records: BusinessRecord[]; language: Language; enabled: boolean; admin: boolean
  online: boolean; syncPaused: boolean; disabled: boolean; includeArchived: boolean
  onChanged: (scope: Scope, signal: AbortSignal) => Promise<void>
  onBusyChange: (busy: boolean) => void; onCancelReady: (cancel: (() => void) | null) => void; onError: (cause: unknown) => void
}
type Editor = { view: ModificationView | null; requestId: string; submitted?: Record<string, unknown>; unknown?: boolean; stale?: boolean; committed?: boolean; open?: boolean }
type Dialog = { kind: 'enable' | 'populate' | 'unlink' | 'archive'; view?: ModificationView; archived?: boolean; requestId: string; submitted?: { endpoint: string; body: Record<string, unknown> }; open: boolean; stale?: boolean; committed?: boolean }
const endpoint = (id: string) => `/api/business/modifications/${encodeURIComponent(id)}`
const value = (input: unknown) => input === undefined || input === null || input === '' ? '—' : String(input)
const needsRefresh = (cause: unknown) => cause instanceof ApiError && cause.message === 'MODIFICATION_LOCAL_REFRESH_REQUIRED'
const requireRefreshed = (result: Result) => { if (!result.localSynced) throw new ApiError('MODIFICATION_LOCAL_REFRESH_REQUIRED') }
const uncertain = (cause: unknown) => needsRefresh(cause) || !(cause instanceof ApiError) || ['NETWORK_ERROR', 'SERVER_ERROR', 'SHARE_IO_ERROR', 'SHARE_UNAVAILABLE', 'SHARE_LOCK_LOST'].includes(cause.message)
const stale = (cause: unknown) => cause instanceof ApiError && ['VERSION_CONFLICT', 'MODIFICATION_STALE', 'MODIFICATION_CHANGED', 'MODIFICATION_LINK_CHANGED', 'RECORD_ARCHIVED', 'PARENT_ARCHIVED', 'VEHICLE_DELETED'].includes(cause.message)
const fileError = (file: Pick<File, 'name' | 'size'>): 'FILE_TYPE_NOT_ALLOWED' | 'FILE_TOO_LARGE' | undefined => {
  if (!(MODIFICATION_EXTENSIONS as readonly string[]).includes(file.name.slice(file.name.lastIndexOf('.')).toLowerCase())) return 'FILE_TYPE_NOT_ALLOWED'
  if (file.size > MODIFICATION_MAX_FILE_BYTES) return 'FILE_TOO_LARGE'
}

function LinkedScope({ view, language }: { view: ModificationView; language: Language }) {
  const text = translateBusiness(language)
  return view.mode === 'linked' && <Alert type="info" showIcon title={`${text('modificationSharedScope')} (${view.linkedVehicles.length})`} description={<ul className="modification-vins">{view.linkedVehicles.map(vehicle => <li key={vehicle.id}><span className="mono">{vehicle.vin}</span>{vehicle.name ? ` · ${vehicle.name}` : ''}{vehicle.plate ? ` · ${vehicle.plate}` : ''}</li>)}</ul>} />
}

function ModificationFiles({ view, vehicle, language, enabled, admin, online, syncPaused, disabled, includeArchived, onChanged, onBusyChange, onCancelReady, onArchive, onError }: Pick<Props, 'vehicle' | 'language' | 'enabled' | 'admin' | 'online' | 'syncPaused' | 'disabled' | 'includeArchived' | 'onChanged' | 'onBusyChange' | 'onCancelReady' | 'onError'> & { view: ModificationView; onArchive: (view: ModificationView, file: ModificationFile) => void }) {
  const text = translateBusiness(language), latest = useRef(view), active = useRef(true), downloadController = useRef<AbortController | null>(null)
  const pendingUpload = useRef<{ body: FormData; requestId: string; recordId: string } | null>(null)
  const [uploadRefreshRequired, setUploadRefreshRequired] = useState(false)
  const [reason, setReason] = useState(() => text('modificationUploadReason'))
  const acceptView = useEffectEvent(() => { latest.current = view })
  useEffect(() => { acceptView() }, [view.record.version, view.groupVersion, view.groupId])
  useEffect(() => { active.current = true; return () => { active.current = false; downloadController.current?.abort() } }, [])
  const mutationBlocked = disabled || vehicle.archived || view.record.archived || !enabled || view.mode === 'linked' && (!online || syncPaused)
  const readonly = mutationBlocked || uploadRefreshRequired
  async function refreshFiles(scope: Scope, signal: AbortSignal) {
    const pending = pendingUpload.current
    if (pending) {
      const result = await scope.request<Result>(`${endpoint(pending.recordId)}/files`, { method: 'POST', body: pending.body, signal })
      scope.assertCurrent(signal)
      if (result.requestId !== pending.requestId) throw new ApiError('SERVER_ERROR')
      requireRefreshed(result)
      if (result.modification) latest.current = result.modification
      pendingUpload.current = null
      setUploadRefreshRequired(false)
    }
    await onChanged(scope, signal)
  }
  async function saveFile(scope: Scope, file: File, signal: AbortSignal): Promise<{ id: string; pauseForRefresh?: boolean }> {
    if (pendingUpload.current) await refreshFiles(scope, signal)
    const current = latest.current, body = new FormData(), requestId = crypto.randomUUID()
    body.append('file', file, file.name); body.append('version', String(current.record.version)); if (current.groupVersion !== null) body.append('groupVersion', String(current.groupVersion))
    body.append('reason', reason.trim()); body.append('requestId', requestId)
    const result = await scope.request<Result>(`${endpoint(current.record.id)}/files`, { method: 'POST', body, signal })
    scope.assertCurrent(signal)
    if (result.requestId !== requestId || typeof result.fileId !== 'string' || !result.fileId || result.modification && (result.modification.record.id !== current.record.id || result.modification.record.vehicleId !== vehicle.id)) throw new ApiError('SERVER_ERROR')
    if (result.modification) latest.current = result.modification
    if (!result.localSynced) { pendingUpload.current = { body, requestId, recordId: current.record.id }; setUploadRefreshRequired(true) }
    return { id: result.fileId, pauseForRefresh: !result.localSynced }
  }
  async function downloadFile(file: ModificationFile) {
    downloadController.current?.abort()
    const controller = new AbortController(), scope = createWorkspaceScope(); downloadController.current = controller
    try {
      const bytes = await scope.blob(`${endpoint(view.record.id)}/files/${encodeURIComponent(file.id)}`, { signal: controller.signal })
      scope.assertCurrent(controller.signal); if (!active.current) return
      const url = URL.createObjectURL(bytes), anchor = document.createElement('a')
      anchor.href = url; anchor.download = file.name; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000)
    } catch (cause) { if (active.current && !controller.signal.aborted) onError(cause) }
  }
  return <>
    <LinkedScope view={view} language={language} />
    {view.mode === 'linked' && (!online || syncPaused) && <Alert type="warning" showIcon title={text('modificationOnlineNotice')} />}
    {!vehicle.archived && !view.record.archived && enabled && <>
      <label className="modification-file-reason">{text('reason')}<Input value={reason} maxLength={500} disabled={readonly} onChange={event => setReason(event.target.value)} /></label>
      <AttachmentUpload vehicle={vehicle} queueId={view.record.id} language={language} disabled={mutationBlocked || !reason.trim()} uploadBlocked={uploadRefreshRequired} extensions={MODIFICATION_EXTENSIONS} limitsText={text('modificationFileLimits')} validateFile={fileError} uploadFile={saveFile} onRefresh={refreshFiles} onBusyChange={onBusyChange} onCancelReady={onCancelReady} onError={onError} />
    </>}
    <Table<ModificationFile> rowKey="id" size="small" dataSource={view.files.filter(file => includeArchived || !file.archived)} pagination={{ pageSize: 8, hideOnSinglePage: true }} scroll={{ x: 600 }} locale={{ emptyText: text('modificationNoFiles') }} columns={[
      { title: text('file'), render: (_, file) => <span className="preserve-text">{file.name}{file.archived && <Tag>{text('archived')}</Tag>}</span> },
      { title: text('size'), width: 100, render: (_, file) => `${(file.size / 1024).toFixed(1)} KB` },
      { title: text('actions'), width: 180, render: (_, file) => <Space><Button icon={<Download size={14} />} onClick={() => void downloadFile(file)}>{text('download')}</Button>{admin && <Button icon={file.archived ? <RotateCcw size={14} /> : <Archive size={14} />} disabled={readonly || !online} aria-label={`${text(file.archived ? 'restore' : 'archive')} ${file.name}`} onClick={() => onArchive(latest.current, file)} />}</Space> },
    ]} />
  </>
}

export default function VehicleModificationSection(props: Props) {
  const { vehicle, records, language, enabled, admin, online, syncPaused, disabled, includeArchived, onChanged, onBusyChange, onCancelReady, onError } = props
  const text = translateBusiness(language), { message } = App.useApp(), [scope] = useState(createWorkspaceScope)
  const [working, setWorking] = useState(false), [editor, setEditor] = useState<Editor | null>(null), [dialog, setDialog] = useState<Dialog | null>(null)
  const [fileAction, setFileAction] = useState<{ view: ModificationView; file: ModificationFile; requestId: string; submitted?: Record<string, unknown>; committed?: boolean; open?: boolean } | null>(null)
  const [reason, setReason] = useState(''), [targetIds, setTargetIds] = useState<string[]>([]), [mode, setMode] = useState<'oneTime' | 'linked'>('oneTime'), [error, setError] = useState<string | null>(null), [expanded, setExpanded] = useState<readonly string[]>([])
  const active = useRef(true), admitted = useRef(false), controller = useRef<AbortController | null>(null), uploadCancel = useRef<(() => void) | null>(null)
  const callbacks = useRef({ onChanged, onError, onBusyChange, onCancelReady })
  useLayoutEffect(() => { callbacks.current = { onChanged, onError, onBusyChange, onCancelReady } }, [onChanged, onError, onBusyChange, onCancelReady])
  useEffect(() => {
    active.current = true
    callbacks.current.onCancelReady(() => { controller.current?.abort(); uploadCancel.current?.() })
    return () => { active.current = false; controller.current?.abort(); uploadCancel.current?.(); callbacks.current.onCancelReady(null); if (admitted.current) callbacks.current.onBusyChange(false) }
  }, [vehicle.id])
  const items = records.filter(record => record.kind === 'modification' && record.vehicleId === vehicle.id && (includeArchived || !record.archived)).map(record => modificationView(records, record.id))
  const locked = disabled || working, onlineAllowed = online && !syncPaused
  const options = dialog?.view ? modificationDestinations(records, dialog.view) : []
  const selectedTargets = selectedModificationTargets(options, targetIds)
  const refresh = async (signal: AbortSignal) => { try { await callbacks.current.onChanged(scope, signal) } catch (cause) { if (active.current && !signal.aborted) callbacks.current.onError(cause) } }
  async function task(work: (signal: AbortSignal) => Promise<void>) {
    if (admitted.current) return
    admitted.current = true; const next = new AbortController(); controller.current = next; setWorking(true); callbacks.current.onBusyChange(true)
    try { scope.assertCurrent(next.signal); await work(next.signal) }
    catch (cause) { if (active.current && !next.signal.aborted) { setError(cause instanceof ApiError ? cause.message : 'SERVER_ERROR'); callbacks.current.onError(cause) } }
    finally { admitted.current = false; if (active.current) { setWorking(false); callbacks.current.onBusyChange(false) } }
  }
  async function openEditor(id?: string) {
    if (editor?.unknown) { setEditor({ ...editor, open: true }); return }
    if (!id) { setEditor({ view: null, requestId: crypto.randomUUID() }); return }
    await task(async signal => { const view = await scope.request<ModificationView>(endpoint(id), { signal }); if (active.current) setEditor({ view, requestId: crypto.randomUUID() }) })
  }
  async function saveEditor(data?: Fields, explanation?: string) {
    if (!editor) return
    const snapshot = editor, body = snapshot.submitted || { data: data && Object.fromEntries(modificationFields.map(field => [field, data[field] ?? ''])), reason: explanation, requestId: snapshot.requestId, version: snapshot.view?.record.version, groupVersion: snapshot.view?.groupVersion }
    if (snapshot.unknown && !snapshot.view) return
    setEditor({ ...snapshot, submitted: body, unknown: false }); setError(null)
    await task(async signal => {
      try {
        const result = snapshot.view
          ? await scope.request<Result>(endpoint(snapshot.view.record.id), { method: 'PUT', body, signal })
          : await scope.request<BusinessRecord>('/api/business/records', { method: 'POST', body: { kind: 'modification', vehicleId: vehicle.id, data: body.data, reason: body.reason }, signal })
        if (!active.current) return
        if ('localSynced' in result) requireRefreshed(result)
        if (!snapshot.view && 'id' in result) setExpanded([result.id])
        setEditor(null); await refresh(signal); if (active.current) void message.success(text('saved'))
      } catch (cause) {
        if (active.current && !signal.aborted) setEditor({ ...snapshot, ...(uncertain(cause) ? { submitted: body, unknown: true, committed: needsRefresh(cause) } : { stale: stale(cause) }) })
        throw cause
      }
    })
  }
  async function reviewEditor() {
    if (!editor) return
    const current = editor
    await task(async signal => {
      await refresh(signal)
      if (!active.current) return
      if (!current.view) setEditor(null)
      else setEditor({ view: await scope.request<ModificationView>(endpoint(current.view.record.id), { signal }), requestId: crypto.randomUUID() })
      setError(null)
    })
  }
  async function openDialog(kind: Dialog['kind'], id?: string, archived?: boolean) {
    if (dialog?.submitted) { setDialog({ ...dialog, open: true }); return }
    setError(null); setReason(''); setTargetIds([]); setMode('oneTime')
    if (!id) { setDialog({ kind, requestId: crypto.randomUUID(), open: true }); return }
    await task(async signal => { const view = await scope.request<ModificationView>(endpoint(id), { signal }); if (active.current) setDialog({ kind, view, archived, requestId: crypto.randomUUID(), open: true }) })
  }
  async function submitDialog() {
    if (!dialog || !reason.trim() && !dialog.submitted) return
    const current = dialog, view = current.view
    const mutation: ModificationMutation | undefined = view ? { version: view.record.version, groupVersion: view.groupVersion, reason: reason.trim(), requestId: current.requestId } : undefined
    const request = current.submitted || {
      endpoint: current.kind === 'enable' ? '/api/business/modifications/enable' : `${endpoint(view!.record.id)}/${current.kind}`,
      body: current.kind === 'enable' ? { reason: reason.trim(), requestId: current.requestId } : { ...mutation, ...(current.kind === 'populate' ? { mode, targets: selectedTargets } : current.kind === 'archive' ? { archived: current.archived } : {}) },
    }
    setDialog({ ...current, submitted: request }); setError(null)
    await task(async signal => {
      try { const result = await scope.request<Result>(request.endpoint, { method: 'POST', body: request.body, signal }); if (!active.current) return; requireRefreshed(result); setDialog(null); await refresh(signal); if (active.current) void message.success(text('saved')) }
      catch (cause) { if (active.current && !signal.aborted) setDialog({ ...current, submitted: uncertain(cause) ? request : undefined, committed: needsRefresh(cause), stale: stale(cause), open: true }); throw cause }
    })
  }
  async function refreshDialog() {
    if (!dialog?.view || dialog.submitted) return
    const current = dialog
    await task(async signal => { const view = await scope.request<ModificationView>(endpoint(current.view!.record.id), { signal }); await refresh(signal); if (active.current) { setDialog({ ...current, view, stale: false, requestId: crypto.randomUUID() }); setTargetIds([]); setError(null) } })
  }
  async function archiveFile() {
    if (!fileAction || !reason.trim() && !fileAction.submitted) return
    const current = fileAction, body = current.submitted || { version: current.view.record.version, groupVersion: current.view.groupVersion, archived: !current.file.archived, reason: reason.trim(), requestId: current.requestId }
    setFileAction({ ...current, submitted: body }); setError(null)
    await task(async signal => {
      try { const result = await scope.request<Result>(`${endpoint(current.view.record.id)}/files/${encodeURIComponent(current.file.id)}/archive`, { method: 'POST', body, signal }); if (!active.current) return; requireRefreshed(result); setFileAction(null); await refresh(signal) }
      catch (cause) { if (active.current && !signal.aborted) setFileAction({ ...current, submitted: uncertain(cause) ? body : undefined, committed: needsRefresh(cause) }); throw cause }
    })
  }
  const dialogLinked = dialog?.kind === 'populate' ? mode === 'linked' : dialog?.kind === 'enable' || dialog?.kind === 'unlink' || dialog?.view?.mode === 'linked'
  const protectedDialog = !enabled && Boolean(dialog?.view && hasEnhancedModificationText(dialog.view.record.data))
  const protectedEditor = !enabled && Boolean(editor?.view && hasEnhancedModificationText(editor.view.record.data))
  const dialogReady = Boolean(dialog && !locked && !protectedDialog && (dialog.submitted || !dialog.stale && reason.trim() && (dialog.kind !== 'populate' || selectedTargets)) && (!dialogLinked || onlineAllowed))
  return <section className="vehicle-modification-section">
    <div className="section-toolbar"><h3>{text('modifications')}</h3><Space wrap>{!enabled && admin && <Button disabled={locked || !onlineAllowed} onClick={() => void openDialog('enable')}>{text('modificationEnable')}</Button>}<Button icon={<Plus size={15} />} disabled={locked || vehicle.archived} onClick={() => void openEditor()}>{text('addEntry')}</Button></Space></div>
    {!enabled && <Alert type="info" showIcon title={text('modificationActivationNotice')} />}
    {dialog?.submitted && !dialog.open && <Alert type="warning" showIcon title={text(dialog.committed ? 'modificationSavedRefresh' : 'modificationUnknown')} action={<Button disabled={locked} onClick={() => setDialog({ ...dialog, open: true })}>{text(dialog.committed ? 'modificationRefreshSaved' : 'modificationRetry')}</Button>} />}
    {editor?.unknown && editor.open === false && <Alert type="warning" showIcon title={text(editor.committed ? 'modificationSavedRefresh' : 'modificationUnknown')} action={<Button disabled={locked} onClick={() => setEditor({ ...editor, open: true })}>{text('refresh')}</Button>} />}
    {fileAction?.submitted && fileAction.open === false && <Alert type="warning" showIcon title={text(fileAction.committed ? 'modificationSavedRefresh' : 'modificationUnknown')} action={<Button disabled={locked} onClick={() => setFileAction({ ...fileAction, open: true })}>{text(fileAction.committed ? 'modificationRefreshSaved' : 'modificationRetry')}</Button>} />}
    <Table<ModificationView> rowKey={view => view.record.id} size="small" scroll={{ x: 1120 }} dataSource={items} pagination={{ pageSize: 8, hideOnSinglePage: true }} locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={text('modificationNone')} /> }} columns={[
      { title: text('name'), width: 170, render: (_, view) => <div className="record-title">{value(view.record.data.name)}<br />{view.mode === 'linked' ? <Tooltip title={view.linkedVehicles.map(car => car.vin).join(' / ')}><Tag icon={<Link2 size={12} />}>{text('modificationLinked')} · {view.linkedVehicles.length}</Tag></Tooltip> : <Tag>{text('modificationIndependent')}</Tag>}</div> },
      { title: text('description'), width: 260, render: (_, view) => <span className="preserve-text">{value(view.record.data.description)}</span> },
      { title: text('requestor'), width: 150, render: (_, view) => <span className="preserve-text">{value(view.record.data.requestor)}</span> },
      { title: text('lead'), width: 150, render: (_, view) => <span className="preserve-text">{value(view.record.data.lead)}</span> },
      { title: text('status'), width: 130, render: (_, view) => view.record.archived ? text('archived') : view.record.data.removedAt ? `${text('removed')} · ${view.record.data.removedAt}` : text('installed') },
      { title: text('actions'), width: 260, render: (_, view) => <Space wrap size={3}>
        {!view.record.archived && <Tooltip title={text('edit')}><Button type="text" icon={<Pencil size={15} />} aria-label={`${text('edit')} ${value(view.record.data.name)}`} disabled={locked || vehicle.archived || view.mode === 'linked' && !onlineAllowed} onClick={() => void openEditor(view.record.id)} /></Tooltip>}
        {!view.record.archived && <Button size="small" icon={<Copy size={14} />} disabled={locked || vehicle.archived} onClick={() => void openDialog('populate', view.record.id)}>{text('modificationPopulate')}</Button>}
        {view.mode === 'linked' && <Tooltip title={text('modificationUnlink')}><Button type="text" icon={<Unlink size={15} />} aria-label={text('modificationUnlink')} disabled={locked || vehicle.archived || !onlineAllowed} onClick={() => void openDialog('unlink', view.record.id)} /></Tooltip>}
        {admin && <Tooltip title={text(view.record.archived ? 'restore' : 'archive')}><Button type="text" icon={view.record.archived ? <RotateCcw size={15} /> : <Archive size={15} />} disabled={locked || vehicle.archived || !online || !enabled && hasEnhancedModificationText(view.record.data) || view.mode === 'linked' && syncPaused} aria-label={`${text(view.record.archived ? 'restore' : 'archive')} ${value(view.record.data.name)}`} onClick={() => void openDialog('archive', view.record.id, !view.record.archived)} /></Tooltip>}
      </Space> },
    ]} expandable={{ expandedRowKeys: expanded, onExpand: (open, view) => { if (!locked) { uploadCancel.current?.(); setExpanded(open ? [view.record.id] : []) } }, expandedRowRender: view => <div className="modification-details"><Descriptions size="small" column={{ xs: 1, sm: 2 }} items={modificationFields.map(field => ({ key: field, label: text(field), children: <span className="preserve-text">{value(view.record.data[field])}</span> }))} /><ModificationFiles {...props} view={view} onCancelReady={cancel => { uploadCancel.current = cancel }} onArchive={(current, file) => { if (fileAction?.submitted) { setFileAction({ ...fileAction, open: true }); return }; setReason(''); setError(null); setFileAction({ view: current, file, requestId: crypto.randomUUID() }) }} /></div> }} />
    {editor && editor.open !== false && <RecordEditor kind="modification" record={editor.view?.record || null} language={language} busy={working} modificationEnabled={enabled} saveBlocked={Boolean(editor.unknown || editor.stale || protectedEditor || editor.view?.mode === 'linked' && !onlineAllowed)} onCancel={() => { if (!working) { setEditor(editor.unknown ? { ...editor, open: false } : null); setError(null) } }} onSave={(data, explanation) => void saveEditor(data, explanation)} notice={<>
      {!enabled && <Alert type={protectedEditor ? 'warning' : 'info'} showIcon title={text(protectedEditor ? 'modificationExistingTextActivation' : 'modificationTextActivation')} />}
      {editor.view && <LinkedScope view={editor.view} language={language} />}
      {editor.unknown && <Alert type="warning" showIcon title={text(editor.committed ? 'modificationSavedRefresh' : 'modificationUnknown')} action={editor.view ? <Button onClick={() => void saveEditor()}>{text(editor.committed ? 'modificationRefreshSaved' : 'modificationRetry')}</Button> : <Button onClick={() => void reviewEditor()}>{text('refresh')}</Button>} />}
      {editor.stale && <Alert type="warning" showIcon title={text('modificationRefreshRequired')} action={<Button onClick={() => void reviewEditor()}>{text('refresh')}</Button>} />}
      {error && <Alert type="warning" showIcon title={errorText(error, language)} />}
    </>} />}
    <Modal open={Boolean(dialog?.open)} title={text(dialog?.kind === 'enable' ? 'modificationEnable' : dialog?.kind === 'populate' ? 'modificationPopulate' : dialog?.kind === 'unlink' ? 'modificationUnlink' : dialog?.archived ? 'archive' : 'restore')} onCancel={() => { if (!working) { setDialog(dialog?.submitted ? { ...dialog, open: false } : null); setError(null) } }} onOk={() => void submitDialog()} okText={text(dialog?.submitted ? dialog.committed ? 'modificationRefreshSaved' : 'modificationRetry' : dialog?.kind === 'populate' ? 'modificationPopulateConfirm' : 'save')} cancelText={text('cancel')} confirmLoading={working} okButtonProps={{ disabled: !dialogReady }} width={720} destroyOnHidden>
      <div className="modification-dialog">
        {dialog?.view && <><p className="operation-name"><span className="mono">{value(vehicle.data.vin)}</span> · {value(dialog.view.record.data.name)}</p><LinkedScope view={dialog.view} language={language} /></>}
        {dialog?.kind === 'enable' && <Alert type="warning" showIcon title={text('modificationEnableWarning')} />}
        {protectedDialog && <Alert type="warning" showIcon title={text('modificationExistingTextActivation')} />}
        {dialog?.kind === 'populate' && <>
          <Radio.Group value={mode} disabled={working || Boolean(dialog.submitted)} onChange={event => setMode(event.target.value)} options={[{ value: 'oneTime', label: text('modificationOneTime') }, { value: 'linked', label: text('modificationLinked'), disabled: !enabled }]} />
          <Alert type={mode === 'linked' ? 'warning' : 'info'} showIcon title={text(mode === 'linked' ? 'modificationLinkedNotice' : 'modificationCopyNotice')} />
          <label className="modification-dialog-label">{text('modificationTargetVehicles')}<Select mode="multiple" showSearch value={targetIds} disabled={working || Boolean(dialog.submitted) || Boolean(dialog.stale)} placeholder={text('modificationVinSearch')} maxCount={MODIFICATION_MAX_TARGETS} filterOption={(input, option) => matchesModificationVin(String(option?.vin || ''), input)} options={options.map(car => ({ value: car.id, vin: String(car.data.vin), label: `${car.data.vin} · ${value(car.data.name)} · ${value(car.data.plate)}` }))} onChange={setTargetIds} notFoundContent={text('modificationNoDestinations')} /></label>
          <p>{text('modificationSelectedVehicles')}: {targetIds.length} / {MODIFICATION_MAX_TARGETS} · {text('modificationCopiedFiles')}: {dialog.view?.files.filter(file => !file.archived).length || 0}</p>
          {mode === 'linked' && <p>{text('modificationLinkedVehiclesTotal')}: {new Set([vehicle.id, ...(dialog.view?.linkedVehicles.map(car => car.id) || []), ...targetIds]).size}</p>}
        </>}
        {dialog?.kind === 'unlink' && <Alert type="info" showIcon title={text('modificationUnlinkNotice')} />}
        {dialog?.kind === 'archive' && dialog.archived && dialog.view?.mode === 'linked' && <Alert type="info" showIcon title={text('modificationArchiveNotice')} />}
        {dialogLinked && !onlineAllowed && <Alert type="warning" showIcon title={text('modificationOnlineNotice')} />}
        {dialog?.submitted && !working && <Alert type="warning" showIcon title={text(dialog.committed ? 'modificationSavedRefresh' : 'modificationUnknown')} />}
        {dialog?.stale && <Alert type="warning" showIcon title={text('modificationRefreshRequired')} action={<Button onClick={() => void refreshDialog()}>{text('refresh')}</Button>} />}
        {error && <Alert type="warning" showIcon title={errorText(error, language)} />}
        <label className="modification-dialog-label">{text('reason')}<Input.TextArea value={reason} rows={3} maxLength={500} disabled={working || Boolean(dialog?.submitted)} onChange={event => setReason(event.target.value)} /></label>
      </div>
    </Modal>
    <Modal open={Boolean(fileAction && fileAction.open !== false)} title={text(fileAction?.file.archived ? 'restore' : 'archive')} onCancel={() => { if (!working) { setFileAction(fileAction?.submitted ? { ...fileAction, open: false } : null); setError(null) } }} onOk={() => void archiveFile()} okText={text(fileAction?.submitted ? fileAction.committed ? 'modificationRefreshSaved' : 'modificationRetry' : 'save')} cancelText={text('cancel')} confirmLoading={working} okButtonProps={{ disabled: locked || !reason.trim() || fileAction?.view.mode === 'linked' && !onlineAllowed }} destroyOnHidden>
      {fileAction && <><p className="operation-name">{fileAction.file.name}</p><LinkedScope view={fileAction.view} language={language} />{fileAction.submitted && !working && <Alert type="warning" showIcon title={text(fileAction.committed ? 'modificationSavedRefresh' : 'modificationUnknown')} />}{error && <Alert type="warning" showIcon title={errorText(error, language)} />}<label className="modification-dialog-label">{text('reason')}<Input.TextArea value={reason} rows={3} maxLength={500} disabled={working || Boolean(fileAction.submitted)} onChange={event => setReason(event.target.value)} /></label></>}
    </Modal>
  </section>
}
