import { useEffect, useMemo, useRef, useState } from 'react'
import { Alert, Button, Empty, Modal, Select, Spin, Table } from 'antd'
import type { BusinessRecord } from '../shared/business'
import { createWorkspaceScope, download } from './api'
import type { Language } from './i18n'

type Props = { record: BusinessRecord | null; language: Language; onClose: () => void }
type WorkbookPreview = { names: string[]; rows: (name: string) => string[][] }
const excel = /\.(xlsx|xls)$/i, image = /\.(png|jpe?g|jfif)$/i

export default function AttachmentPreview({ record, language, onClose }: Props) {
  const [busy, setBusy] = useState(false), [error, setError] = useState(false), [url, setUrl] = useState(''), [workbook, setWorkbook] = useState<WorkbookPreview | null>(null), [active, setActive] = useState(0)
  const imageCache = useRef<{ key: string; blob: Blob; scope: ReturnType<typeof createWorkspaceScope> } | null>(null)
  useEffect(() => {
    if (!record) return
    let live = true, address = ''
    const controller = new AbortController(), scope = createWorkspaceScope()
    setBusy(true); setError(false); setWorkbook(null); setUrl(''); setActive(0)
    const key = `${record.id}:${record.data.checksum}`
    try { imageCache.current?.scope.assertCurrent() } catch { imageCache.current = null }
    const cached = imageCache.current?.key === key ? imageCache.current.blob : null
    const parser = excel.test(String(record.data.name)) ? import('xlsx') : null
    void (cached ? Promise.resolve(cached) : scope.blob(`/api/business/files/${encodeURIComponent(record.id)}`, { signal: controller.signal })).then(async blob => {
      scope.assertCurrent(controller.signal)
      if (!live) return
      if (excel.test(String(record.data.name))) {
        const XLSX = (await parser)!
        const book = XLSX.read(await blob.arrayBuffer(), { type: 'array', sheetRows: 501, cellFormula: false, cellHTML: false })
        scope.assertCurrent(controller.signal)
        if (!live) return
        setWorkbook({ names: book.SheetNames, rows: name => XLSX.utils.sheet_to_json<string[]>(book.Sheets[name], { header: 1, raw: false, defval: '', range: 'A1:AX500', blankrows: false }) })
      } else {
        if (image.test(String(record.data.name)) && blob.size <= 10 * 1024 * 1024) imageCache.current = { key, blob, scope }
        address = URL.createObjectURL(new Blob([blob], { type: /\.png$/i.test(String(record.data.name)) ? 'image/png' : image.test(String(record.data.name)) ? 'image/jpeg' : 'application/pdf' }))
        if (live) setUrl(address)
      }
    }).catch(() => { if (live) setError(true) }).finally(() => { if (live) setBusy(false) })
    return () => { live = false; controller.abort(); if (address) URL.revokeObjectURL(address) }
  }, [record])
  const name = String(record?.data.name || ''), isExcel = excel.test(name), isImage = image.test(name), zh = language === 'zh'
  const sheet = useMemo(() => workbook?.names[active] ? { rows: workbook.rows(workbook.names[active]) } : null, [workbook, active])
  const downloadOriginal = () => { if (record) void download(`/api/business/files/${encodeURIComponent(record.id)}`, name).catch(() => setError(true)) }
  return <Modal open={Boolean(record)} title={name} onCancel={onClose} footer={<Button onClick={downloadOriginal}>{zh ? '下载原文件' : 'Download original'}</Button>} width={isExcel ? 1000 : 900} destroyOnHidden>
    {busy ? <Spin /> : error ? <Alert type="error" showIcon title={zh ? '预览加载失败，请下载原文件查看。' : 'Preview failed. Download the original to view it.'} /> : isExcel ? <>
      <p>{zh ? '只读预览：每张工作表最多显示前 500 行、50 列；格式、图表和公式以原文件为准。' : 'Read only: up to 500 rows and 50 columns per sheet. Refer to the original for formatting, charts and formulas.'}</p>
      {workbook && workbook.names.length > 0 && <Select aria-label={zh ? '工作表' : 'Worksheet'} value={active} onChange={setActive} options={workbook.names.map((name, index) => ({ value: index, label: name }))} style={{ minWidth: 200, marginBottom: 12 }} />}
      {sheet?.rows.length ? <Table rowKey={(_, index) => String(index)} size="small" pagination={{ pageSize: 20, showSizeChanger: false }} scroll={{ x: 1600, y: '50vh' }} columns={Array.from({ length: Math.min(50, Math.max(1, ...sheet.rows.map(row => row.length))) }, (_, index) => ({ title: String(index + 1), width: 140, dataIndex: String(index), render: (value: string) => <span className="preserve-text">{value}</span> }))} dataSource={sheet.rows.map((row, index) => Object.assign({ key: index }, Object.fromEntries(row.map((value, col) => [String(col), value]))))} /> : <Empty />}
    </> : url && (isImage ? <img alt={name} src={url} onError={() => setError(true)} style={{ display: 'block', maxWidth: '100%', maxHeight: '70vh', margin: 'auto' }} /> : <><p>{zh ? '若浏览器未显示 PDF，请下载原文件查看。' : 'If your browser does not display the PDF, download the original.'}</p><iframe title={name} src={url} style={{ width: '100%', height: '65vh', border: 0 }} /></>)}
  </Modal>
}
