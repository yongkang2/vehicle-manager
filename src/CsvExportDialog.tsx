import { useEffect, useEffectEvent, useRef, useState } from 'react'
import { Alert, App, Button, Checkbox, Input, Modal, Select, Space, Table, Tabs, Tag, Tooltip } from 'antd'
import { ArrowDown, ArrowUp, Download, RefreshCw } from 'lucide-react'
import { defaultExportConfiguration, exportColumns, exportFilterFields, exportKinds, MAX_EXPORT_VEHICLES, matchesExportVehicle, parseExportConfiguration, recordsForExport } from '../shared/csv-export'
import type { ExportConfiguration, ExportRecordKind, ExportTemplate } from '../shared/csv-export'
import type { BusinessRecord, SyncStatus } from '../shared/business'
import { api, ApiError, download } from './api'
import { translateBusiness } from './business-i18n'
import { errorText } from './i18n'
import type { Language } from './i18n'
import './CsvExportDialog.css'

type Props = {
  records: BusinessRecord[]; language: Language; online: boolean; syncPaused: boolean; syncStatus: SyncStatus
  onCancel: () => void; onError: (error: unknown) => void; onBusyChange: (busy: boolean) => void
  onRefresh: () => Promise<BusinessRecord[]>
}
type NameDialog = { mode: 'save' | 'rename' | 'delete'; name: string }
const valueText = (value: unknown) => value === null || value === undefined || value === '' ? '—' : String(value)

