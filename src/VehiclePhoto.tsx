import { useEffect, useRef, useState } from 'react'
import type { ChangeEvent } from 'react'
import { Alert, Button, Form, Input, Modal, Space, Spin } from 'antd'
import { Camera, ImagePlus, RefreshCw, Trash2 } from 'lucide-react'
import type { BusinessRecord } from '../shared/business'
import { inspectVehiclePhoto, PHOTO_MAX_BYTES, PHOTO_MAX_DIMENSION, PHOTO_MAX_PIXELS } from '../shared/vehicle-photo'
import { ApiError, createWorkspaceScope } from './api'
import { translateBusiness } from './business-i18n'
import type { Language } from './i18n'
import './VehiclePhoto.css'

type Props = { vehicle: BusinessRecord; language: Language; onChanged: () => Promise<void>; onError: (cause: unknown) => void; onBusyChange?: (busy: boolean) => void }
type Dialog = { mode: 'upload'; vehicleId: string; version: number; file: File; address: string } | { mode: 'remove'; vehicleId: string; version: number }
type Operation = { controller: AbortController; finish: () => void }

async function checkedImageAddress(file: Blob, signal: AbortSignal): Promise<string> {
  signal.throwIfAborted()
  if (!file.size || file.size > PHOTO_MAX_BYTES) throw new ApiError('PHOTO_INVALID')
  const bytes = new Uint8Array(await file.arrayBuffer())
  signal.throwIfAborted()
  const information = inspectVehiclePhoto(bytes)
  if (!information) throw new ApiError('PHOTO_INVALID')
  const address = URL.createObjectURL(new Blob([bytes], { type: information.mime }))
  try {
    await new Promise<void>((resolve, reject) => {
      const image = new Image()
      const clear = () => { signal.removeEventListener('abort', abort); image.onload = null; image.onerror = null }
      const abort = () => { clear(); image.src = ''; reject(signal.reason ?? new DOMException('Preview cancelled', 'AbortError')) }
      image.onload = () => {
        const width = image.naturalWidth, height = image.naturalHeight
        clear()
        const expectedDimensions = width === information.width && height === information.height || width === information.height && height === information.width
        if (!width || !height || width > PHOTO_MAX_DIMENSION || height > PHOTO_MAX_DIMENSION || width * height > PHOTO_MAX_PIXELS || !expectedDimensions) reject(new ApiError('PHOTO_INVALID'))
        else resolve()
      }
      image.onerror = () => { clear(); reject(new ApiError('PHOTO_INVALID')) }
      signal.addEventListener('abort', abort, { once: true })
      if (signal.aborted) abort()
      else image.src = address
    })
    signal.throwIfAborted()
    return address
  } catch (cause) { URL.revokeObjectURL(address); throw cause }
}

export default function VehiclePhoto(props: Props) {
  const { vehicle } = props
  return <VehiclePhotoPanel key={`${vehicle.id}:${vehicle.version}:${String(vehicle.data.photoAttachmentId ?? '')}`} {...props} />
}

