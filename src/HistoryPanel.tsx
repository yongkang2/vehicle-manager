import { useEffect, useId, useRef, useState } from 'react'
import { Alert, Button, Empty, Input, Pagination, Spin, Select, DatePicker, Tooltip, Popover } from 'antd'
import type { DatePickerProps } from 'antd'
import { Download, Search, CircleHelp, Clock3 } from 'lucide-react'
import { createWorkspaceScope } from './api'
import { errorText, type Language } from './i18n'
import { translateBusiness } from './business-i18n'
import type { Change, SyncStatus } from '../shared/business'
import { historyChangedFields } from './history-presentation'
import './HistoryPanel.css'

type HistoryItem = Change & { vehicleLabel: string; changedFieldCount: number; statusChanged: boolean }
type HistoryResult = { items: HistoryItem[]; sync: SyncStatus; total: number; page: number; pageSize: number }
const value = (item: unknown, missing: string): string => item === undefined ? missing : typeof item === 'string' ? item || '—' : JSON.stringify(item) ?? missing

function HistoryEntry({ change, language, reportIds, onOpenReport }: { change: HistoryItem; language: Language; reportIds?: string[]; onOpenReport?: (id: string) => void }) {
  const text = translateBusiness(language), zh = language === 'zh'
  const missing = zh ? '（无此字段）' : '(not present)'
  const [open, setOpen] = useState(false), [detail, setDetail] = useState<Change | null>(null), [error, setError] = useState(''), [retry, setRetry] = useState(0)
  useEffect(() => {
    if (!open || detail) return
    const controller = new AbortController(), scope = createWorkspaceScope()
    void scope.request<Change>(`/api/business/history/changes/${encodeURIComponent(change.id)}`, { signal: controller.signal }).then(next => {
      scope.assertCurrent(controller.signal); setDetail(next); setError('')
    }).catch(cause => { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : 'SERVER_ERROR') })
    return () => controller.abort()
  }, [open, detail, change.id, retry])
  const fields = open && detail ? historyChangedFields(detail) : []
  const statusChanged = detail ? detail.archivedBefore !== null && detail.archivedBefore !== detail.archivedAfter : false
  const name = String(change.after.name || change.before?.name || '').trim()
  const category = change.after.category || change.before?.category
  const kind = change.kind === 'part' ? category === 'battery' ? text('hvBattery') : category === 'controller' || /^(VCU|MCU|BMS|MSB|BMS\/MSB)$/i.test(name) ? text('part') : zh ? '部件' : 'component' : text(change.kind)
  const vehicleLabel = change.vehicleLabel && change.vehicleLabel !== change.vehicleId ? change.vehicleLabel : zh ? '未知车辆' : 'Unknown vehicle'
  const object = change.kind === 'vehicle' ? vehicleLabel : zh ? `${vehicleLabel} 的 ${name ? `${name} ` : ''}${kind}` : `${vehicleLabel} · ${name ? `${name} ` : ''}${kind}`
  const diff = (key: string) => <div className="history-field" key={key}><strong>{text(key)}</strong><del>{value(detail?.before?.[key], missing)}</del><span aria-label={zh ? '变为' : 'changed to'}>→</span><ins>{value(detail?.after[key], missing)}</ins></div>
  return <article className="history-entry">
    <header><p className="history-summary"><strong>{change.actor.name}</strong><span className="history-action">{text(change.action === 'updated' ? 'updatedAction' : change.action)}</span><span className="history-object">{object}</span></p><time dateTime={change.created}>{new Date(change.created).toLocaleString(zh ? 'zh-CN' : 'en-GB')}</time></header>
    <p className="history-reason"><span>{text('reason')}{zh ? '： ' : ': '}</span>{change.reason || '—'}</p>
    <details onToggle={event => setOpen(event.currentTarget.open)}><summary>{zh ? `查看变更（${change.changedFieldCount + Number(change.statusChanged)}）` : `View changes (${change.changedFieldCount + Number(change.statusChanged)})`}</summary>
      {open && (!detail ? error ? <Alert type="error" showIcon title={errorText(error, language)} action={<Button onClick={() => { setError(''); setRetry(item => item + 1) }}>{zh ? '重试' : 'Retry'}</Button>} /> : <Spin aria-label={zh ? '正在加载变更…' : 'Loading changes…'} /> : <>
      <div className="history-detail-body">
      {(fields.length > 0 || statusChanged) && <div className="history-diff-heading" aria-hidden="true"><span>{zh ? '字段' : 'Field'}</span><span>{zh ? '变更前' : 'Before'}</span><span /><span>{zh ? '变更后' : 'After'}</span></div>}
      <div className="history-diffs">{fields.map(diff)}
        {statusChanged && <div className="history-field"><strong>{text('status')}</strong><del>{text(detail.archivedBefore ? 'archived' : 'available')}</del><span>→</span><ins>{text(detail.archivedAfter ? 'archived' : 'available')}</ins></div>}
        {!fields.length && !statusChanged && <p className="muted">{zh ? '没有字段值变更' : 'No field value changes'}</p>}
      </div>
      {change.sourceId && (reportIds?.includes(change.sourceId) && onOpenReport ? <Button type="link" onClick={() => onOpenReport(change.sourceId!)}>{text('source')}</Button> : <p className="muted">{text('sourceUnavailable')}</p>)}
      <p className="history-actor-id">{zh ? '操作人 ID' : 'Actor ID'}: {change.actor.id}</p>
      </div>
      </>)}
    </details>
  </article>
}

