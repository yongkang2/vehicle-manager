import { lazy, Suspense, useEffect, useState } from 'react'
import { Alert, Button, Checkbox, Descriptions, Empty, Modal, Select, Space, Spin, Table, Tabs, Tag, Upload } from 'antd'
import type { UploadProps } from 'antd'
import type { RcFile } from 'antd/es/upload/interface'
import { Check, FileSpreadsheet, RefreshCw, Trash2, Upload as UploadIcon } from 'lucide-react'
import { controllerFields, controllerSources, doveRecordedTime, keyControllerName, keyControllerNames, validControllerValue, DOVE_BATCH_LIMIT, DOVE_MAX_FILE_BYTES } from '../shared/business'
import type { DoveBatchPreviewResult, DoveBatchSaveResult, DoveImportConfirmation, DovePreview } from '../shared/business'
import { api } from './api'
import { translateBusiness } from './business-i18n'
import { errorText } from './i18n'
import type { Language } from './i18n'

const ReportViewer = lazy(() => import('./ReportViewer'))
type ImportRow = { uid: string; file: RcFile; preview?: DovePreview; error?: string; savedId?: string }
type ImportChoice = { reportOnly: boolean; allowOlder: boolean; selections: DoveImportConfirmation['selections'] }
type Props = {
  active: boolean
  language: Language
  disabled: boolean
  onBusyChange: (busy: boolean) => void
  onRetained: () => Promise<void>
  onOpenReport: (id: string) => Promise<void>
  onError: (error: unknown) => void
}
const fileError = (file: File) => !/\.xlsx$/i.test(file.name) ? 'XLSX_REQUIRED' : file.size > DOVE_MAX_FILE_BYTES ? 'FILE_TOO_LARGE' : undefined
const canRetain = (row: ImportRow, time: number) => Boolean(row.preview?.match === 'matched' && !row.savedId && !row.error && row.preview.expires > time)
const errorCode = (error: unknown) => error instanceof Error ? error.message : 'SERVER_ERROR'

