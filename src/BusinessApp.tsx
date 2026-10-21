import { lazy, Suspense, useEffect, useEffectEvent, useState } from 'react'
import { App, Alert, Button, Checkbox, Descriptions, Drawer, Empty, Input, Modal, Pagination, Select, Space, Spin, Table, Tabs, Tag, Timeline, Tooltip, Upload } from 'antd'
import { Archive, ArrowUpRight, CarFront, Check, ClipboardCheck, CloudOff, Download, FileSpreadsheet, FolderSync, GitCompare, Pencil, Plus, RefreshCw, RotateCcw, Search, Upload as UploadIcon, Wrench } from 'lucide-react'
import { api, ApiError, download } from './api'
import { errorText } from './i18n'
import type { Language } from './i18n'
import { translateBusiness } from './business-i18n'
import { vehicleFields } from '../shared/business'
import type { BusinessRecord, Change, Fields, RecordKind, ReportData, SyncConflict, SyncStatus } from '../shared/business'
import RecordEditor from './RecordEditor'
import DoveImport from './DoveImport'
import './BusinessApp.css'

const ReportViewer = lazy(() => import('./ReportViewer'))
export type BusinessView = 'vehicles' | 'dove' | 'reports' | 'history' | 'sync' | 'audit'
type AuditEntry = { id: string; actor: string; created: string; action: string; detail: Fields }
type Editor = { kind: RecordKind; record: BusinessRecord | null; vehicleId: string | null }
type Action = { record: BusinessRecord; type: 'archive' | 'remove'; archived?: boolean }
type Difference = { key: string; status: string; before: unknown; after: unknown; fields: string[] }
type Comparison = { left: BusinessRecord; right: BusinessRecord; controllers: Difference[]; faults: Difference[] }
type Configuration = { report: BusinessRecord; controllerIndex: number | null; part: BusinessRecord | null; fields: string[]; reason: string }
const statuses = ['available', 'testing', 'maintenance', 'inactive']
const emptySync: SyncStatus = { phase: 'idle', error: null, pending: 0, conflicts: [], lastSync: null, revision: null }
const display = (value: unknown): string => value === null || value === undefined || value === '' ? '—' : typeof value === 'object' ? JSON.stringify(value, null, 2) : String(value)
const reportTime = (record: BusinessRecord) => { const date = Date.parse(String(record.data.recordedAt)); return Number.isFinite(date) ? date : Date.parse(String(record.data.savedAt || record.updated)) }
async function fetchWorkspace(includeAudit = false) {
  const records = await api<BusinessRecord[]>('/api/business/records')
  const [sync, changes] = await Promise.all([api<SyncStatus>('/api/business/sync'), api<Change[]>('/api/business/history')])
  const audit = includeAudit ? await api<AuditEntry[]>('/api/business/audit') : []
  return { records, sync, changes, audit }
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

export default function BusinessApp({ view, language, admin, online, onError }: { view: BusinessView; language: Language; admin: boolean; online: boolean; onError: (error: unknown) => void }) {
  const text = translateBusiness(language), { message } = App.useApp()
  const [records, setRecords] = useState<BusinessRecord[]>([]), [changes, setChanges] = useState<Change[]>([]), [sync, setSync] = useState<SyncStatus>(emptySync)
  const [loading, setLoading] = useState(true), [busy, setBusy] = useState(false), [query, setQuery] = useState(''), [filter, setFilter] = useState<string | undefined>(), [archived, setArchived] = useState(false)
  const [selectedId, setSelectedId] = useState<string | null>(null), [editor, setEditor] = useState<Editor | null>(null), [action, setAction] = useState<Action | null>(null), [actionReason, setActionReason] = useState('')
  const [reportId, setReportId] = useState<string | null>(null)
  const [reportSelection, setReportSelection] = useState<string[]>([]), [comparison, setComparison] = useState<Comparison | null>(null), [configuration, setConfiguration] = useState<Configuration | null>(null)
  const [restoreOpen, setRestoreOpen] = useState(false), [restoreFile, setRestoreFile] = useState<File | null>(null), [confirmation, setConfirmation] = useState(''), [restoreReason, setRestoreReason] = useState(''), [historyPage, setHistoryPage] = useState(1)
  const [attachmentFile, setAttachmentFile] = useState<File | null>(null)
  const [audit, setAudit] = useState<AuditEntry[]>([])
  const [today, setToday] = useState(() => new Date().toISOString().slice(0, 10))
  useEffect(() => { const timer = setInterval(() => setToday(new Date().toISOString().slice(0, 10)), 60000); return () => clearInterval(timer) }, [])
  async function load() {
    try {
      const result = await fetchWorkspace(view === 'audit')
      setRecords(result.records); setSync(result.sync); setChanges(result.changes); setAudit(result.audit)
    } catch (error) { onError(error) } finally { setLoading(false) }
  }
  const reportInitialError = useEffectEvent(onError)
  useEffect(() => {
    let active = true
    void fetchWorkspace(view === 'audit').then(result => { if (active) { setRecords(result.records); setSync(result.sync); setChanges(result.changes); setAudit(result.audit); setLoading(false) } }).catch(error => { if (active) { reportInitialError(error); setLoading(false) } })
    return () => { active = false }
  }, [view])
  const periodicLoad = useEffectEvent(async () => {
    if (!editor && !action && !selectedId && !reportId && !configuration && !comparison && !restoreOpen && !busy && document.visibilityState === 'visible' && !document.activeElement?.matches('input,textarea,select')) await load()
  })
  useEffect(() => { const timer = setInterval(() => { void periodicLoad() }, 30000); return () => clearInterval(timer) }, [])
  const selected = records.find(record => record.id === selectedId) || null
  const activeReport = records.find(record => record.id === reportId) || null
  const cars = records.filter(record => record.kind === 'vehicle')
  const reports = records.filter(record => record.kind === 'report').sort((left, right) => reportTime(right) - reportTime(left) || right.updated.localeCompare(left.updated))
  const vehicleName = (id: string | null) => cars.find(car => car.id === id)?.data.name || id || '—'
  const date = (value: string) => value ? new Date(value).toLocaleString(language === 'zh' ? 'zh-CN' : 'en-GB') : '—'
  const statusTag = (value: string) => <Tag color={{ available: 'success', testing: 'processing', maintenance: 'warning', inactive: 'default' }[value]}>{text(value)}</Tag>
  const openAction = (record: BusinessRecord, type: Action['type']) => { setAction({ record, type, archived: !record.archived }); setActionReason('') }
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
    if (!configuration?.part || configuration.controllerIndex === null) return
    setBusy(true)
    try {
      await api(`/api/business/reports/${configuration.report.id}/configuration`, { method: 'POST', body: { reportVersion: configuration.report.version, reason: configuration.reason, selections: [{ controllerIndex: configuration.controllerIndex, partId: configuration.part.id, version: configuration.part.version, fields: configuration.fields }] } })
      setConfiguration(null); await load(); void message.success(text('saved'))
    } catch (error) { onError(error) } finally { setBusy(false) }
  }
  async function synchronize() {
    setBusy(true)
    try { const state = await api<SyncStatus>('/api/business/sync', { method: 'POST' }); setSync(state); await load(); if (state.error) onError(new ApiError(state.error)); else void message.success(text(state.conflicts.length ? 'conflict' : 'synced')) }
    catch (error) { onError(error) } finally { setBusy(false) }
  }
  async function restore() {
    if (!restoreFile) return
    const form = new FormData(); form.append('file', restoreFile); form.append('confirmation', confirmation); form.append('reason', restoreReason)
    setBusy(true)
    try { await api('/api/business/restore', { method: 'POST', body: form }); setRestoreOpen(false); setRestoreFile(null); setConfirmation(''); setRestoreReason(''); await load(); void message.success(text('restoredBackup')) }
    catch (error) { onError(error) } finally { setBusy(false) }
  }
  const downloadFile = (record: BusinessRecord) => { void download(`/api/business/files/${record.id}`, String(record.data.name)).catch(onError) }
  const recordActions = (record: BusinessRecord) => <Space size={3}>
    {!record.archived && !['report', 'attachment'].includes(record.kind) && <Tooltip title={text('edit')}><Button type="text" icon={<Pencil size={15} />} aria-label={`${text('edit')} ${record.data.name}`} onClick={() => setEditor({ kind: record.kind, record, vehicleId: record.vehicleId })} /></Tooltip>}
    {!record.archived && ['part', 'equipment'].includes(record.kind) && !record.data.removedAt && <Tooltip title={text('recordRemoval')}><Button type="text" icon={<Wrench size={15} />} aria-label={text('recordRemoval')} onClick={() => openAction(record, 'remove')} /></Tooltip>}
    {admin && <Tooltip title={text(record.archived ? 'restore' : 'archive')}><Button type="text" disabled={!online} icon={record.archived ? <RotateCcw size={15} /> : <Archive size={15} />} aria-label={`${text(record.archived ? 'restore' : 'archive')} ${record.data.name}`} onClick={() => openAction(record, 'archive')} /></Tooltip>}
  </Space>
  const reportTable = (items: BusinessRecord[], selectable = false) => <Table<BusinessRecord> rowKey="id" dataSource={items} size="small" loading={loading} scroll={{ x: 800 }} pagination={{ pageSize: 10, hideOnSinglePage: true }} rowSelection={selectable ? { selectedRowKeys: reportSelection, onChange: keys => setReportSelection(keys.map(String).slice(-2)) } : undefined} columns={[
    { title: text('file'), width: 280, render: (_, record) => <button className="record-link" onClick={() => setReportId(record.id)}><FileSpreadsheet size={17} /><span>{display(record.data.name)}{record.archived && <small>{text('archived')}</small>}</span></button> },
    { title: text('vehicle'), width: 150, render: (_, record) => display(vehicleName(record.vehicleId)) }, { title: text('recordedAt'), width: 160, render: (_, record) => display(record.data.recordedAt) },
    { title: text('savedAt'), width: 170, render: (_, record) => date(String(record.data.savedAt || record.updated)) }, { title: text('actions'), width: 110, render: (_, record) => <Space><Tooltip title={text('download')}><Button type="text" icon={<Download size={16} />} aria-label={text('download')} onClick={() => downloadFile(record)} /></Tooltip>{recordActions(record)}</Space> },
  ]} />
  const entryTable = (kind: RecordKind, vehicle: BusinessRecord) => {
    const items = records.filter(record => record.kind === kind && record.vehicleId === vehicle.id && (!record.archived || archived))
    return <><div className="section-toolbar"><h3>{text(kind === 'part' ? 'parts' : kind === 'modification' ? 'modifications' : kind)}</h3><Button icon={<Plus size={15} />} disabled={vehicle.archived} onClick={() => setEditor({ kind, vehicleId: vehicle.id, record: null })}>{text(kind === 'part' ? 'addPart' : 'addEntry')}</Button></div><Table<BusinessRecord> rowKey="id" dataSource={items} size="small" scroll={{ x: 760 }} pagination={{ pageSize: 8, hideOnSinglePage: true }} columns={[
      { title: text('name'), width: 160, render: (_, record) => <div className="record-title">{display(record.data.name)}<small>{record.archived ? text('archived') : record.data.category ? text(String(record.data.category)) : ''}</small></div> },
      ...(kind === 'part' ? [{ title: text('position'), width: 100, render: (_: unknown, record: BusinessRecord) => display(record.data.position) }, { title: text('serial'), width: 140, render: (_: unknown, record: BusinessRecord) => <span className="mono">{display(record.data.serial)}</span> }, { title: text('software'), width: 150, render: (_: unknown, record: BusinessRecord) => display(record.data.software) }] : [{ title: text('description'), width: 300, render: (_: unknown, record: BusinessRecord) => <span className="preserve-text">{display(record.data.description)}</span> }]),
      { title: text('status'), width: 120, render: (_, record) => record.data.removedAt ? `${text('removed')} · ${record.data.removedAt}` : text('installed') }, { title: text('actions'), width: 130, render: (_, record) => recordActions(record) },
    ]} expandable={{ expandedRowRender: record => <Descriptions column={{ xs: 1, sm: 2 }} size="small" items={Object.entries(record.data).filter(([, value]) => value !== '').map(([key, value]) => ({ key, label: text(key), children: <span className="preserve-text">{display(key === 'category' ? text(String(value)) : value)}</span> }))} /> }} /></>
  }
  const history = (items: Change[]) => <>{!items.length ? <Empty description={text('noRecords')} /> : <><Timeline items={items.slice((historyPage - 1) * 20, historyPage * 20).map(change => ({ color: 'gray', content: <div className="change-entry"><div><strong>{change.actor.name}</strong><span>{text(change.action === 'updated' ? 'updatedAction' : change.action)} · {text(change.kind)}</span><time>{date(change.created)}</time></div><p>{change.reason}</p><small className="mono">{text('device')}: {change.actor.deviceId.slice(0, 12)}{change.sourceId && <> · <button className="inline-link" onClick={() => setReportId(change.sourceId)}>{text('source')}</button></>}</small><details><summary>{text('details')}</summary><div className="change-diff">{Object.keys(change.after).filter(key => JSON.stringify(change.before?.[key]) !== JSON.stringify(change.after[key])).map(key => <div key={key}><strong>{text(key)}</strong><del>{display(change.before?.[key])}</del><span>→</span><ins>{display(change.after[key])}</ins></div>)}{change.archivedBefore !== change.archivedAfter && <div><strong>{text('status')}</strong><del>{change.archivedBefore ? text('archived') : '—'}</del><span>→</span><ins>{change.archivedAfter ? text('archived') : text('restored')}</ins></div>}</div></details></div> }))} /><Pagination current={historyPage} onChange={setHistoryPage} total={items.length} pageSize={20} showSizeChanger={false} hideOnSinglePage /></>}</>

  const filters = <div className="business-filters"><Input prefix={<Search size={15} />} value={query} onChange={event => setQuery(event.target.value)} placeholder={text('search')} aria-label={text('search')} allowClear />{view === 'vehicles' && <Select allowClear placeholder={text('status')} value={filter} onChange={setFilter} options={statuses.map(value => ({ value, label: text(value) }))} />}<Checkbox checked={archived} onChange={event => setArchived(event.target.checked)}>{text('showArchived')}</Checkbox></div>
  const selectedController = configuration?.controllerIndex !== null && configuration?.controllerIndex !== undefined ? (configuration.report.data as unknown as ReportData).parsed.controllers[configuration.controllerIndex] : null
  const configFields = ['supplier', 'serial', 'software', 'functionalPart', 'productPart', 'calibrationPart', 'calibrationVersion']
  return <section className="business-workspace"><div className="page-heading"><div><span className="eyebrow">{text(view).toUpperCase()}</span><h1>{text(view)}</h1></div><Space wrap><Tooltip title={text('refresh')}><Button icon={<RefreshCw size={16} />} aria-label={text('refresh')} loading={loading} onClick={() => void load()} /></Tooltip>{view === 'vehicles' && <Button type="primary" icon={<Plus size={16} />} onClick={() => setEditor({ kind: 'vehicle', vehicleId: null, record: null })}>{text('addVehicle')}</Button>}{view === 'sync' && <Button type="primary" loading={busy} icon={<FolderSync size={16} />} onClick={() => void synchronize()}>{text('syncNow')}</Button>}</Space></div>
    {(sync.error || sync.pending > 0 || sync.conflicts.length > 0) && view !== 'sync' && <Alert className="business-notice" type="warning" showIcon title={sync.error ? errorText(sync.error, language) : `${text('pending')}: ${sync.pending} · ${text('conflicts')}: ${sync.conflicts.length}`} />}
    {view === 'vehicles' && <><div className="fleet-stats"><div><span>{text('vehicles')}</span><strong>{cars.filter(car => !car.archived).length}</strong></div>{statuses.slice(0, 3).map(status => <div key={status}><span>{text(status)}</span><strong>{cars.filter(car => !car.archived && car.data.status === status).length}</strong></div>)}</div><div className="section-toolbar"><h3>{text('vehicles')}</h3><Space wrap><Button type="text" icon={<Download size={15} />} onClick={() => void download('/api/business/export', 'vehicle-data.json').catch(onError)}>{text('export')}</Button>{admin && <><Button icon={<Download size={15} />} disabled={!online} onClick={() => void download('/api/business/backup', `vehicle-backup-${new Date().toISOString().slice(0, 10)}.zip`).catch(onError)}>{text('backup')}</Button><Button icon={<RotateCcw size={15} />} disabled={!online} onClick={() => setRestoreOpen(true)}>{text('restoreBackup')}</Button></>}</Space></div>{filters}<Table<BusinessRecord> rowKey="id" loading={loading} size="middle" scroll={{ x: 1050 }} pagination={{ pageSize: 10, hideOnSinglePage: true }} dataSource={cars.filter(car => (archived || !car.archived) && (!filter || car.data.status === filter) && Object.values(car.data).join(' ').toLowerCase().includes(query.toLowerCase()))} columns={[
      { title: text('vehicle'), width: 250, fixed: 'left', render: (_, record) => <button className="record-link" onClick={() => { setSelectedId(record.id); setHistoryPage(1) }}><span className="car-symbol"><CarFront size={21} /></span><span><strong>{display(record.data.name)}</strong><small className="mono">{display(record.data.vin)}</small></span></button> },
      { title: text('project'), width: 100, render: (_, record) => display(record.data.project) }, { title: text('plate'), width: 140, render: (_, record) => <div className="record-title">{display(record.data.plate)}<small className={record.data.plateExpiry && String(record.data.plateExpiry) < today ? 'expired-date' : ''}>{display(record.data.plateExpiry)}</small></div> },
      { title: text('status'), width: 110, render: (_, record) => record.archived ? <Tag>{text('archived')}</Tag> : statusTag(String(record.data.status)) }, { title: 'OWNER', width: 130, render: (_, record) => display(record.data.owner) },
      { title: text('latestDove'), width: 150, render: (_, record) => { const report = reports.find(item => item.vehicleId === record.id && !item.archived); return report ? <button className="inline-link" onClick={() => setReportId(report.id)}>{display(report.data.recordedAt)}</button> : '—' } },
      { title: text('updated'), width: 160, render: (_, record) => <div className="record-title">{date(record.updated)}<small>v{record.version}</small></div> }, { title: text('actions'), width: 100, render: (_, record) => <Button type="text" icon={<ArrowUpRight size={17} />} aria-label={`${text('details')} ${record.data.name}`} onClick={() => { setSelectedId(record.id); setHistoryPage(1) }} /> },
    ]} /></>}
    <DoveImport active={view === 'dove'} language={language} disabled={busy} onBusyChange={setBusy} onRetained={load} onOpenReport={async id => { await load(); setReportId(id) }} onError={onError} />
    {view === 'reports' && <>{filters}<div className="section-toolbar"><span className="muted">{reportSelection.length} / 2</span><Button icon={<GitCompare size={16} />} disabled={reportSelection.length !== 2} loading={busy} onClick={() => void compare()}>{text('compare')}</Button></div>{reportTable(reports.filter(record => (archived || !record.archived) && `${record.data.name} ${vehicleName(record.vehicleId)} ${(record.data as unknown as ReportData).parsed.vin}`.toLowerCase().includes(query.toLowerCase())), true)}</>}
    {view === 'history' && history(changes)}
    {view === 'audit' && <><div className="business-filters"><Input prefix={<Search size={15} />} placeholder={text('search')} value={query} onChange={event => setQuery(event.target.value)} /></div><Table<AuditEntry> rowKey="id" size="small" dataSource={audit.filter(entry => `${entry.actor} ${text(entry.action)} ${JSON.stringify(entry.detail)}`.toLowerCase().includes(query.toLowerCase()))} scroll={{ x: 650 }} pagination={{ pageSize: 15 }} columns={[{ title: text('created'), width: 180, render: (_, entry) => date(entry.created) }, { title: text('actor'), width: 150, dataIndex: 'actor' }, { title: text('actions'), width: 180, render: (_, entry) => text(entry.action) }, { title: text('details'), render: (_, entry) => <details><summary>{text('details')}</summary><Descriptions column={1} size="small" items={Object.entries(entry.detail).map(([key, value]) => ({ key, label: text(key), children: display(value) }))} /></details> }]} /></>}
    {view === 'sync' && <><Alert type={sync.error ? 'warning' : sync.conflicts.length ? 'warning' : 'success'} showIcon icon={sync.error ? <CloudOff size={18} /> : undefined} title={sync.error ? errorText(sync.error, language) : text(sync.phase)} /><Descriptions className="sync-summary" column={{ xs: 1, sm: 2 }} items={[{ key: 'pending', label: text('pending'), children: sync.pending }, { key: 'conflicts', label: text('conflicts'), children: sync.conflicts.length }, { key: 'lastSync', label: text('lastSync'), children: sync.lastSync ? date(sync.lastSync) : '—' }, { key: 'revision', label: text('revision'), children: <span className="mono">{sync.revision || '—'}</span> }]} /><h3 className="sync-title">{text('conflicts')}</h3>{sync.conflicts.length ? sync.conflicts.map(conflict => <ConflictForm key={conflict.token} conflict={conflict} language={language} admin={admin} onResolve={async (item, choices, reason) => { try { setSync(await api<SyncStatus>(`/api/business/sync/${item.recordId}/resolve`, { method: 'POST', body: { token: item.token, choices, reason } })); await load() } catch (error) { onError(error) } }} />) : <Empty description={text('noRecords')} />}</>}

    <Drawer open={Boolean(selected)} onClose={() => setSelectedId(null)} title={selected ? display(selected.data.name) : ''} size={1000} destroyOnHidden extra={selected && recordActions(selected)}><Tabs items={selected ? [
      { key: 'overview', label: text('overview'), children: <><Descriptions column={{ xs: 1, sm: 2 }} items={vehicleFields.map(key => ({ key, label: text(key === 'name' ? 'nickName' : key), children: <span className="preserve-text">{key === 'status' ? text(String(selected.data[key])) : display(selected.data[key])}</span> }))} /><div className="drawer-version">v{selected.version} · {date(selected.updated)}</div></> },
      { key: 'parts', label: text('parts'), children: entryTable('part', selected) }, { key: 'modifications', label: text('modifications'), children: entryTable('modification', selected) }, { key: 'equipment', label: text('equipment'), children: entryTable('equipment', selected) },
      { key: 'reports', label: text('reports'), children: reportTable(reports.filter(record => record.vehicleId === selected.id && (!record.archived || archived))) },
      { key: 'attachments', label: text('attachments'), children: <><div className="dove-upload"><Upload accept=".xlsx,.xls,.pdf,.png,.jpg,.jpeg" maxCount={1} beforeUpload={value => { setAttachmentFile(value); return false }} onRemove={() => setAttachmentFile(null)}><Button icon={<Plus size={15} />}>{text('chooseFile')}</Button></Upload><Button type="primary" disabled={!attachmentFile || selected.archived} loading={busy} onClick={() => void saveFile(selected.id)}>{text('upload')}</Button></div><Table<BusinessRecord> rowKey="id" size="small" dataSource={records.filter(record => record.kind === 'attachment' && record.vehicleId === selected.id && (archived || !record.archived))} columns={[{ title: text('name'), render: (_, record) => display(record.data.name) }, { title: text('size'), render: (_, record) => `${(Number(record.data.size) / 1024).toFixed(1)} KB` }, { title: text('actions'), render: (_, record) => <Space><Button icon={<Download size={15} />} onClick={() => downloadFile(record)}>{text('download')}</Button>{recordActions(record)}</Space> }]} /></> },
      { key: 'history', label: text('history'), children: history(changes.filter(change => change.vehicleId === selected.id)) },
    ] : []} /></Drawer>
    {editor && <RecordEditor record={editor.record} kind={editor.kind} language={language} busy={busy} onCancel={() => { if (!busy) setEditor(null) }} onSave={(data, reason) => void saveRecord(data, reason)} />}
    <Modal open={Boolean(action)} title={action ? text(action.type === 'remove' ? 'recordRemoval' : action.archived ? 'archive' : 'restore') : ''} onCancel={() => { if (!busy) setAction(null) }} onOk={() => void applyAction()} confirmLoading={busy} okText={text('save')} cancelText={text('cancel')} okButtonProps={{ disabled: !actionReason.trim() }}><p className="operation-name">{display(action?.record.data.name)}</p><label className="standalone-label">{text('reason')}<Input.TextArea value={actionReason} maxLength={500} rows={3} onChange={event => setActionReason(event.target.value)} /></label></Modal>
    <Modal open={Boolean(activeReport)} onCancel={() => setReportId(null)} title={activeReport ? display(activeReport.data.name) : ''} footer={null} width={1150} destroyOnHidden>{activeReport && <><div className="report-actions"><Button icon={<Download size={16} />} onClick={() => downloadFile(activeReport)}>{text('download')}</Button><Button type="primary" icon={<ClipboardCheck size={16} />} disabled={activeReport.archived} onClick={() => setConfiguration({ report: activeReport, controllerIndex: null, part: null, fields: [], reason: '' })}>{text('updateConfiguration')}</Button>{recordActions(activeReport)}</div><Suspense fallback={<Spin />}><ReportViewer report={(activeReport.data as unknown as ReportData).parsed} language={language} /></Suspense></>}</Modal>
    <Modal open={Boolean(comparison)} onCancel={() => setComparison(null)} title={text('compare')} footer={null} width={1200} destroyOnHidden>{comparison && <><Alert type="info" showIcon title={text('comparisonNote')} /><div className="comparison-names"><span>{display(comparison.left.data.name)} · {display(comparison.left.data.recordedAt)}</span><span>{display(comparison.right.data.name)} · {display(comparison.right.data.recordedAt)}</span></div><Tabs items={['controllers', 'faults'].map(kind => ({ key: kind, label: text(kind), children: <Table<Difference> rowKey="key" dataSource={comparison[kind as 'controllers' | 'faults']} size="small" scroll={{ x: 900 }} pagination={{ pageSize: 10 }} columns={[{ title: text(kind === 'controllers' ? 'controller' : 'code'), dataIndex: 'key', width: 150 }, { title: text('status'), width: 110, render: (_, record) => <Tag color={record.status === 'changed' ? 'warning' : record.status === 'added' ? 'processing' : 'default'}>{text(record.status)}</Tag> }, { title: text('leftReport'), width: 320, render: (_, record) => <DifferenceValue value={record.before} fields={record.fields} text={text} /> }, { title: text('rightReport'), width: 320, render: (_, record) => <DifferenceValue value={record.after} fields={record.fields} text={text} /> }]} /> }))} /></>}</Modal>
    <Modal open={Boolean(configuration)} onCancel={() => { if (!busy) setConfiguration(null) }} title={text('updateConfiguration')} width={950} confirmLoading={busy} onOk={() => void applyConfiguration()} okText={text('save')} cancelText={text('cancel')} okButtonProps={{ disabled: !configuration?.part || configuration.controllerIndex === null || !configuration.fields.length || !configuration.reason.trim() }} destroyOnHidden>{configuration && <div className="configuration-form"><label>{text('controller')}<Select value={configuration.controllerIndex} placeholder={text('controller')} onChange={value => setConfiguration({ ...configuration, controllerIndex: value, fields: [] })} options={(configuration.report.data as unknown as ReportData).parsed.controllers.map((controller, index) => ({ value: index, label: `${controller.name} · ${controller.network} · ${controller.serial || '—'}` }))} /></label><label>{text('targetPart')}<Select value={configuration.part?.id} placeholder={text('targetPart')} onChange={value => setConfiguration({ ...configuration, part: records.find(record => record.id === value) || null, fields: [] })} options={records.filter(record => record.kind === 'part' && record.vehicleId === configuration.report.vehicleId && record.data.category === 'controller' && !record.archived && !record.data.removedAt).map(record => ({ value: record.id, label: `${record.data.name} · ${record.data.position || '—'} · ${record.data.serial || '—'}` }))} /></label>{selectedController && configuration.part && <Table rowKey="field" dataSource={configFields.map(field => ({ field, current: configuration.part!.data[field], incoming: selectedController[field as keyof typeof selectedController] }))} rowSelection={{ selectedRowKeys: configuration.fields, onChange: keys => setConfiguration({ ...configuration, fields: keys.map(String) }) }} pagination={false} size="small" scroll={{ x: 600 }} columns={[{ title: text('applyFields'), render: (_, record) => text(record.field) }, { title: text('currentValue'), render: (_, record) => <span className="preserve-text">{display(record.current)}</span> }, { title: text('reportValue'), render: (_, record) => <span className="preserve-text">{display(record.incoming)}</span> }]} />}<label>{text('configurationReason')}<Input.TextArea value={configuration.reason} maxLength={500} rows={2} onChange={event => setConfiguration({ ...configuration, reason: event.target.value })} /></label></div>}</Modal>
    <Modal open={restoreOpen} title={text('restoreBackup')} onCancel={() => { if (!busy) setRestoreOpen(false) }} onOk={() => void restore()} okText={text('restore')} cancelText={text('cancel')} confirmLoading={busy} okButtonProps={{ disabled: !restoreFile || confirmation !== 'RESTORE' || !restoreReason.trim() || sync.pending > 0 }} destroyOnHidden><div className="configuration-form">{sync.pending > 0 && <Alert type="warning" title={text('pendingBeforeRestore')} />}<Upload accept=".zip" maxCount={1} beforeUpload={value => { setRestoreFile(value); return false }} onRemove={() => setRestoreFile(null)}><Button icon={<UploadIcon size={16} />}>{text('chooseFile')} · .zip</Button></Upload><label>{text('restoreConfirmation')}<Input value={confirmation} onChange={event => setConfirmation(event.target.value)} /></label><label>{text('reason')}<Input.TextArea maxLength={500} rows={2} value={restoreReason} onChange={event => setRestoreReason(event.target.value)} /></label></div></Modal>
  </section>
}
