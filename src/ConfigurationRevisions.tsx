import { useEffect, useEffectEvent, useRef, useState } from 'react'
import { Alert, App, Button, Card, Descriptions, Empty, Input, Modal, Select, Space, Spin, Table, Tag, Tooltip } from 'antd'
import { ClipboardCopy, GitCompare, Plus, RefreshCw } from 'lucide-react'
import type { BusinessRecord } from '../shared/business'
import { configurationDecisionKey, configurationSections, configurationSnapshot, validateConfigurationRevisionRecord } from '../shared/configuration-revisions'
import type { ComponentTypeCatalog, ConfigurationDecisions, ConfigurationPreview, ConfigurationPublicationReceipt, ConfigurationPublishRequest, ConfigurationRevisionData, ConfigurationRevisionRecord, ConfigurationRevisionSummary } from '../shared/configuration-revisions'
import { ApiError, createWorkspaceScope } from './api'
import { translateBusiness } from './business-i18n'
import { errorText } from './i18n'
import type { Language } from './i18n'
import { compareConfigurationRevisions, configurationComponentName, configurationRevisionText } from './configuration-revision-view'
import './ConfigurationRevisions.css'

type Scope = ReturnType<typeof createWorkspaceScope>
export type ConfigurationRevisionsProps = {
  vehicle: BusinessRecord; records: BusinessRecord[]; language: Language; online: boolean; syncPaused: boolean; admin: boolean; catalog: ComponentTypeCatalog; current?: ConfigurationRevisionSummary
  onChanged: (scope: Scope, signal: AbortSignal) => Promise<void>; onBusyChange: (busy: boolean) => void; onError: (error: unknown) => void
}
const emptyDecisions = (): ConfigurationDecisions => ({ fields: {}, sections: {} })
const textValue = (value: unknown) => value === undefined || value === null || value === '' ? '—' : String(value)
const uncertain = new Set(['NETWORK_ERROR', 'SERVER_ERROR', 'SHARE_IO_ERROR', 'LOCAL_REFRESH_REQUIRED'])

export function ConfigurationRevisionSummaryPanel({ vehicle, language, catalog, current, onOpen }: Pick<ConfigurationRevisionsProps, 'vehicle' | 'language' | 'catalog' | 'current'> & { onOpen: () => void }) {
  const text = translateBusiness(language)
  return <div className="configuration-current-summary"><Space wrap><strong>{text('configurationRevision')}</strong><Tag color={current ? 'blue' : undefined}>{current?.label || text('noConfigurationRevision')}</Tag>{current?.hasChanges && <Tag color="warning">{text('unpublishedConfigurationChanges')}</Tag>}<Button size="small" onClick={onOpen}>{text(current && !current.hasChanges ? 'configurationRevisions' : 'createConfigurationRevision')}</Button></Space>{!catalog.enabled && <p className="muted">{text('configurationDisabledNotice')}</p>}{vehicle.archived && <span className="muted">{text('archived')}</span>}</div>
}

function SnapshotView({ data, language }: { data: ConfigurationRevisionData; language: Language }) {
  const text = translateBusiness(language), at = language === 'zh' ? 1 : 0
  return <div className="configuration-snapshot"><Descriptions size="small" column={{ xs: 1, sm: 2 }} items={[
    { key: 'vin', label: 'VIN', children: data.vin }, { key: 'revision', label: text('configurationRevision'), children: data.label },
    { key: 'author', label: text('actor'), children: data.actor.name }, { key: 'time', label: text('configurationPublished'), children: new Date(data.publishedAt).toLocaleString(language === 'zh' ? 'zh-CN' : 'en-GB') },
    { key: 'summary', label: text('configurationSummary'), span: 2, children: <span className="preserve-text">{data.summary}</span> },
  ]} />{data.snapshot.sections.map(section => <Card size="small" key={section.typeId} title={section.label[at]}>{section.state !== 'installed' ? <p>{text(section.state === 'unknown' ? 'configurationUnknown' : 'configurationNotInstalled')} · {section.reason}</p> : section.components.map(component => <div className="configuration-component" key={component.id}><h4>{configurationComponentName(component, language)}</h4><Descriptions size="small" column={{ xs: 1, sm: 2 }} items={component.fields.map(field => ({ key: field.id, label: field.label[at], children: <span className="preserve-text">{field.state === 'known' ? textValue(field.value) : <><Tag>{text(field.state === 'unknown' ? 'configurationUnknown' : 'configurationNotApplicable')}</Tag>{field.reason}</>}</span> }))} /></div>)}</Card>)}</div>
}