export default function DoveImport({ active, language, disabled, onBusyChange, onRetained, onOpenReport, onError }: Props) {
  const text = translateBusiness(language)
  const [rows, setRows] = useState<ImportRow[]>([])
  const [operation, setOperation] = useState<'parse' | 'save' | null>(null)
  const [activeIds, setActiveIds] = useState<string[]>([])
  const [previewId, setPreviewId] = useState<string | null>(null)
  const [confirmationRows, setConfirmationRows] = useState<ImportRow[]>([])
  const [choices, setChoices] = useState<Record<string, ImportChoice>>({})
  const [selectionLimited, setSelectionLimited] = useState(false)
  const [clock, setClock] = useState(Date.now)
  useEffect(() => { const timer = setInterval(() => setClock(Date.now()), 30000); return () => clearInterval(timer) }, [])
  const locked = disabled || operation !== null
  const pending = rows.filter(row => !row.savedId && !row.preview && !fileError(row.file))
  const eligible = rows.filter(row => canRetain(row, clock))
  const viewed = rows.find(row => row.uid === previewId)
  function reviewImport(candidates: ImportRow[]) {
    const targets = candidates.filter(row => canRetain(row, Date.now()))
    setChoices(Object.fromEntries(targets.map(row => {
      const sources = controllerSources(row.preview!.parsed.controllers)
      const selections = Object.fromEntries(keyControllerNames.flatMap(name => { const matches = sources.filter(item => keyControllerName(item.controller.name) === name); return matches.length === 1 ? [[name, matches[0].index]] : [] }))
      return [row.uid, { reportOnly: false, allowOlder: false, selections }]
    })))
    setConfirmationRows(targets)
  }
  const needsOlderConfirmation = (row: ImportRow) => row.preview!.currentControllers.some(part => doveRecordedTime(row.preview!.parsed.recordedAt) < doveRecordedTime(part.data.reportRecordedAt) && controllerSources(row.preview!.parsed.controllers).some(item => keyControllerName(item.controller.name) === keyControllerName(part.data.name)))
  const duplicateControllers = (row: ImportRow) => keyControllerNames.some(name => row.preview!.currentControllers.filter(part => keyControllerName(part.data.name) === name).length > 1)
  const confirmationBlocked = confirmationRows.some(row => {
    const choice = choices[row.uid]
    if (!choice || row.preview!.expires <= clock) return true
    if (choice.reportOnly) return false
    const sources = controllerSources(row.preview!.parsed.controllers)
    return duplicateControllers(row) || (needsOlderConfirmation(row) && !choice.allowOlder) || keyControllerNames.some(name => sources.some(item => keyControllerName(item.controller.name) === name) && !sources.some(item => keyControllerName(item.controller.name) === name && item.index === choice.selections?.[name]))
  })
  const beforeUpload: UploadProps['beforeUpload'] = (file, selection) => {
    if (locked) return Upload.LIST_IGNORE
    setSelectionLimited(rows.length + selection.length > DOVE_BATCH_LIMIT)
    setRows(current => current.length >= DOVE_BATCH_LIMIT || current.some(row => row.uid === file.uid) ? current : [...current, { uid: file.uid, file, error: fileError(file) }])
    return Upload.LIST_IGNORE
  }
  async function parse(targets: ImportRow[]) {
    if (locked || !targets.length) return
    const ids = new Set(targets.map(row => row.uid))
    const form = new FormData()
    for (const row of targets) form.append('files', row.file)
    setOperation('parse'); setActiveIds([...ids]); onBusyChange(true)
    setRows(current => current.map(row => ids.has(row.uid) ? { ...row, preview: undefined, error: undefined } : row))
    try {
      const results = await api<DoveBatchPreviewResult[]>('/api/business/dove/preview-batch', { method: 'POST', body: form })
      const byId = new Map(results.map(result => [targets[result.index].uid, result]))
      setRows(current => current.map(row => {
        const result = byId.get(row.uid)
        return result ? { ...row, preview: result.preview, error: result.error } : row
      }))
      reviewImport(targets.map(row => { const result = byId.get(row.uid); return { ...row, preview: result?.preview, error: result?.error } }))
    } catch (error) {
      setRows(current => current.map(row => ids.has(row.uid) ? { ...row, error: errorCode(error) } : row))
      onError(error)
    } finally { setClock(Date.now()); setOperation(null); setActiveIds([]); onBusyChange(false) }
  }
  async function retain(candidates: ImportRow[]) {
    if (locked) return
    const targets = candidates.filter(row => canRetain(row, Date.now()))
    if (!targets.length) { setClock(Date.now()); return }
    setOperation('save'); setActiveIds(targets.map(row => row.uid)); onBusyChange(true)
    try {
      const confirmations = Object.fromEntries(targets.map(row => [row.preview!.id, { confirmed: true, ...choices[row.uid] }]))
      const results = await api<DoveBatchSaveResult[]>('/api/business/dove/save-batch', { method: 'POST', body: { draftIds: targets.map(row => row.preview!.id), confirmations } })
      const byDraft = new Map(results.map(result => [result.draftId, result]))
      const retained = new Map<string, string>()
      for (const row of targets) {
        const record = byDraft.get(row.preview!.id)?.record
        if (record) retained.set(row.preview!.checksum, record.id)
      }
      setRows(current => current.map(row => {
        const result = row.preview ? byDraft.get(row.preview.id) : undefined
        if (result?.record) return { ...row, savedId: result.record.id, error: undefined }
        const existingId = row.preview && retained.get(row.preview.checksum)
        if (existingId && row.preview) return { ...row, preview: { ...row.preview, existingId }, error: undefined }
        if (result?.error) return { ...row, error: result.error, preview: result.error === 'DRAFT_EXPIRED' ? undefined : row.preview }
        return row
      }))
      if (retained.size) await onRetained()
      setConfirmationRows([])
    } catch (error) {
      const ids = new Set(targets.map(row => row.uid))
      setRows(current => current.map(row => ids.has(row.uid) ? { ...row, error: errorCode(error) } : row))
      onError(error)
    } finally { setClock(Date.now()); setOperation(null); setActiveIds([]); onBusyChange(false) }
  }
  const status = (row: ImportRow) => {
    if (activeIds.includes(row.uid)) return <Space><Spin size="small" /><span>{text(operation === 'parse' ? 'parsing' : 'retaining')}</span></Space>
    if (row.error) return <div className="dove-batch-result"><Tag color="error">{text('failed')}</Tag><span className="dove-batch-error">{errorText(row.error, language)}</span></div>
    if (row.savedId) return <Tag color="success">{text('retained')}</Tag>
    if (row.preview?.existingId) return <Tag color="success">{text('existingReport')}</Tag>
    if (row.preview && row.preview.expires <= clock) return <div className="dove-batch-result"><Tag color="warning">{text('previewExpired')}</Tag><span className="dove-batch-error">{errorText('DRAFT_EXPIRED', language)}</span></div>
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
      <Button type="text" disabled={locked || !rows.length} onClick={() => { setRows([]); setPreviewId(null); setSelectionLimited(false) }}>{text('clearBatch')}</Button>
      <span className="muted">{text('batchLimits')}</span>
    </div>
    {selectionLimited && <Alert className="business-notice" type="warning" showIcon title={text('batchSelectionLimit')} />}
    {rows.length ? <><p className="dove-batch-count">{text('selectedFiles')}: {rows.length} / {DOVE_BATCH_LIMIT}</p><Table<ImportRow> className="dove-batch-table" rowKey="uid" dataSource={rows} size="small" pagination={false} scroll={{ x: 1000 }} columns={[
      { title: text('file'), width: 240, render: (_, row) => <div className="record-title"><button className="inline-link" disabled={!row.preview} onClick={() => setPreviewId(row.uid)}>{row.file.name}</button><small>{(row.file.size / 1024 / 1024).toFixed(2)} MB</small></div> },
      { title: 'VIN', width: 180, render: (_, row) => <span className="mono">{row.preview?.parsed.vin || '—'}</span> },
      { title: text('vehicle'), width: 150, render: (_, row) => String(row.preview?.vehicle?.data.name || row.preview?.vehicle?.data.vin || '—') },
      { title: text('status'), width: 250, render: (_, row) => status(row) },
      { title: text('actions'), width: 250, render: (_, row) => {
        const reportId = row.savedId || row.preview?.existingId
        const retry = !row.savedId && !row.preview?.existingId && !fileError(row.file) && (!row.preview || row.error || row.preview.match !== 'matched' || row.preview.expires <= clock)
        return <Space wrap size={4}>
          {row.preview && <Button size="small" disabled={locked} onClick={() => setPreviewId(row.uid)}>{text('previewReport')}</Button>}
          {canRetain(row, clock) && <Button size="small" disabled={locked} onClick={() => reviewImport([row])}>{text('reviewDoveImport')}</Button>}
          {reportId && <Button size="small" disabled={locked} onClick={() => { void onOpenReport(reportId).catch(onError) }}>{text('openReport')}</Button>}
          {retry && <Button size="small" disabled={locked} icon={<RefreshCw size={13} />} onClick={() => void parse([row])}>{text(row.error || row.preview ? 'retryUpload' : 'upload')}</Button>}
          <Button size="small" type="text" disabled={locked} icon={<Trash2 size={14} />} aria-label={`${text('removeFile')} ${row.file.name}`} onClick={() => { setRows(current => current.filter(item => item.uid !== row.uid)); if (previewId === row.uid) setPreviewId(null) }} />
        </Space>
      } },
    ]} /></> : <Empty description={text('draft')} />}
    <Modal open={active && confirmationRows.length > 0} title={text('confirmDoveImport')} width={1050} onCancel={() => { if (!locked) setConfirmationRows([]) }} onOk={() => void retain(confirmationRows)} confirmLoading={operation === 'save'} okText={text('confirmDoveImport')} cancelText={text('cancel')} okButtonProps={{ disabled: locked || confirmationBlocked }} cancelButtonProps={{ disabled: locked }} destroyOnHidden>
      <div className="dove-import-confirmation">{confirmationRows.map(row => {
        const preview = row.preview!, choice = choices[row.uid]
        const sources = controllerSources(preview.parsed.controllers)
        if (!choice) return null
        const unresolved = keyControllerNames.filter(name => sources.filter(item => keyControllerName(item.controller.name) === name).length > 1 && choice.selections?.[name] === undefined)
        const updateChoice = (update: Partial<ImportChoice>) => setChoices(current => ({ ...current, [row.uid]: { ...current[row.uid], ...update } }))
        return <section className="dove-import-confirm-file" key={row.uid}>
          <h3>{row.file.name}</h3>
          <Descriptions size="small" column={{ xs: 1, sm: 2 }} items={[{ key: 'vehicle', label: text('vehicle'), children: String(preview.vehicle?.data.name || '—') }, { key: 'vin', label: 'VIN', children: <span className="mono">{preview.parsed.vin}</span> }, { key: 'date', label: text('recordedAt'), children: preview.parsed.recordedAt || '—' }]} />
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
      {viewed?.preview && <Suspense fallback={<Spin />}><ReportViewer key={viewed.preview.id} report={viewed.preview.parsed} language={language} /></Suspense>}
    </Modal>
  </div>
}
