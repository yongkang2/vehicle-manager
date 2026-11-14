import { useEffect, useState } from 'react'
import { Alert, Button, Empty, Modal, Select, Spin, Table } from 'antd'
import type { BusinessRecord } from '../shared/business'
import { createWorkspaceScope, download } from './api'
import type { Language } from './i18n'

type Props = { record: BusinessRecord | null; language: Language; onClose: () => void }
type Sheet = { name: string; rows: string[][] }
const excel = /\.(xlsx|xls)$/i, image = /\.(png|jpe?g|jfif)$/i

export default function AttachmentPreview({ record, language, onClose }: Props) {
  const [busy, setBusy] = useState(false), [error, setError] = useState(false), [url, setUrl] = useState(''), [sheets, setSheets] = useState<Sheet[]>([]), [active, setActive] = useState(0)
  useEffect(() => {
    if (!record) return
    let live = true, address = ''
    const controller = new AbortController(), scope = createWorkspaceScope()
    setBusy(true); setError(false); setSheets([]); setUrl(''); setActive(0)
    void scope.blob(`/api/business/files/${encodeURIComponent(record.id)}`, { signal: controller.signal }).then(async blob => {
      if (!live) return
      if (excel.test(String(record.data.name))) {
        const XLSX = await import('xlsx')
        const book = XLSX.read(await blob.arrayBuffer(), { type: 'array', sheetRows: 501, cellFormula: false, cellHTML: false })
        scope.assertCurrent(controller.signal)
        if (!live) return
        setSheets(book.SheetNames.map(name => ({ name, rows: XLSX.utils.sheet_to_json<string[]>(book.Sheets[name], { header: 1, raw: false, defval: '', range: 'A1:AX500', blankrows: false }) })))
      } else {
        address = URL.createObjectURL(new Blob([blob], { type: /\.png$/i.test(String(record.data.name)) ? 'image/png' : image.test(String(record.data.name)) ? 'image/jpeg' : 'application/pdf' }))
        if (live) setUrl(address)
      }
    }).catch(() => { if (live) setError(true) }).finally(() => { if (live) setBusy(false) })
    return () => { live = false; controller.abort(); if (address) URL.revokeObjectURL(address) }
  }, [record])
  const name = String(record?.data.name || ''), isExcel = excel.test(name), isImage = image.test(name), sheet = sheets[active], zh = language === 'zh'
  const downloadOriginal = () => { if (record) void download(`/api/business/files/${encodeURIComponent(record.id)}`, name).catch(() => setError(true)) }
  return <Modal open={Boolean(record)} title={name} onCancel={onClose} footer={<Button onClick={downloadOriginal}>{zh ? '下载原文件' : 'Download original'}</Button>} width={isExcel ? 1000 : 900} destroyOnHidden>
    {busy ? <Spin /> : error ? <Alert type="error" showIcon title={zh ? '预览加载失败，请下载原文件查看。' : 'Preview failed. Download the original to view it.'} /> : isExcel ? <>
      <p>{zh ? '只读预览：每张工作表最多显示前 500 行、50 列；格式、图表和公式以原文件为准。' : 'Read only: up to 500 rows and 50 columns per sheet. Refer to the original for formatting, charts and formulas.'}</p>
      {sheets.length > 0 && <Select aria-label={zh ? '工作表' : 'Worksheet'} value={active} onChange={setActive} options={sheets.map((item, index) => ({ value: index, label: item.name }))} style={{ minWidth: 200, marginBottom: 12 }} />}
      {sheet?.rows.length ? <Table rowKey={(_, index) => String(index)} size="small" pagination={{ pageSize: 20, showSizeChanger: false }} scroll={{ x: 1600, y: '50vh' }} columns={Array.from({ length: Math.min(50, Math.max(1, ...sheet.rows.map(row => row.length))) }, (_, index) => ({ title: String(index + 1), width: 140, dataIndex: String(index), render: (value: string) => <span className="preserve-text">{value}</span> }))} dataSource={sheet.rows.map((row, index) => Object.assign({ key: index }, Object.fromEntries(row.map((value, col) => [String(col), value]))))} /> : <Empty />}
    </> : url && (isImage ? <img alt={name} src={url} onError={() => setError(true)} style={{ display: 'block', maxWidth: '100%', maxHeight: '70vh', margin: 'auto' }} /> : <><p>{zh ? '若浏览器未显示 PDF，请下载原文件查看。' : 'If your browser does not display the PDF, download the original.'}</p><iframe title={name} src={url} style={{ width: '100%', height: '65vh', border: 0 }} /></>)}
  </Modal>
}