export default function HistoryPanel({ language, vehicleId, refreshToken, reportIds, onOpenReport }: { language: Language; vehicleId?: string; refreshToken?: unknown; reportIds?: string[]; onOpenReport?: (id: string) => void }) {
  const zh = language === 'zh', text = translateBusiness(language)
  const searchHelpId = useId()
  const searchHelp = zh ? '搜索操作人、原因、字段名或内容；多个关键词用空格分隔，同时匹配。' : 'Search people, reasons, field names or content. Separate keywords with spaces to match all.'
  const [selectedVehicle, setSelectedVehicle] = useState<string | undefined>(), [day, setDay] = useState<Exclude<DatePickerProps['value'], unknown[]>>(null)
  const activeVehicle = vehicleId || selectedVehicle
  const date = day?.format('YYYY-MM-DD') || ''
  const offset = day ? day.toDate().getTimezoneOffset() : 0
  const endOffset = day ? day.add(1, 'day').toDate().getTimezoneOffset() : 0
  const [vehicleOptions, setVehicleOptions] = useState<{ id: string; label: string }[]>([])
  const [optionsError, setOptionsError] = useState('')
  const [draft, setDraft] = useState(''), [query, setQuery] = useState(''), [page, setPage] = useState(1), [composing, setComposing] = useState(false)
  const filterKey = JSON.stringify([activeVehicle || '', date, offset, endOffset, query])
  const requestKey = JSON.stringify([filterKey, page])
  const [result, setResult] = useState<(HistoryResult & { filterKey: string; requestKey: string }) | null>(null), [loading, setLoading] = useState(true), [error, setError] = useState(''), [retry, setRetry] = useState(0)
  const [exporting, setExporting] = useState(false), [exportError, setExportError] = useState('')
  const exportController = useRef<AbortController | null>(null)
  useEffect(() => { if (composing) return; const timer = setTimeout(() => { setQuery(draft.trim()); setPage(1) }, draft ? 300 : 0); return () => clearTimeout(timer) }, [draft, composing])
  useEffect(() => {
    const controller = new AbortController(), scope = createWorkspaceScope()
    void Promise.resolve().then(async () => {
      if (controller.signal.aborted) return
      setLoading(true); setError('')
      try {
        const params = new URLSearchParams({ summary: '1', q: query, page: String(page), ...(activeVehicle ? { vehicleId: activeVehicle } : {}), ...(date ? { date, offset: String(offset), endOffset: String(endOffset) } : {}) })
        const next = await scope.request<HistoryResult>(`/api/business/history/query?${params}`, { signal: controller.signal })
        scope.assertCurrent(controller.signal)
        if (next.page !== page) { setPage(next.page); return }
        setResult({ ...next, filterKey, requestKey })
      } catch (cause) { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : 'SERVER_ERROR') }
      finally { if (!controller.signal.aborted) setLoading(false) }
    })
    return () => controller.abort()
  }, [activeVehicle, date, offset, endOffset, query, page, retry, refreshToken, filterKey, requestKey])
  useEffect(() => {
    if (vehicleId) return
    const controller = new AbortController(), scope = createWorkspaceScope()
    void scope.request<{ vehicleOptions: { id: string; label: string }[] }>('/api/business/history/options', { signal: controller.signal }).then(next => {
      scope.assertCurrent(controller.signal); setVehicleOptions(next.vehicleOptions); setOptionsError('')
    }).catch(cause => { if (!controller.signal.aborted) setOptionsError(cause instanceof Error ? cause.message : 'SERVER_ERROR') })
    return () => controller.abort()
  }, [vehicleId, refreshToken, retry])
  const visibleResult = result?.requestKey === requestKey ? result : null
  useEffect(() => { void Promise.resolve().then(() => { setExporting(false); setExportError('') }); return () => { exportController.current?.abort(); exportController.current = null } }, [filterKey, draft, composing])
  const exportReady = !loading && !error && !composing && draft.trim() === query && result?.filterKey === filterKey && result.total > 0
  async function exportHistory() {
    if (!exportReady || exportController.current) return
    const controller = new AbortController(), scope = createWorkspaceScope()
    exportController.current = controller; setExporting(true); setExportError('')
    try {
      const params = new URLSearchParams({ q: query, ...(activeVehicle ? { vehicleId: activeVehicle } : {}), ...(date ? { date, offset: String(offset), endOffset: String(endOffset) } : {}) })
      const blob = await scope.blob(`/api/business/history/export?${params}`, { signal: controller.signal })
      scope.assertCurrent(controller.signal)
      const address = URL.createObjectURL(blob), anchor = document.createElement('a')
      anchor.href = address; anchor.download = 'vehicle-history.xlsx'; anchor.click()
      setTimeout(() => URL.revokeObjectURL(address), 1000)
    } catch (cause) { if (!controller.signal.aborted) setExportError(cause instanceof Error ? cause.message : 'SERVER_ERROR') }
    finally { if (exportController.current === controller) { exportController.current = null; setExporting(false) } }
  }
  return <section className="history-panel" aria-label={text('history')}>
    <div className="history-toolbar">
      {!vehicleId && <Select className="history-vehicle-filter" aria-label={zh ? '车辆' : 'Vehicle'} placeholder={zh ? '全部车辆' : 'All vehicles'} allowClear showSearch optionFilterProp="label" value={selectedVehicle} options={vehicleOptions.map(option => ({ value: option.id, label: option.label }))} onChange={next => { setSelectedVehicle(next); setPage(1) }} />}

      <DatePicker value={day} aria-label={zh ? '操作日期' : 'Date'} placeholder={zh ? '操作日期' : 'Date'} format="YYYY-MM-DD" onChange={next => { setDay(next); setPage(1) }} />
      <Input.Search prefix={<Search size={15} />} value={draft} allowClear aria-label={zh ? '搜索历史' : 'Search history'} placeholder={zh ? '姓名、原因、字段或内容…' : 'Name, reason, field or content…'} aria-describedby={searchHelpId} onChange={event => { setDraft(event.target.value); if (!event.target.value) { setQuery(''); setPage(1) } }} onCompositionStart={() => setComposing(true)} onCompositionEnd={() => setComposing(false)} onSearch={() => { if (!composing) { setQuery(draft.trim()); setPage(1) } }} />
      <Popover trigger="click" title={zh ? '搜索提示' : 'Search tips'} content={<div className="history-help-content"><p>{searchHelp}</p><p>{zh ? '例如：Alex 软件' : 'Example: Alex software'}</p><p>{zh ? '已删除车辆的历史仍可通过车型或 VIN 关键词查找。' : 'Find deleted vehicle history using model or VIN keywords.'}</p></div>}><Button type="text" size="small" className="history-help-button" aria-label={zh ? '搜索帮助' : 'Search help'} icon={<CircleHelp size={17} />} /></Popover>
      {!vehicleId && <Tooltip title={zh ? '按当前车辆、日期和关键词导出全部匹配记录，不受分页限制' : 'Export all records matching the current vehicle, date and keywords, across all pages'}><span className="history-export"><Button icon={<Download size={15} />} disabled={!exportReady} loading={exporting} onClick={() => void exportHistory()}>{zh ? '导出筛选结果' : 'Export filtered results'}</Button></span></Tooltip>}
      {(selectedVehicle || day || draft) && <Button type="text" onClick={() => { setSelectedVehicle(undefined); setDay(null); setDraft(''); setQuery(''); setPage(1) }}>{zh ? '清空筛选' : 'Clear filters'}</Button>}
    </div>
    <span id={searchHelpId} className="history-accessible-help">{searchHelp}</span>
    {exportError && <Alert type="error" showIcon title={errorText(exportError, language)} />}
    {!vehicleId && optionsError && <Alert type="error" showIcon title={errorText(optionsError, language)} action={<Button onClick={() => setRetry(item => item + 1)}>{zh ? '重试' : 'Retry'}</Button>} />}
    <div className="history-results" aria-busy={loading}>
      {!visibleResult && loading ? <div className="history-loading" role="status"><Spin /><span>{zh ? '正在加载历史…' : 'Loading history…'}</span></div> : !visibleResult && error ? <Alert type="error" showIcon title={errorText(error, language)} action={<Button onClick={() => setRetry(item => item + 1)}>{zh ? '重试' : 'Retry'}</Button>} /> : visibleResult && <>
        {error && <Alert type="error" showIcon title={errorText(error, language)} action={<Button onClick={() => setRetry(item => item + 1)}>{zh ? '重试' : 'Retry'}</Button>} />}
        <div className="history-result-meta">
          <p role="status" className="history-result-count"><strong>{visibleResult.total.toLocaleString(zh ? 'zh-CN' : 'en-GB')}</strong> {zh ? '条记录' : 'entries'}{loading && <span className="muted"> · {zh ? '正在刷新…' : 'Refreshing…'}</span>}</p>
          <Popover trigger="click" title={zh ? '本地历史' : 'Local history'} content={<div className="history-help-content"><p>{zh ? '上次同步：' : 'Last synchronized: '}{visibleResult.sync.lastSync ? new Date(visibleResult.sync.lastSync).toLocaleString(zh ? 'zh-CN' : 'en-GB') : (zh ? '尚未同步' : 'Not synchronized yet')}</p><p>{zh ? '先显示本机记录，共享数据在后台同步。' : 'Showing local records while shared data synchronizes in the background.'}</p></div>}><Button type="text" size="small" className="history-sync-status" icon={<Clock3 size={13} />}>{visibleResult.sync.phase === 'offline' ? (zh ? '离线 · 本地记录' : 'Offline · Local records') : visibleResult.sync.error ? (zh ? '同步暂停 · 本地记录' : 'Sync paused · Local records') : (zh ? '本地记录' : 'Local records')}{visibleResult.sync.lastSync && <span>{' · '}{new Date(visibleResult.sync.lastSync).toLocaleTimeString(zh ? 'zh-CN' : 'en-GB', { hour: '2-digit', minute: '2-digit', hour12: false })}</span>}</Button></Popover>
        </div>
        {visibleResult.items.length ? visibleResult.items.map(change => <HistoryEntry key={change.id} change={change} language={language} reportIds={reportIds} onOpenReport={onOpenReport} />) : <Empty description={query || day || selectedVehicle ? (zh ? '没有匹配历史，请修改或清空搜索。' : 'No matching history. Change or clear your search.') : (zh ? '暂无历史记录' : 'No history yet')} />}
        <Pagination current={visibleResult.page} total={visibleResult.total} pageSize={50} showSizeChanger={false} hideOnSinglePage showTotal={(total, range) => zh ? `第 ${range[0]}–${range[1]} 条 · 共 ${total} 条 · 每页 50 条` : `${range[0]}–${range[1]} of ${total} · 50 per page`} onChange={setPage} />
      </>}
    </div>
  </section>
}
