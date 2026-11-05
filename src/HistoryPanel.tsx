import { useEffect, useId, useRef, useState } from 'react'
import { Alert, Button, Empty, Input, Pagination, Spin, Select, DatePicker, Tooltip } from 'antd'
import type { DatePickerProps } from 'antd'
import { Download, Search } from 'lucide-react'
import { createWorkspaceScope } from './api'
import { errorText, type Language } from './i18n'
import { translateBusiness } from './business-i18n'
import type { Change } from '../shared/business'
import { historyChangedFields } from './history-presentation'
import './HistoryPanel.css'

type HistoryItem = Change & { vehicleLabel: string }
type HistoryResult = { items: HistoryItem[]; vehicleOptions: { id: string; label: string }[]; total: number; page: number; pageSize: number }
const value = (item: unknown, missing: string): string => item === undefined ? missing : typeof item === 'string' ? item || '—' : JSON.stringify(item) ?? missing

function HistoryEntry({ change, language, reportIds, onOpenReport }: { change: HistoryItem; language: Language; reportIds?: string[]; onOpenReport?: (id: string) => void }) {
  const text = translateBusiness(language), zh = language === 'zh'
  const missing = zh ? '（无此字段）' : '(not present)'
  const fields = historyChangedFields(change)
  const statusChanged = change.archivedBefore !== null && change.archivedBefore !== change.archivedAfter
  const name = String(change.after.name || change.before?.name || '').trim()
  const category = change.after.category || change.before?.category
  const kind = change.kind === 'part' ? category === 'battery' ? text('hvBattery') : category === 'controller' || /^(VCU|MCU|BMS|MSB|BMS\/MSB)$/i.test(name) ? text('part') : zh ? '部件' : 'component' : text(change.kind)
  const vehicleLabel = change.vehicleLabel && change.vehicleLabel !== change.vehicleId ? change.vehicleLabel : zh ? '未知车辆' : 'Unknown vehicle'
  const object = change.kind === 'vehicle' ? vehicleLabel : zh ? `${vehicleLabel} 的 ${name ? `${name} ` : ''}${kind}` : `${vehicleLabel} · ${name ? `${name} ` : ''}${kind}`
  const diff = (key: string) => <div className="history-field" key={key}><strong>{text(key)}</strong><del>{value(change.before?.[key], missing)}</del><span aria-label={zh ? '变为' : 'changed to'}>→</span><ins>{value(change.after[key], missing)}</ins></div>
  return <article className="history-entry">
    <header><p className="history-summary"><strong>{change.actor.name}</strong><span className="history-action">{text(change.action === 'updated' ? 'updatedAction' : change.action)}</span><span className="history-object">{object}</span></p><time dateTime={change.created}>{new Date(change.created).toLocaleString(zh ? 'zh-CN' : 'en-GB')}</time></header>
    <p className="history-reason"><span>{text('reason')}{zh ? '： ' : ': '}</span>{change.reason || '—'}</p>
    <details><summary>{zh ? `查看变更（${fields.length + Number(statusChanged)}）` : `View changes (${fields.length + Number(statusChanged)})`}</summary>
      <div className="history-detail-body">
      {(fields.length > 0 || statusChanged) && <div className="history-diff-heading" aria-hidden="true"><span>{zh ? '字段' : 'Field'}</span><span>{zh ? '变更前' : 'Before'}</span><span /><span>{zh ? '变更后' : 'After'}</span></div>}
      <div className="history-diffs">{fields.map(diff)}
        {statusChanged && <div className="history-field"><strong>{text('status')}</strong><del>{text(change.archivedBefore ? 'archived' : 'available')}</del><span>→</span><ins>{text(change.archivedAfter ? 'archived' : 'available')}</ins></div>}
        {!fields.length && !statusChanged && <p className="muted">{zh ? '没有字段值变更' : 'No field value changes'}</p>}
      </div>
      {change.sourceId && (reportIds?.includes(change.sourceId) && onOpenReport ? <Button type="link" onClick={() => onOpenReport(change.sourceId!)}>{text('source')}</Button> : <p className="muted">{text('sourceUnavailable')}</p>)}
      <p className="history-actor-id">{zh ? '操作人 ID' : 'Actor ID'}: {change.actor.id}</p>
      </div>
    </details>
  </article>
}

