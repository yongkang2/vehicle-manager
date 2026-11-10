import { useEffectEvent, useLayoutEffect, useState, useSyncExternalStore } from 'react'
import { Alert, Button, Table } from 'antd'
import { Download } from 'lucide-react'
import type { BusinessRecord, Fields } from '../shared/business'
import { equipmentAttachments } from '../shared/equipment-attachments'
import { createWorkspaceScope } from './api'
import { AttachmentUploadPanel } from './AttachmentUpload'
import { translateBusiness } from './business-i18n'
import { EquipmentRecordWorkflow } from './equipment-record-workflow'
import { errorText } from './i18n'
import type { Language } from './i18n'
import RecordEditor from './RecordEditor'

type Scope = ReturnType<typeof createWorkspaceScope>
type Props = {
  vehicle: BusinessRecord
  record: BusinessRecord | null
  records: BusinessRecord[]
  language: Language
  onCancel: () => void
  onSaved: (scope: Scope, signal: AbortSignal) => Promise<void>
  onBusyChange: (busy: boolean) => void
  onError: (cause: unknown) => void
  onCancelReady?: (cancel: (() => void) | null) => void
}

function createWorkflowStore() {
  let current: EquipmentRecordWorkflow | null = null
  const listeners = new Set<() => void>()
  return {
    getSnapshot: () => current,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    replace: (workflow: EquipmentRecordWorkflow | null) => { current = workflow; for (const listener of listeners) listener() },
  }
}

/** A fresh scoped workflow is created for each editor, including StrictMode remounts. */
export default function EquipmentRecordEditor(props: Props) {
  const { vehicle, record, onSaved, onBusyChange, onCancelReady } = props
  const [store] = useState(createWorkflowStore)
  const workflow = useSyncExternalStore(store.subscribe, store.getSnapshot)
  const refresh = useEffectEvent(onSaved), busyChanged = useEffectEvent(onBusyChange)
  const initialRecord = useEffectEvent(() => record)
  const cancelReady = useEffectEvent((cancel: (() => void) | null) => onCancelReady?.(cancel))
  const recordId = record?.id
  useLayoutEffect(() => {
    const scope = createWorkspaceScope()
    const next = new EquipmentRecordWorkflow({ scope, vehicleId: vehicle.id, record: initialRecord(), onRefresh: signal => refresh(scope, signal), onBusyChange: value => busyChanged(value) })
    store.replace(next)
    cancelReady(() => next.dispose())
    return () => { cancelReady(null); next.dispose(); store.replace(null) }
  }, [vehicle.id, recordId, store])
  return workflow && <EquipmentEditorPanel {...props} workflow={workflow} />
}

function EquipmentEditorPanel({ workflow, vehicle, record, records, language, onCancel, onError }: Props & { workflow: EquipmentRecordWorkflow }) {
  const text = translateBusiness(language)
  const snapshot = useSyncExternalStore(workflow.subscribe, workflow.getSnapshot)
  const saved = snapshot.state === 'saved', unknown = snapshot.state === 'unknown', blocked = snapshot.state === 'blocked'
  const current = snapshot.savedRecord || record
  const files = current ? equipmentAttachments(records, current) : []
  const readonly = vehicle.archived || Boolean(current?.archived) || Boolean(current && records.find(row => row.id === current.id)?.archived)
  function report(cause: unknown) {
    try { workflow.assertCurrent(); onError(cause) } catch { /* Closed or switched editors discard stale failures. */ }
  }
  async function save(data?: Fields, reason?: string) {
    try {
      await workflow.save(data, reason)
      if (workflow.canFinishCleanly()) onCancel()
    } catch (cause) { report(cause) }
  }
  async function download(record: BusinessRecord) {
    try {
      const blob = await workflow.readAttachment(record)
      workflow.assertCurrent()
      const address = URL.createObjectURL(blob), anchor = document.createElement('a')
      anchor.href = address; anchor.download = String(record.data.name); anchor.click()
      setTimeout(() => URL.revokeObjectURL(address), 1000)
    } catch (cause) { report(cause) }
  }
  return <RecordEditor
    kind="equipment" record={record} language={language} busy={snapshot.busy}
    saveBlocked={readonly && !saved && !blocked} formDisabled={snapshot.state !== 'editing'}
    onCancel={() => { if (!snapshot.busy || saved) onCancel() }} onSave={(data, reason) => void save(data, reason)}
    onOk={saved || blocked ? onCancel : unknown ? () => void save() : undefined}
    okText={saved ? text('equipmentDone') : blocked ? text('equipmentClose') : unknown ? text('equipmentRetrySave') : undefined}
    cancelText={unknown ? text('equipmentClose') : undefined} hideCancel={saved || blocked}
    notice={<>
      {saved && <Alert type="success" showIcon title={text('equipmentSavedFilesNotice')} />}
      {unknown && <Alert type="warning" showIcon title={text('equipmentSaveUnknown')} />}
      {blocked && <Alert type="warning" showIcon title={text('equipmentSaveBlocked')} />}
      {snapshot.error && <Alert type="warning" showIcon title={errorText(snapshot.error, language)} />}
    </>}
    afterForm={<section aria-label={text('equipmentAttachmentsOptional')}>
      <h3>{text('equipmentAttachmentsOptional')}</h3>
      <AttachmentUploadPanel queue={workflow.queue} vehicle={vehicle} language={language}
        disabled={snapshot.busy || unknown || blocked || readonly} onError={onError} hideUploadActions={!saved} />
      {files.length > 0 && <Table<BusinessRecord> rowKey="id" size="small" dataSource={files} pagination={false} scroll={{ x: 460 }} columns={[
        { title: text('name'), render: (_, file) => <span className="attachment-upload-name" title={String(file.data.name)}>{String(file.data.name)}</span> },
        { title: text('size'), width: 100, render: (_, file) => `${(Number(file.data.size) / 1024).toFixed(1)} KB` },
        { title: text('actions'), width: 110, render: (_, file) => <Button icon={<Download size={15} />} disabled={snapshot.busy} onClick={() => void download(file)}>{text('download')}</Button> },
      ]} />}
    </section>}
  />
}