function VehiclePhotoPanel({ vehicle, language, onChanged, onError, onBusyChange }: Props) {
  const text = translateBusiness(language), photoId = String(vehicle.data.photoAttachmentId ?? ''), endpoint = `/api/business/vehicles/${encodeURIComponent(vehicle.id)}/photo`
  const [scope] = useState(() => createWorkspaceScope()), [form] = Form.useForm<{ reason: string }>()
  const [cover, setCover] = useState<string | null>(null), [coverState, setCoverState] = useState<'loading' | 'empty' | 'unavailable'>(photoId ? 'loading' : 'empty'), [retry, setRetry] = useState(0)
  const [dialog, setDialog] = useState<Dialog | null>(null), [previewInvalid, setPreviewInvalid] = useState(false), [preparing, setPreparing] = useState(false), [saving, setSaving] = useState(false)
  const active = useRef(true), input = useRef<HTMLInputElement>(null), previewController = useRef<AbortController | null>(null), previewAddress = useRef<string | null>(null), operation = useRef<Operation | null>(null)
  useEffect(() => {
    active.current = true
    return () => {
      active.current = false
      previewController.current?.abort(); operation.current?.controller.abort(); operation.current?.finish()
      if (previewAddress.current) URL.revokeObjectURL(previewAddress.current)
    }
  }, [])
  useEffect(() => {
    const controller = new AbortController()
    let mounted = true, address: string | null = null
    if (photoId) void scope.blob(endpoint, { signal: controller.signal }).then(blob => checkedImageAddress(blob, controller.signal)).then(value => {
      if (!mounted || !active.current || controller.signal.aborted) { URL.revokeObjectURL(value); return }
      address = value; setCover(value)
    }).catch(() => {
      if (mounted && active.current && !controller.signal.aborted) setCoverState('unavailable')
    })
    return () => { mounted = false; controller.abort(); if (address) URL.revokeObjectURL(address) }
  }, [scope, endpoint, photoId, retry])

  function clearDialog() {
    previewController.current?.abort(); previewController.current = null
    if (previewAddress.current) URL.revokeObjectURL(previewAddress.current)
    previewAddress.current = null; setDialog(null); form.resetFields()
  }
  async function chooseFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file || vehicle.archived || saving) return
    previewController.current?.abort()
    const controller = new AbortController(); previewController.current = controller
    const target = { vehicleId: vehicle.id, version: vehicle.version }
    setPreviewInvalid(false); setPreparing(true)
    try {
      const address = await checkedImageAddress(file, controller.signal)
      if (!active.current || controller.signal.aborted || previewController.current !== controller) { URL.revokeObjectURL(address); return }
      if (previewAddress.current) URL.revokeObjectURL(previewAddress.current)
      previewAddress.current = address; form.resetFields(); setDialog({ mode: 'upload', ...target, file, address })
    } catch {
      if (active.current && !controller.signal.aborted && previewController.current === controller) setPreviewInvalid(true)
    } finally { if (active.current && previewController.current === controller) setPreparing(false) }
  }
  function remove() {
    if (vehicle.archived || saving || preparing) return
    setPreviewInvalid(false); form.resetFields(); setDialog({ mode: 'remove', vehicleId: vehicle.id, version: vehicle.version })
  }
  async function confirm(reason: string) {
    if (!dialog || saving || operation.current || vehicle.archived || !reason.trim()) return
    const target = dialog, controller = new AbortController()
    let finished = false
    const pending: Operation = { controller, finish: () => { if (finished) return; finished = true; onBusyChange?.(false); if (active.current) setSaving(false); if (operation.current === pending) operation.current = null } }
    operation.current = pending; setSaving(true); onBusyChange?.(true)
    try {
      const url = `/api/business/vehicles/${encodeURIComponent(target.vehicleId)}/photo`
      if (target.mode === 'upload') {
        const body = new FormData(); body.append('file', target.file); body.append('version', String(target.version)); body.append('reason', reason.trim())
        await scope.request<{ vehicle: BusinessRecord; attachment: BusinessRecord }>(url, { method: 'POST', body, signal: controller.signal })
      } else await scope.request<BusinessRecord>(url, { method: 'DELETE', body: { version: target.version, reason: reason.trim() }, signal: controller.signal })
      if (!active.current || controller.signal.aborted || operation.current !== pending) return
      clearDialog(); await onChanged()
    } catch (cause) {
      if (active.current && !controller.signal.aborted && !(cause instanceof ApiError && cause.message === 'WORKSPACE_CHANGED')) onError(cause)
    } finally { pending.finish() }
  }

  return <section className="vehicle-photo-panel" aria-label={text('vehiclePhoto')} data-vehicle-id={vehicle.id}>
    <div className="vehicle-photo-heading"><h3>{text('vehiclePhoto')}</h3>{!vehicle.archived && <Space wrap>
      <Button icon={<ImagePlus size={15} />} loading={preparing} disabled={saving} onClick={() => input.current?.click()}>{text(photoId ? 'vehiclePhotoReplace' : 'vehiclePhotoAdd')}</Button>
      {photoId && <Button danger icon={<Trash2 size={15} />} disabled={saving || preparing} onClick={remove}>{text('vehiclePhotoRemove')}</Button>}
    </Space>}</div>
    <input ref={input} type="file" accept="image/png,image/jpeg,.png,.jpg,.jpeg" className="vehicle-photo-input" aria-label={text('vehiclePhotoAdd')} onChange={event => void chooseFile(event)} disabled={vehicle.archived || saving || preparing} />
    {cover ? <div className="vehicle-photo-image"><img src={cover} alt={`${text('vehiclePhotoAlt')} ${String(vehicle.data.vin ?? '')}`} /></div> : <div className="vehicle-photo-placeholder">
      {coverState === 'loading' ? <><Spin size="small" /><span>{text('vehiclePhotoLoading')}</span></> : <><Camera size={25} aria-hidden="true" /><span>{text(coverState === 'empty' ? 'vehiclePhotoEmpty' : 'vehiclePhotoUnavailable')}</span>{photoId && <Button type="text" size="small" icon={<RefreshCw size={14} />} onClick={() => { setCoverState('loading'); setRetry(value => value + 1) }}>{text('vehiclePhotoRetry')}</Button>}</>}
    </div>}
    {!vehicle.archived && <p className="vehicle-photo-limits">{text('vehiclePhotoLimits')}</p>}
    {previewInvalid && <Alert type="error" showIcon title={text('vehiclePhotoInvalid')} />}
    <Modal open={Boolean(dialog)} title={text(dialog?.mode === 'remove' ? 'vehiclePhotoRemove' : 'vehiclePhotoPreview')} onCancel={() => { if (!saving) clearDialog() }} onOk={() => form.submit()} okText={text('save')} cancelText={text('cancel')} confirmLoading={saving} closable={!saving} keyboard={!saving} maskClosable={!saving} destroyOnHidden>
      {dialog && <Form form={form} name="vehicle-photo" layout="vertical" disabled={saving} requiredMark={false} onFinish={values => void confirm(values.reason)}>
        {dialog.mode === 'upload' && <div className="vehicle-photo-preview"><img src={dialog.address} alt={text('vehiclePhotoPreview')} /></div>}
        <p className="vehicle-photo-confirmation">{text(dialog.mode === 'upload' ? 'vehiclePhotoUploadConfirm' : 'vehiclePhotoRemoveConfirm')}</p>
        <Form.Item name="reason" label={text('reason')} rules={[{ required: true, whitespace: true, message: text('required') }]}><Input.TextArea maxLength={500} rows={2} /></Form.Item>
      </Form>}
    </Modal>
  </section>
}
