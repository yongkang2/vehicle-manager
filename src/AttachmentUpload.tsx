import { useEffectEvent, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react'
import { Alert, Button, Space, Table, Tag } from 'antd'
import { Plus, RefreshCw, Trash2, Upload as UploadIcon } from 'lucide-react'
import type { BusinessRecord } from '../shared/business'
import { ATTACHMENT_BATCH_LIMIT, ATTACHMENT_EXTENSIONS } from '../shared/attachments'
import { createWorkspaceScope } from './api'
import { AttachmentUploadQueue } from './attachment-upload-queue'
import type { AttachmentUploadRow } from './attachment-upload-queue'
import { translateBusiness } from './business-i18n'
import { errorText } from './i18n'
import type { Language } from './i18n'
import './AttachmentUpload.css'

type Props = {
  vehicle: BusinessRecord
  language: Language
  disabled: boolean
  onRefresh: (scope: ReturnType<typeof createWorkspaceScope>, signal: AbortSignal) => Promise<void>
  onBusyChange: (busy: boolean) => void
  onCancelReady: (cancel: (() => void) | null) => void
  onError: (cause: unknown) => void
}

function createQueueStore() {
  let current: AttachmentUploadQueue | null = null
  const listeners = new Set<() => void>()
  return {
    getSnapshot: () => current,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    replace: (queue: AttachmentUploadQueue | null) => { current = queue; for (const listener of listeners) listener() },
  }
}

export default function AttachmentUpload({ vehicle, language, disabled, onRefresh, onBusyChange, onCancelReady, onError }: Props) {
  const [store] = useState(createQueueStore)
  const queue = useSyncExternalStore(store.subscribe, store.getSnapshot)
  const refresh = useEffectEvent(onRefresh), changeBusy = useEffectEvent(onBusyChange), exposeCancel = useEffectEvent(onCancelReady)
  useLayoutEffect(() => {
    const scope = createWorkspaceScope()
    const next = new AttachmentUploadQueue({ scope, vehicleId: vehicle.id, onRefresh: signal => refresh(scope, signal), onBusyChange: value => changeBusy(value) })
    store.replace(next)
    exposeCancel(() => next.dispose())
    return () => { exposeCancel(null); next.dispose(); store.replace(null) }
  }, [vehicle.id, store])
  return queue && <AttachmentUploadPanel queue={queue} vehicle={vehicle} language={language} disabled={disabled} onError={onError} />
}

function AttachmentUploadPanel({ queue, vehicle, language, disabled, onError }: Pick<Props, 'vehicle' | 'language' | 'disabled' | 'onError'> & { queue: AttachmentUploadQueue }) {
  const text = translateBusiness(language), input = useRef<HTMLInputElement>(null)
  const snapshot = useSyncExternalStore(queue.subscribe, queue.getSnapshot)
  const { rows, busy, limited, inspectionRequired, refreshError } = snapshot
  const locked = busy || disabled, readonly = locked || vehicle.archived
  const pending = rows.filter(row => row.status === 'pending').length, failed = rows.filter(row => row.status === 'failed').length
  const uploaded = rows.filter(row => row.status === 'uploaded').length, completed = rows.filter(row => !['pending', 'uploading'].includes(row.status)).length
  const uploading = rows.some(row => row.status === 'uploading')
  const colors = { pending: 'default', invalid: 'error', uploading: 'processing', uploaded: 'success', failed: 'error', unknown: 'warning' } as const
  return <section className="attachment-upload" aria-label={text('attachmentUploadQueue')}>
    <input ref={input} className="attachment-file-input" type="file" hidden multiple accept={ATTACHMENT_EXTENSIONS.join(',')} aria-label={text('attachmentChooseFiles')} disabled={readonly || inspectionRequired || rows.length >= ATTACHMENT_BATCH_LIMIT} onChange={event => {
      queue.add(Array.from(event.target.files || [])); event.target.value = ''
    }} />
    <div className="attachment-upload-toolbar">
      <Button icon={<Plus size={15} />} disabled={readonly || inspectionRequired || rows.length >= ATTACHMENT_BATCH_LIMIT} onClick={() => input.current?.click()}>{text('attachmentChooseFiles')}</Button>
      <Button type="primary" icon={<UploadIcon size={15} />} disabled={readonly || !pending} loading={busy && uploading} onClick={() => void queue.run('pending').catch(onError)}>{text('upload')}{pending ? ` (${pending})` : ''}</Button>
      {failed > 0 && <Button icon={<RefreshCw size={15} />} disabled={readonly} onClick={() => void queue.run('failed').catch(onError)}>{text('attachmentRetryFailed')} ({failed})</Button>}
      <Button type="text" disabled={locked || !rows.length || inspectionRequired} onClick={() => queue.clear()}>{text('clearBatch')}</Button>
      <Button icon={<RefreshCw size={15} />} disabled={locked} loading={busy && !uploading} onClick={() => void queue.refresh().catch(onError)}>{text('attachmentRefreshList')}</Button>
    </div>
    <p className="attachment-upload-limits">{text('attachmentBatchLimits')}</p>
    {limited && <Alert type="warning" showIcon title={text('attachmentSelectionLimit')} />}
    {rows.some(row => row.status === 'unknown') && <Alert type="warning" showIcon title={text('attachmentUnknownNotice')} description={inspectionRequired ? text('attachmentInspectBeforeRetry') : text('attachmentInspectionDone')} />}
    {refreshError && <Alert type="warning" showIcon title={text('attachmentRefreshFailed')} description={errorText(refreshError, language)} />}
    {rows.length > 0 && <>
      <p className="attachment-upload-count" role="status" aria-live="polite">{text('selectedFiles')}: {rows.length} / {ATTACHMENT_BATCH_LIMIT} · {text('attachmentCompleted')}: {completed} / {rows.length} · {text('attachmentUploadedCount')}: {uploaded}</p>
      <Table<AttachmentUploadRow> className="attachment-upload-queue" rowKey="id" dataSource={rows} size="small" pagination={false} scroll={{ x: 620 }} columns={[
        { title: text('name'), render: (_, row) => <span className="attachment-upload-name" title={row.file.name}>{row.file.name}</span> },
        { title: text('size'), width: 95, render: (_, row) => `${(row.file.size / 1024).toFixed(1)} KB` },
        { title: text('status'), width: 225, render: (_, row) => <div className="attachment-upload-result"><Tag color={colors[row.status]}>{text(`attachmentStatus_${row.status}`)}</Tag>{row.error && <small>{errorText(row.error, language)}</small>}</div> },
        { title: text('actions'), width: 75, render: (_, row) => <Space><Button type="text" size="small" icon={<Trash2 size={14} />} aria-label={`${text('attachmentRemoveFromQueue')} ${row.file.name}`} disabled={locked || (row.status === 'unknown' && inspectionRequired)} onClick={() => queue.remove(row.id)} /></Space> },
      ]} />
    </>}
  </section>
}
