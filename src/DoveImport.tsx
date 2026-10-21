import { lazy, Suspense, useEffect, useState } from 'react'
import { Alert, Button, Empty, Modal, Space, Spin, Table, Tag, Upload } from 'antd'
import type { UploadProps } from 'antd'
import type { RcFile } from 'antd/es/upload/interface'
import { Check, FileSpreadsheet, RefreshCw, Trash2, Upload as UploadIcon } from 'lucide-react'
import { DOVE_BATCH_LIMIT, DOVE_MAX_FILE_BYTES } from '../shared/business'
import type { DoveBatchPreviewResult, DoveBatchSaveResult, DovePreview } from '../shared/business'
import { api } from './api'
import { translateBusiness } from './business-i18n'
import { errorText } from './i18n'
import type { Language } from './i18n'

const ReportViewer = lazy(() => import('./ReportViewer'))
type ImportRow = { uid: string; file: RcFile; preview?: DovePreview; error?: string; savedId?: string }
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
const canRetain = (row: ImportRow, time: number) => Boolean(row.preview?.match === 'matched' && !row.preview.existingId && !row.savedId && !row.error && row.preview.expires > time)
const errorCode = (error: unknown) => error instanceof Error ? error.message : 'SERVER_ERROR'

export default function DoveImport({ active, language, disabled, onBusyChange, onRetained, onOpenReport, onError }: Props) {
  const text = translateBusiness(language)
  const [rows, setRows] = useState<ImportRow[]>([])
  const [operation, setOperation] = useState<'parse' | 'save' | null>(null)
  const [activeIds, setActiveIds] = useState<string[]>([])
  const [previewId, setPreviewId] = useState<string | null>(null)
  const [selectionLimited, setSelectionLimited] = useState(false)
  const [clock, setClock] = useState(Date.now)
  useEffect(() => { const timer = setInterval(() => setClock(Date.now()), 30000); return () => clearInterval(timer) }, [])
  const locked = disabled || operation !== null
  const pending = rows.filter(row => !row.savedId && !row.preview && !fileError(row.file))
  const eligible = rows.filter(row => canRetain(row, clock))
  const viewed = rows.find(row => row.uid === previewId)
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
      const results = await api<DoveBatchSaveResult[]>('/api/business/dove/save-batch', { method: 'POST', body: { draftIds: targets.map(row => row.preview!.id) } })
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
      <Button icon={<Check size={16} />} loading={operation === 'save'} disabled={locked || !eligible.length} onClick={() => void retain(eligible)}>{text('retain')}{eligible.length ? ` (${eligible.length})` : ''}</Button>
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
          {reportId ? <Button size="small" disabled={locked} onClick={() => { void onOpenReport(reportId).catch(onError) }}>{text('openReport')}</Button> : canRetain(row, clock) ? <Button size="small" disabled={locked} onClick={() => void retain([row])}>{text('retain')}</Button> : null}
          {retry && <Button size="small" disabled={locked} icon={<RefreshCw size={13} />} onClick={() => void parse([row])}>{text(row.error || row.preview ? 'retryUpload' : 'upload')}</Button>}
          <Button size="small" type="text" disabled={locked} icon={<Trash2 size={14} />} aria-label={`${text('removeFile')} ${row.file.name}`} onClick={() => { setRows(current => current.filter(item => item.uid !== row.uid)); if (previewId === row.uid) setPreviewId(null) }} />
        </Space>
      } },
    ]} /></> : <Empty description={text('draft')} />}
    <Modal open={active && Boolean(viewed?.preview)} title={viewed?.file.name} onCancel={() => setPreviewId(null)} footer={null} width={1150} destroyOnHidden>
      {viewed?.preview && <Suspense fallback={<Spin />}><ReportViewer key={viewed.preview.id} report={viewed.preview.parsed} language={language} /></Suspense>}
    </Modal>
  </div>
}