export default function HistoryPanel({ language, vehicleId, refreshToken, reportIds, onOpenReport }: { language: Language; vehicleId?: string; refreshToken?: unknown; reportIds?: string[]; onOpenReport?: (id: string) => void }) {
  const zh = language === 'zh', text = translateBusiness(language)
  const searchHelpId = useId()
  const [selectedVehicle, setSelectedVehicle] = useState<string | undefined>(), [day, setDay] = useState<Exclude<DatePickerProps['value'], unknown[]>>(null)
  const activeVehicle = vehicleId || selectedVehicle
  const date = day?.format('YYYY-MM-DD') || ''
  const offset = day ? day.toDate().getTimezoneOffset() : 0
  const endOffset = day ? day.add(1, 'day').toDate().getTimezoneOffset() : 0
  const [vehicleOptions, setVehicleOptions] = useState<{ id: string; label: string }[]>([])
  const [draft, setDraft] = useState(''), [query, setQuery] = useState(''), [page, setPage] = useState(1), [composing, setComposing] = useState(false)
  const filterKey = JSON.stringify([activeVehicle || '', date, offset, endOffset, query])
  const [result, setResult] = useState<(HistoryResult & { filterKey: string }) | null>(null), [loading, setLoading] = useState(true), [error, setError] = useState(''), [retry, setRetry] = useState(0)
  const [exporting, setExporting] = useState(false), [exportError, setExportError] = useState('')
  const exportController = useRef<AbortController | null>(null)
  useEffect(() => { if (composing) return; const timer = setTimeout(() => { setQuery(draft.trim()); setPage(1) }, draft ? 300 : 0); return () => clearTimeout(timer) }, [draft, composing])
  useEffect(() => {
    const controller = new AbortController(), scope = createWorkspaceScope()
    void Promise.resolve().then(async () => {
      if (controller.signal.aborted) return
      setLoading(true); setResult(null); setError('')
      try {
        const params = new URLSearchParams({ q: query, page: String(page), ...(activeVehicle ? { vehicleId: activeVehicle } : {}), ...(date ? { date, offset: String(offset), endOffset: String(endOffset) } : {}) })
        const next = await scope.request<HistoryResult>(`/api/business/history/query?${params}`, { signal: controller.signal })
        scope.assertCurrent(controller.signal)
        if (next.page !== page) { setPage(next.page); return }
        setResult({ ...next, filterKey }); setVehicleOptions(next.vehicleOptions)
      } catch (cause) { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : 'SERVER_ERROR') }
      finally { if (!controller.signal.aborted) setLoading(false) }
    })
    return () => controller.abort()
  }, [activeVehicle, date, offset, endOffset, query, page, retry, refreshToken, filterKey])
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
      {!vehicleId && <Tooltip title={zh ? '按当前车辆、日期和关键词导出全部匹配记录，不受分页限制' : 'Export all records matching the current vehicle, date and keywords, across all pages'}><span className="history-export"><Button icon={<Download size={15} />} disabled={!exportReady} loading={exporting} onClick={() => void exportHistory()}>{zh ? '导出筛选结果' : 'Export filtered results'}</Button></span></Tooltip>}
      {(selectedVehicle || day || draft) && <Button type="text" onClick={() => { setSelectedVehicle(undefined); setDay(null); setDraft(''); setQuery(''); setPage(1) }}>{zh ? '清空筛选' : 'Clear filters'}</Button>}
    </div>
    <p id={searchHelpId} className="history-search-help">{zh ? '搜索操作人、原因、字段名或内容；多个关键词用空格分隔，同时匹配。例如：Alex 软件' : 'Search actors, reasons, field names or content. Separate keywords with spaces to match all. Example: Alex software'}</p>
    {exportError && <Alert type="error" showIcon title={errorText(exportError, language)} />}
    <div className="history-results" aria-busy={loading}>
      {loading ? <div className="history-loading" role="status"><Spin /><span>{zh ? '正在加载历史…' : 'Loading history…'}</span></div> : error ? <Alert type="error" showIcon title={errorText(error, language)} action={<Button onClick={() => setRetry(item => item + 1)}>{zh ? '重试' : 'Retry'}</Button>} /> : result && <>
        <p className="muted" role="status">{zh ? `共 ${result.total} 条记录 · 每页 50 条` : `${result.total.toLocaleString('en-GB')} entries · 50 per page`}</p>
        {result.items.length ? result.items.map(change => <HistoryEntry key={change.id} change={change} language={language} reportIds={reportIds} onOpenReport={onOpenReport} />) : <Empty description={query || day || selectedVehicle ? (zh ? '没有匹配历史，请修改或清空搜索。' : 'No matching history. Change or clear your search.') : (zh ? '暂无历史记录' : 'No history yet')} />}
        <Pagination current={result.page} total={result.total} pageSize={50} showSizeChanger={false} hideOnSinglePage onChange={setPage} />
      </>}
    </div>
  </section>
}