export default function CsvExportDialog({ records, language, online, syncPaused, syncStatus, onCancel, onError, onBusyChange, onRefresh }: Props) {
  const text = translateBusiness(language), { message } = App.useApp()
  const [configuration, setConfiguration] = useState(() => defaultExportConfiguration(language))
  const [selectedVehicleIds, setSelectedIds] = useState<string[] | null>(null)
  const [templates, setTemplates] = useState<ExportTemplate[]>([]), [templateId, setTemplateId] = useState<string | undefined>()
  const [templatesLoading, setTemplatesLoading] = useState(true), [templateBusy, setTemplateBusy] = useState(false)
  const [refreshing, setRefreshing] = useState(false), [downloading, setDownloading] = useState(false)
  const [nameDialog, setNameDialog] = useState<NameDialog | null>(null), [error, setError] = useState<string | null>(null)
  const [page, setPage] = useState(1)
  const [filename] = useState(() => `vehicle-data-${new Date().toISOString().slice(0, 10)}.zip`)
  const active = useRef(true), downloadController = useRef<AbortController | null>(null)
  const reportInitialError = useEffectEvent(onError)
  useEffect(() => {
    active.current = true
    let mounted = true
    void api<ExportTemplate[]>('/api/business/export-templates').then(value => { if (mounted) setTemplates(value) }).catch(cause => { if (mounted) reportInitialError(cause) }).finally(() => { if (mounted) setTemplatesLoading(false) })
    return () => { mounted = false; active.current = false; downloadController.current?.abort() }
  }, [])
  const matching = records.filter(record => matchesExportVehicle(record, configuration))
  const selectedIds = selectedVehicleIds ?? matching.map(record => record.id)
  const matchingIds = new Set(matching.map(record => record.id)), selected = new Set(selectedIds)
  const selectionChanged = selectedIds.some(id => !matchingIds.has(id))
  const configurationValid = Boolean(parseExportConfiguration(configuration))
  const enabledKinds = exportKinds.filter(kind => configuration.columns[kind] !== undefined)
  const overSelectionLimit = selectedIds.length > MAX_EXPORT_VEHICLES
  const ready = selectedIds.length > 0 && !overSelectionLimit && configurationValid && !selectionChanged
  const busy = templateBusy || downloading || refreshing
  const selectedTemplate = templates.find(template => template.id === templateId)
  const warning = !online || syncStatus.pending > 0 || syncStatus.conflicts.length > 0 || syncStatus.quarantined > 0 || Boolean(syncStatus.error)

  function fail(cause: unknown) {
    if (!active.current) return
    setError(cause instanceof ApiError ? cause.message : 'SERVER_ERROR'); onError(cause)
  }
  function applyConfiguration(next: ExportConfiguration) {
    setConfiguration(next); setPage(1); setSelectedIds(records.filter(record => matchesExportVehicle(record, next)).map(record => record.id)); setError(null)
  }
  function updateColumns(kind: ExportRecordKind, columns: string[] | undefined) {
    const next = { ...configuration.columns }
    if (columns === undefined) delete next[kind]
    else next[kind] = columns
    setConfiguration({ ...configuration, columns: next }); setError(null)
  }
  function moveColumn(kind: ExportRecordKind, index: number, offset: number) {
    const next = [...(configuration.columns[kind] || [])]
    const target = index + offset
    if (target < 0 || target >= next.length) return
    ;[next[index], next[target]] = [next[target], next[index]]
    updateColumns(kind, next)
  }
  async function refreshSelection() {
    setRefreshing(true); onBusyChange(true)
    try {
      const next = await onRefresh()
      if (active.current) { setSelectedIds(next.filter(record => matchesExportVehicle(record, configuration)).map(record => record.id)); setPage(1); setError(null) }
    } catch (cause) { fail(cause) } finally { if (active.current) setRefreshing(false); onBusyChange(false) }
  }
  async function applyTemplate(id: string | undefined) {
    if (!id) { setTemplateId(undefined); return }
    const template = templates.find(item => item.id === id)
    if (!template || busy) return
    setRefreshing(true); onBusyChange(true)
    try {
      const currentRecords = await onRefresh()
      if (active.current) { setTemplateId(id); setConfiguration(template.configuration); setSelectedIds(currentRecords.filter(record => matchesExportVehicle(record, template.configuration)).map(record => record.id)); setPage(1); setError(null) }
    } catch (cause) { fail(cause) } finally { if (active.current) setRefreshing(false); onBusyChange(false) }
  }
  async function saveTemplate() {
    if (!nameDialog || templateBusy || !nameDialog.name.trim() || (nameDialog.mode === 'save' && !configurationValid) || (nameDialog.mode !== 'save' && !templateId)) return
    setTemplateBusy(true); onBusyChange(true)
    try {
      if (nameDialog.mode === 'delete') {
        await api(`/api/business/export-templates/${encodeURIComponent(templateId!)}`, { method: 'DELETE' })
        if (active.current) { setTemplates(current => current.filter(template => template.id !== templateId)); setTemplateId(undefined) }
      } else {
        const saved = await api<ExportTemplate>(nameDialog.mode === 'save' ? '/api/business/export-templates' : `/api/business/export-templates/${encodeURIComponent(templateId!)}`, { method: nameDialog.mode === 'save' ? 'POST' : 'PUT', body: nameDialog.mode === 'save' ? { name: nameDialog.name.trim(), configuration } : { name: nameDialog.name.trim() } })
        if (active.current) { setTemplates(current => [...current.filter(template => template.id !== saved.id), saved]); setTemplateId(saved.id) }
      }
      if (active.current) { setNameDialog(null); setError(null); void message.success(text('csvTemplateSaved')) }
    } catch (cause) { fail(cause) } finally { if (active.current) setTemplateBusy(false); onBusyChange(false) }
  }
  async function updateTemplate() {
    if (!templateId || !configurationValid) return
    setTemplateBusy(true); onBusyChange(true)
    try {
      const saved = await api<ExportTemplate>(`/api/business/export-templates/${encodeURIComponent(templateId)}`, { method: 'PUT', body: { configuration } })
      if (active.current) { setTemplates(current => current.map(template => template.id === saved.id ? saved : template)); setError(null); void message.success(text('csvTemplateSaved')) }
    } catch (cause) { fail(cause) } finally { if (active.current) setTemplateBusy(false); onBusyChange(false) }
  }
  async function exportCsv() {
    if (!ready || busy) return
    const controller = new AbortController(); downloadController.current = controller
    setDownloading(true); setError(null); onBusyChange(true)
    try {
      await download('/api/business/export/csv', filename, { method: 'POST', body: { vehicleIds: selectedIds, configuration }, signal: controller.signal })
      if (active.current && !controller.signal.aborted) void message.success(text('csvDownloaded'))
    } catch (cause) { if (!controller.signal.aborted) fail(cause) }
    finally { downloadController.current = null; if (active.current) setDownloading(false); onBusyChange(false) }
  }
  function cancel() { if (templateBusy || refreshing) return; downloadController.current?.abort(); onCancel() }
  return <>
    <Modal open title={text('exportCsv')} width={1120} className="csv-export-modal" onCancel={cancel} footer={<Space><Button onClick={cancel} disabled={templateBusy || refreshing}>{text(downloading ? 'csvCancelDownload' : 'cancel')}</Button><Button type="primary" icon={<Download size={16} />} loading={downloading} disabled={!ready || templateBusy || refreshing} onClick={() => void exportCsv()}>{text('csvDownloadZip')}</Button></Space>} destroyOnHidden>
      <div className="csv-export-content">
        <Alert type="info" showIcon title={text('csvFormatNotice')} description={text('csvExcelNotice')} />
        {warning && <Alert type="warning" showIcon title={text('csvLocalWarning')} description={`${text('pending')}: ${syncStatus.pending} · ${text('conflicts')}: ${syncStatus.conflicts.length} · ${text('quarantined')}: ${syncStatus.quarantined}`} />}
        {syncPaused && <Alert type="info" showIcon title={text('csvPausedNotice')} />}
        {(error || selectionChanged) && <Alert type="warning" showIcon title={errorText(error || 'EXPORT_SELECTION_CHANGED', language)} />}
        <section className="csv-export-section" aria-labelledby="csv-templates-heading">
          <h3 id="csv-templates-heading">{text('csvTemplates')}</h3>
          <Space wrap className="csv-template-toolbar">
            <Select className="csv-template-select" aria-label={text('csvTemplates')} placeholder={text('csvChooseTemplate')} allowClear loading={templatesLoading || refreshing} disabled={busy} value={templateId} options={[...templates].sort((left, right) => left.name.localeCompare(right.name)).map(template => ({ value: template.id, label: template.name }))} onChange={id => void applyTemplate(id)} />
            {selectedTemplate ? <Button disabled={busy || !configurationValid} loading={templateBusy} onClick={() => void updateTemplate()}>{text('csvUpdateTemplate')}</Button> : <Button disabled={busy || !configurationValid || templatesLoading} onClick={() => setNameDialog({ mode: 'save', name: '' })}>{text('save')}</Button>}
            <Button disabled={busy || !configurationValid || templatesLoading} onClick={() => setNameDialog({ mode: 'save', name: selectedTemplate ? `${selectedTemplate.name} ${text('csvCopy')}`.slice(0, 100) : '' })}>{text('csvSaveAs')}</Button>
            <Button disabled={busy || !selectedTemplate} onClick={() => setNameDialog({ mode: 'rename', name: selectedTemplate!.name })}>{text('csvRename')}</Button>
            <Button danger disabled={busy || !selectedTemplate} onClick={() => setNameDialog({ mode: 'delete', name: selectedTemplate!.name })}>{text('delete')}</Button>
          </Space>
          <p className="muted">{text('csvTemplateNotice')}</p>
        </section>
        <section className="csv-export-section" aria-labelledby="csv-vehicles-heading">
          <h3 id="csv-vehicles-heading">{text('csvChooseVehicles')}</h3>
          <fieldset className="csv-filter-grid" disabled={busy}>
            <label className="csv-search-filter">{text('search')}<Input value={configuration.filters.search} placeholder={text('csvSearchVehicles')} allowClear disabled={busy} onChange={event => applyConfiguration({ ...configuration, filters: { ...configuration.filters, search: event.target.value } })} /></label>
            {exportFilterFields.map(field => {
              const values = [...new Set([...records.filter(record => record.kind === 'vehicle').map(record => String(record.data[field] ?? '')), ...configuration.filters[field]])].sort((left, right) => left.localeCompare(right))
              return <label key={field}>{text(field)}<Select mode="multiple" aria-label={text(field)} placeholder={text('all')} allowClear disabled={busy} value={configuration.filters[field]} options={values.map(value => ({ value, label: value === '' ? text('csvBlankValue') : ['status', 'thermal'].includes(field) ? text(value) : value }))} onChange={value => applyConfiguration({ ...configuration, filters: { ...configuration.filters, [field]: value } })} /></label>
            })}
          </fieldset>
          <div className="csv-selection-toolbar"><Space wrap><Checkbox checked={configuration.includeArchived} disabled={busy} onChange={event => applyConfiguration({ ...configuration, includeArchived: event.target.checked })}>{text('showArchived')}</Checkbox><Button size="small" disabled={busy || !matching.length} onClick={() => setSelectedIds(matching.map(record => record.id))}>{text('csvSelectMatching')}</Button><Button size="small" disabled={busy || !selectedIds.length} onClick={() => setSelectedIds([])}>{text('csvClearSelection')}</Button></Space><Button size="small" icon={<RefreshCw size={14} />} disabled={busy} loading={refreshing} onClick={() => void refreshSelection()}>{text('csvRefreshSelection')}</Button></div>
          <p className="muted">{text('csvFiltersNotice')} · {text('csvSelectedVehicles')}: <strong>{selectedIds.length}</strong> / {matching.length}</p>
          <Table<BusinessRecord> rowKey="id" size="small" dataSource={matching} scroll={{ x: 840 }} pagination={{ current: page, pageSize: 8, hideOnSinglePage: true, onChange: setPage, showSizeChanger: false }} rowSelection={{ selectedRowKeys: selectedIds, preserveSelectedRowKeys: true, onChange: keys => setSelectedIds(keys.map(String)), getCheckboxProps: () => ({ disabled: busy }) }} columns={[
            { title: text('nickName'), width: 160, ellipsis: true, render: (_, record) => valueText(record.data.name) },
            { title: 'VIN', width: 180, render: (_, record) => <span className="mono">{valueText(record.data.vin)}</span> },
            { title: text('project'), width: 100, ellipsis: true, render: (_, record) => valueText(record.data.project) },
            { title: text('model'), width: 100, ellipsis: true, render: (_, record) => valueText(record.data.model) },
            { title: text('status'), width: 110, render: (_, record) => record.archived ? <Tag>{text('archived')}</Tag> : text(String(record.data.status || '—')) },
            { title: text('physicalLocation'), width: 170, ellipsis: true, render: (_, record) => valueText(record.data.physicalLocation) },
          ]} />
        </section>
        <section className="csv-export-section" aria-labelledby="csv-columns-heading">
          <div className="csv-selection-toolbar"><h3 id="csv-columns-heading">{text('csvCategoriesColumns')}</h3><label className="csv-language">{text('csvHeaderLanguage')}<Select aria-label={text('csvHeaderLanguage')} disabled={busy} value={configuration.language} options={[{ value: 'en', label: 'English' }, { value: 'zh', label: '中文' }]} onChange={value => setConfiguration({ ...configuration, language: value })} /></label></div>
          <div className="csv-category-choices">{exportKinds.map(kind => <Checkbox key={kind} disabled={busy} checked={configuration.columns[kind] !== undefined} onChange={event => updateColumns(kind, event.target.checked ? exportColumns[kind].map(column => column.id) : undefined)}>{text(`csvKind_${kind}`)} <Tag>{recordsForExport(records, kind, selected, configuration.includeArchived).length}</Tag></Checkbox>)}</div>
          <p className="muted">{text('csvColumnsNotice')}</p>
          <Tabs items={enabledKinds.map(kind => {
            const columns = configuration.columns[kind] || []
            return { key: kind, label: `${text(`csvKind_${kind}`)} (${columns.length})`, children: <div className="csv-column-editor">
              <div><div className="csv-column-tools"><Button size="small" disabled={busy} onClick={() => updateColumns(kind, exportColumns[kind].map(column => column.id))}>{text('csvSelectAllColumns')}</Button><Button size="small" disabled={busy} onClick={() => updateColumns(kind, [])}>{text('csvClearSelection')}</Button></div><div className="csv-column-checkboxes">{exportColumns[kind].map(column => <Checkbox key={column.id} checked={columns.includes(column.id)} disabled={busy} onChange={event => updateColumns(kind, event.target.checked ? [...columns, column.id] : columns.filter(id => id !== column.id))}>{column.label[language === 'zh' ? 1 : 0]}</Checkbox>)}</div></div>
              <div><h4>{text('csvColumnOrder')}</h4>{columns.length ? <ol className="csv-column-order">{columns.map((id, index) => <li key={id}><span>{exportColumns[kind].find(column => column.id === id)?.label[language === 'zh' ? 1 : 0] || id}</span><Space size={2}><Tooltip title={text('csvMoveUp')}><Button size="small" aria-label={`${text('csvMoveUp')} ${exportColumns[kind].find(column => column.id === id)?.label[language === 'zh' ? 1 : 0] || id}`} icon={<ArrowUp size={13} />} disabled={busy || index === 0} onClick={() => moveColumn(kind, index, -1)} /></Tooltip><Tooltip title={text('csvMoveDown')}><Button size="small" aria-label={`${text('csvMoveDown')} ${exportColumns[kind].find(column => column.id === id)?.label[language === 'zh' ? 1 : 0] || id}`} icon={<ArrowDown size={13} />} disabled={busy || index === columns.length - 1} onClick={() => moveColumn(kind, index, 1)} /></Tooltip></Space></li>)}</ol> : <Alert type="warning" title={text('csvRequiredColumns')} />}</div>
            </div> }
          })} />
          {!ready && <p className="csv-validation" role="status">{text(overSelectionLimit ? 'csvVehicleLimit' : 'csvRequiredSelection')}</p>}
        </section>
      </div>
    </Modal>
    <Modal open={Boolean(nameDialog)} title={text(nameDialog?.mode === 'delete' ? 'csvDeleteTemplate' : nameDialog?.mode === 'rename' ? 'csvRename' : 'csvSaveTemplate')} width={460} onCancel={() => { if (!templateBusy) setNameDialog(null) }} onOk={() => void saveTemplate()} confirmLoading={templateBusy} okText={text(nameDialog?.mode === 'delete' ? 'delete' : 'save')} cancelText={text('cancel')} okButtonProps={{ disabled: !nameDialog?.name.trim(), danger: nameDialog?.mode === 'delete' }} destroyOnHidden>{nameDialog?.mode === 'delete' ? <p>{text('csvDeleteTemplateNotice')} <strong>{nameDialog.name}</strong></p> : <label className="standalone-label">{text('csvTemplateName')}<Input autoFocus maxLength={100} value={nameDialog?.name || ''} disabled={templateBusy} onChange={event => setNameDialog(current => current && { ...current, name: event.target.value })} onPressEnter={() => void saveTemplate()} /></label>}</Modal>
  </>
}