export default function ConfigurationRevisions({ vehicle, records, language, online, syncPaused, catalog, current, onChanged, onBusyChange, onError }: ConfigurationRevisionsProps) {
  const text = translateBusiness(language), at = language === 'zh' ? 1 : 0, { message } = App.useApp()
  const [scope] = useState(createWorkspaceScope), controller = useRef(new AbortController())
  const active = useRef(true), historySequence = useRef(0), previewSequence = useRef(0), admitted = useRef(false)
  const [history, setHistory] = useState<ConfigurationRevisionSummary[]>([]), [loading, setLoading] = useState(false), [saving, setSaving] = useState(false)
  const [review, setReview] = useState<ConfigurationPreview | null>(null), [previewBusy, setPreviewBusy] = useState(false), [error, setError] = useState<string | null>(null)
  const [title, setTitle] = useState(''), [summary, setSummary] = useState(''), [decisions, setDecisions] = useState<ConfigurationDecisions>(emptyDecisions)
  const [submitted, setSubmitted] = useState<ConfigurationPublishRequest | null>(null), [detail, setDetail] = useState<ConfigurationRevisionRecord | null>(null)
  const [selection, setSelection] = useState<string[]>([]), [comparison, setComparison] = useState<[ConfigurationRevisionRecord, ConfigurationRevisionRecord] | null>(null)
  const endpoint = `/api/business/vehicles/${encodeURIComponent(vehicle.id)}/configuration-revisions`
  const available = online && !syncPaused && catalog.enabled && !vehicle.archived
  const isCurrent = () => active.current && !controller.current.signal.aborted
  const finishBusy = useEffectEvent(() => { previewSequence.current++; if (admitted.current) { admitted.current = false; onBusyChange(false) } })
  useEffect(() => { active.current = true; if (controller.current.signal.aborted) controller.current = new AbortController(); const current = controller.current; return () => { active.current = false; current.abort(); finishBusy() } }, [])
  async function loadHistory() {
    if (!catalog.enabled) { setHistory([]); return }
    const sequence = ++historySequence.current; setLoading(true)
    try { const result = await scope.request<ConfigurationRevisionSummary[]>(endpoint, { signal: controller.current.signal }); if (isCurrent() && historySequence.current === sequence) setHistory(result) }
    catch (cause) { if (isCurrent() && !(cause instanceof ApiError && cause.message === 'WORKSPACE_CHANGED')) onError(cause) }
    finally { if (isCurrent() && historySequence.current === sequence) setLoading(false) }
  }
  const refreshHistory = useEffectEvent(loadHistory)
  useEffect(() => { let mounted = true; void Promise.resolve().then(() => { if (mounted) void refreshHistory() }); return () => { mounted = false } }, [vehicle.id, current?.revisionId, catalog.enabled])
  async function refreshPreview() {
    if (!available || saving || submitted) return
    const sequence = ++previewSequence.current
    const currentPreview = () => isCurrent() && sequence === previewSequence.current
    setPreviewBusy(true); setError(null)
    try {
      const result = await scope.request<ConfigurationPreview>(`${endpoint}/preview`, { method: 'POST', body: {}, signal: controller.current.signal })
      if (!currentPreview()) return
      setReview(result)
      setDecisions(previous => {
        const next = emptyDecisions()
        for (const section of result.sections) {
          if (!section.components.length && previous.sections[section.typeId]) next.sections[section.typeId] = previous.sections[section.typeId]
          for (const component of section.components) for (const field of component.fields) {
            const key = configurationDecisionKey(component.id, field.id)
            if (field.required && !field.value.trim() && previous.fields[key]) next.fields[key] = previous.fields[key]
          }
        }
        return next
      })
    } catch (cause) { if (currentPreview()) { setError(cause instanceof Error ? cause.message : 'SERVER_ERROR'); if (!(cause instanceof ApiError && cause.message === 'WORKSPACE_CHANGED')) onError(cause) } }
    finally { if (currentPreview()) setPreviewBusy(false) }
  }
  function openReview() {
    previewSequence.current++; setPreviewBusy(false)
    setTitle(''); setSummary(''); setError(null); setSubmitted(null); setDecisions(emptyDecisions())
    setReview({ token: '', expires: 0, vehicleId: vehicle.id, vin: String(vehicle.data.vin || ''), previousRevisionId: current?.revisionId || null, previousNumber: current?.number || 0, sections: configurationSections(records, vehicle.id, catalog.types) })
    if (available) void refreshPreview()
  }
  function cancelReview() {
    if (saving) return
    previewSequence.current++; setPreviewBusy(false); setReview(null); setSubmitted(null); setError(null)
  }
  let complete = false
  if (review) try { configurationSnapshot(review.sections, decisions); complete = Boolean(summary.trim() && summary.length <= 500) } catch { /* Missing values are explained inline. */ }
  async function publish() {
    if (!review || !available || saving || previewBusy || !submitted && (!review.token || !complete)) return
    const request = submitted || { previewToken: review.token, requestId: crypto.randomUUID(), title: title.trim(), summary: summary.trim(), decisions }
    setSubmitted(request); setSaving(true); setError(null); admitted.current = true; onBusyChange(true)
    try {
      const receipt = await scope.request<ConfigurationPublicationReceipt>(endpoint, { method: 'POST', body: request, signal: controller.current.signal })
      if (!receipt.localSynced) throw new ApiError('LOCAL_REFRESH_REQUIRED')
      scope.assertCurrent(controller.current.signal)
      await onChanged(scope, controller.current.signal)
      if (isCurrent()) { previewSequence.current++; setReview(null); setSubmitted(null); await loadHistory() }
    } catch (cause) {
      if (!isCurrent()) return
      const code = cause instanceof Error ? cause.message : 'SERVER_ERROR'
      setError(code)
      if (!uncertain.has(code)) {
        setSubmitted(null)
        if (['REVISION_PREVIEW_CHANGED', 'REVISION_PREVIEW_EXPIRED', 'REVISION_PENDING_CHANGES', 'VERSION_CONFLICT'].includes(code)) setReview(previous => previous ? { ...previous, token: '' } : previous)
      }
      if (!(cause instanceof ApiError && cause.message === 'WORKSPACE_CHANGED')) onError(cause)
    } finally { admitted.current = false; if (isCurrent()) { setSaving(false); onBusyChange(false) } }
  }
  async function getRevision(id: string) {
    const record = await scope.request<ConfigurationRevisionRecord>(`${endpoint}/${encodeURIComponent(id)}`, { signal: controller.current.signal })
    validateConfigurationRevisionRecord(record)
    return record
  }
  async function openDetail(id: string) {
    setLoading(true)
    try { const result = await getRevision(id); if (isCurrent()) setDetail(result) }
    catch (cause) { if (isCurrent() && !(cause instanceof ApiError && cause.message === 'WORKSPACE_CHANGED')) onError(cause) }
    finally { if (isCurrent()) setLoading(false) }
  }
  async function compare() {
    if (selection.length !== 2) return
    setLoading(true)
    try { const values = await Promise.all(selection.map(getRevision)); if (isCurrent()) setComparison(values.sort((a, b) => a.data.number - b.data.number) as [ConfigurationRevisionRecord, ConfigurationRevisionRecord]) }
    catch (cause) { if (isCurrent() && !(cause instanceof ApiError && cause.message === 'WORKSPACE_CHANGED')) onError(cause) }
    finally { if (isCurrent()) setLoading(false) }
  }
  async function copy(data: ConfigurationRevisionData) {
    try { await navigator.clipboard.writeText(configurationRevisionText(data, language)); scope.assertCurrent(controller.current.signal); if (isCurrent()) void message.success(text('configurationSummaryCopied')) }
    catch (cause) { if (isCurrent()) onError(cause) }
  }
  function decisionFields(componentId: string, fieldId: string, patch: Partial<ConfigurationDecisions['fields'][string]>) {
    const key = configurationDecisionKey(componentId, fieldId)
    setDecisions(previous => ({ ...previous, fields: { ...previous.fields, [key]: { ...(previous.fields[key] || { state: 'unknown' as const, reason: '' }), ...patch } } }))
  }
  return <div className="configuration-revisions">
    <ConfigurationRevisionSummaryPanel vehicle={vehicle} language={language} catalog={catalog} current={current} onOpen={() => { if (current && !current.hasChanges) void openDetail(current.revisionId); else openReview() }} />
    <p className="muted">{text('configurationFrozenNotice')}</p>
    {!catalog.enabled && <Alert type="info" showIcon title={text('configurationDisabledNotice')} />}
    {(!online || syncPaused) && <Alert type="info" showIcon title={text('configurationOfflineNotice')} />}
    <Space wrap className="configuration-revision-toolbar"><Button type="primary" icon={<Plus size={15} />} disabled={vehicle.archived || !catalog.enabled} onClick={openReview}>{text('createConfigurationRevision')}</Button><Button icon={<GitCompare size={15} />} disabled={selection.length !== 2 || loading} onClick={() => void compare()}>{text('configurationCompare')}</Button><Button icon={<RefreshCw size={15} />} loading={loading} onClick={() => void loadHistory()}>{text('refresh')}</Button></Space>
    <Table<ConfigurationRevisionSummary> rowKey="revisionId" size="small" loading={loading} dataSource={history} pagination={{ pageSize: 10, hideOnSinglePage: true }} scroll={{ x: 680 }} rowSelection={{ selectedRowKeys: selection, onChange: keys => setSelection(keys.map(String).slice(-2)) }} columns={[
      { title: text('configurationRevision'), width: 115, render: (_, row) => <button className="inline-link" onClick={() => void openDetail(row.revisionId)}>{row.label}</button> },
      { title: text('configurationTitle'), width: 170, dataIndex: 'title' }, { title: text('configurationSummary'), width: 240, dataIndex: 'summary' },
      { title: text('actor'), width: 120, render: (_, row) => row.actor.name }, { title: text('configurationPublished'), width: 160, render: (_, row) => new Date(row.publishedAt).toLocaleString(language === 'zh' ? 'zh-CN' : 'en-GB') },
    ]} locale={{ emptyText: <Empty description={text('noConfigurationRevision')} image={Empty.PRESENTED_IMAGE_SIMPLE} /> }} />
    <Modal open={Boolean(review)} className="configuration-review-modal" title={text('configurationReview')} width={980} onCancel={cancelReview} footer={<Space wrap><Button disabled={saving} onClick={cancelReview}>{text('cancel')}</Button><Button icon={<RefreshCw size={14} />} disabled={!available || saving || Boolean(submitted)} loading={previewBusy} onClick={() => void refreshPreview()}>{text('configurationRefreshPreview')}</Button><Tooltip title={!available ? text('configurationOfflineNotice') : !complete ? text('configurationExplanationNeeded') : undefined}><Button type="primary" loading={saving} disabled={!available || previewBusy || !submitted && (!review?.token || !complete)} onClick={() => void publish()}>{text(submitted ? 'configurationRetryPublish' : 'publishConfigurationRevision')}</Button></Tooltip></Space>} destroyOnHidden>
      {review && <div className="configuration-review"><Alert type="info" showIcon title={`${review.vin} · ${text('configurationPreviousRevision')}: ${review.previousNumber ? `R${String(review.previousNumber).padStart(2, '0')}` : '—'}`} description={text('configurationReviewNotice')} />
        {error && <Alert type="warning" showIcon title={submitted ? text('configurationPublicationUnknown') : errorText(error, language)} />}
        {!available && <Alert type="warning" showIcon title={text('configurationOfflineNotice')} />}
        <label className="configuration-input-label">{text('configurationTitle')}<Input value={title} disabled={saving || Boolean(submitted)} maxLength={120} onChange={event => setTitle(event.target.value)} /></label>
        <label className="configuration-input-label">{text('configurationSummary')}<Input.TextArea value={summary} disabled={saving || Boolean(submitted)} maxLength={500} rows={2} onChange={event => setSummary(event.target.value)} /></label>
        {previewBusy && <Spin />}{review.sections.map(section => <Card size="small" key={section.typeId} title={section.label[at]}>{!section.components.length ? <div className="configuration-explanation"><p>{text('componentSectionMissing')}</p><Select aria-label={`${section.label[at]} ${text('configurationSelectExplanation')}`} value={decisions.sections[section.typeId]?.state} disabled={saving || Boolean(submitted)} placeholder={text('configurationSelectExplanation')} options={[{ value: 'unknown', label: text('configurationUnknown') }, { value: 'notInstalled', label: text('configurationNotInstalled') }]} onChange={state => setDecisions(previous => ({ ...previous, sections: { ...previous.sections, [section.typeId]: { reason: previous.sections[section.typeId]?.reason || '', state } } }))} /><Input.TextArea aria-label={`${section.label[at]} ${text('configurationMissingReason')}`} placeholder={text('configurationMissingReason')} value={decisions.sections[section.typeId]?.reason || ''} maxLength={500} disabled={saving || Boolean(submitted) || !decisions.sections[section.typeId]?.state} onChange={event => setDecisions(previous => ({ ...previous, sections: { ...previous.sections, [section.typeId]: { state: previous.sections[section.typeId]?.state || 'unknown', reason: event.target.value } } }))} /></div> : section.components.map(component => <div className="configuration-component" key={component.id}><h4>{configurationComponentName(component, language)}</h4>{component.fields.map(field => { const key = configurationDecisionKey(component.id, field.id); return <div className="configuration-review-field" key={field.id}><strong>{field.label[at]}</strong>{field.required && !field.value.trim() ? <div className="configuration-explanation"><Select aria-label={`${configurationComponentName(component, language)} ${field.label[at]} ${text('configurationSelectExplanation')}`} value={decisions.fields[key]?.state} disabled={saving || Boolean(submitted)} placeholder={text('configurationSelectExplanation')} options={[{ value: 'unknown', label: text('configurationUnknown') }, { value: 'notApplicable', label: text('configurationNotApplicable') }]} onChange={state => decisionFields(component.id, field.id, { state })} /><Input.TextArea aria-label={`${configurationComponentName(component, language)} ${field.label[at]} ${text('configurationMissingReason')}`} placeholder={text('configurationMissingReason')} value={decisions.fields[key]?.reason || ''} maxLength={500} disabled={saving || Boolean(submitted) || !decisions.fields[key]?.state} rows={2} onChange={event => decisionFields(component.id, field.id, { reason: event.target.value })} /></div> : <span className="preserve-text">{textValue(field.value)}</span>}</div> })}</div>)}</Card>)}
      </div>}
    </Modal>
    <Modal open={Boolean(detail)} title={detail ? `${detail.data.label}${detail.data.title ? ` · ${detail.data.title}` : ''}` : ''} width={1000} onCancel={() => setDetail(null)} footer={detail && <Button icon={<ClipboardCopy size={15} />} onClick={() => void copy(detail.data)}>{text('configurationCopySummary')}</Button>} destroyOnHidden>{detail && <SnapshotView data={detail.data} language={language} />}</Modal>
    <Modal open={Boolean(comparison)} title={comparison ? `${comparison[0].data.label} → ${comparison[1].data.label}` : text('configurationCompare')} width={1100} onCancel={() => setComparison(null)} footer={null} destroyOnHidden>{comparison && <Table rowKey="key" size="small" pagination={{ pageSize: 12 }} scroll={{ x: 760 }} locale={{ emptyText: text('configurationNoDifference') }} dataSource={compareConfigurationRevisions(comparison[0].data, comparison[1].data, language)} columns={[{ title: text('configurationRevision'), dataIndex: 'name', width: 280 }, { title: comparison[0].data.label, dataIndex: 'before', width: 280 }, { title: comparison[1].data.label, dataIndex: 'after', width: 280 }, { title: text('status'), render: (_, row) => <Tag>{text(row.status)}</Tag>, width: 100 }]} />}</Modal>
  </div>
}
