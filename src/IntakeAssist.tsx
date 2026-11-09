import { useEffect, useRef, useState } from 'react'
import { Alert, Button, Checkbox, Space, Select, InputNumber } from 'antd'
import { createWorkspaceScope } from './api'
import type { IntakeFields } from '../shared/intake'
import type { Language } from './i18n'
import { translateBusiness } from './business-i18n'
import { prepareIntakeImage, decodeIntakeImage } from './intake-material'

export default function IntakeAssist({ language, allowed, disabled, onApply }: { language: Language; allowed: string[]; disabled: boolean; onApply: (fields: IntakeFields) => void }) {
  const zh = language === 'zh', text = translateBusiness(language)
  const input = useRef<HTMLInputElement>(null), request = useRef<AbortController | null>(null)
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [fields, setFields] = useState<IntakeFields>({}), [selected, setSelected] = useState<string[]>([]), [count, setCount] = useState(0)
  const [source, setSource] = useState<File | null>(null), [image, setImage] = useState<Blob | null>(null), [preview, setPreview] = useState(''), [code, setCode] = useState(''), [codeField, setCodeField] = useState(''), [page, setPage] = useState(1), [pages, setPages] = useState(1), [rawText, setRawText] = useState('')
  const generation = useRef(0)
  const previewUrl = useRef('')
  useEffect(() => () => { generation.current++; }, [])
  useEffect(() => () => URL.revokeObjectURL(previewUrl.current), [])
  async function prepare(file: File, requestedPage = 1) {
    const current = ++generation.current
    request.current?.abort(); setBusy(true); setFields({}); setSelected([]); setCode(''); setError(''); setImage(null); setPages(1); setRawText(''); setSource(null)
    URL.revokeObjectURL(previewUrl.current); previewUrl.current = ''; setPreview('')
    try {
      const material = await prepareIntakeImage(file, requestedPage)
      if (current !== generation.current) return
      setImage(material.image); setRawText(material.text); setPages(material.pages); setPage(requestedPage); setSource(file)
      previewUrl.current = URL.createObjectURL(material.image); setPreview(previewUrl.current)
      const url = URL.createObjectURL(material.image)
      try { const decoded = await decodeIntakeImage(url); if (current === generation.current) setCode(decoded || '') } finally { URL.revokeObjectURL(url) }
    } catch { if (current === generation.current) setError(zh ? '无法读取文件。请选择不超过 5 MB 的图片或 PDF。' : 'Cannot read file. Choose an image or PDF up to 5 MB.') }
    finally { if (current === generation.current) setBusy(false) }
  }
  useEffect(() => () => request.current?.abort(), [])
  async function recognize(file: Blob) {
    request.current?.abort()
    const controller = new AbortController(); request.current = controller
    setFields({}); setSelected([]); setError(''); setBusy(true)
    try {
      const form = new FormData(); form.append('file', file, 'label.png')
      const result = await createWorkspaceScope().request<{ fields: IntakeFields; matches: unknown[] }>('/api/business/intake/recognize', { method: 'POST', body: form, signal: controller.signal })
      setFields(result.fields); setCount(result.matches.length)
    } catch (failure) {
      if (!controller.signal.aborted) setError(failure instanceof Error && failure.message === 'AI_NOT_CONFIGURED' ? (zh ? '管理员尚未配置统一识别服务。' : 'The shared recognition service is not configured.') : (zh ? '识别失败，请重试或手动填写。' : 'Recognition failed. Retry or enter values manually.'))
    } finally { if (!controller.signal.aborted) setBusy(false) }
  }
  const entries = Object.entries(fields).filter(([key]) => allowed.includes(key))
  return <Space orientation="vertical" style={{ width: '100%', marginBottom: 16 }}>
    <input ref={input} type="file" accept="image/png,image/jpeg,application/pdf" hidden onChange={event => { const file = event.target.files?.[0]; event.target.value = ''; if (file) void prepare(file) }} />
    <Space wrap><Button disabled={disabled || busy} onClick={() => input.current?.click()}>{zh ? '选择标签图片或 PDF' : 'Choose label image or PDF'}</Button>
    {image && <Button disabled={disabled || busy} loading={busy} onClick={() => void recognize(image)}>{zh ? '用 AI 提取字段（发送当前图片）' : 'Extract fields with AI (send current image)'}</Button>}</Space>
    {pages > 1 && <label>{zh ? 'PDF 页码：' : 'PDF page: '}<InputNumber aria-label={zh ? 'PDF 页码' : 'PDF page'} min={1} max={pages} value={page} disabled={busy || disabled} onChange={value => { if (source && value) void prepare(source, Number(value)) }} /> / {pages}</label>}
    {preview && <img src={preview} alt={zh ? '识别材料预览' : 'Recognition source preview'} style={{ maxWidth: '100%', maxHeight: 240, objectFit: 'contain' }} />}
    {rawText && <details><summary>{zh ? 'PDF 原文' : 'PDF text'}</summary><pre style={{ whiteSpace: 'pre-wrap', maxHeight: 160, overflow: 'auto' }}>{rawText}</pre></details>}
    {code && <Space wrap><span>{zh ? '解码内容：' : 'Decoded value: '}{code}</span><Select aria-label={zh ? '编号对应字段' : 'Identifier field'} placeholder={zh ? '选择对应字段' : 'Choose field'} value={codeField || undefined} onChange={setCodeField} options={['vin', 'serial', 'productPart'].filter(key => allowed.includes(key)).map(key => ({ value: key, label: text(key) }))} /><Button disabled={!codeField || disabled || busy} onClick={() => onApply({ [codeField]: code })}>{zh ? '填入解码内容' : 'Fill decoded value'}</Button></Space>}
    {busy && <span>{zh ? '正在识别，可继续手动填写。' : 'Recognizing. You can continue entering values manually.'}</span>}
    {error && <Alert type="warning" title={error} />}
    {Object.keys(fields).length > 0 && <>
      <Alert type="info" title={zh ? `请对照原图核对，选择需要填入的字段。找到 ${count} 条精确匹配记录，不会自动关联。` : `Check against the original image and select fields to fill. ${count} exact matches; no record is linked automatically.`} />
      {entries.map(([key, value]) => <Checkbox key={key} disabled={disabled} checked={selected.includes(key)} onChange={event => setSelected(current => event.target.checked ? [...current, key] : current.filter(item => item !== key))}>{text(key)}: {value}</Checkbox>)}
      <Button disabled={disabled || !selected.length} onClick={() => { onApply(Object.fromEntries(entries.filter(([key]) => selected.includes(key)))); setFields({}); setSelected([]) }}>{zh ? '填入选中字段（覆盖表单现值）' : 'Fill selected fields (replace form values)'}</Button>
    </>}
  </Space>
}
