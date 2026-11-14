import { useEffectEvent, useLayoutEffect, useState, useSyncExternalStore } from 'react'
import { App, Alert, Button, Form, Input, Modal } from 'antd'
import type { BusinessRecord } from '../shared/business'
import { ApiError, createWorkspaceScope } from './api'
import { translateBusiness } from './business-i18n'
import { errorText, type Language } from './i18n'
import { ReportCommentWorkflow, reportComment } from './report-comment-workflow'

type Props = {
  record: BusinessRecord
  readonly: boolean
  language: Language
  onCancel: () => void
  onSaved: (record: BusinessRecord, scope: ReturnType<typeof createWorkspaceScope>, signal: AbortSignal) => Promise<void>
  onInspected: (record: BusinessRecord, scope: ReturnType<typeof createWorkspaceScope>, signal: AbortSignal) => void
  onBusyChange: (busy: boolean) => void
  onError: (cause: unknown) => void
}
function workflowStore() {
  let current: ReportCommentWorkflow | null = null
  const listeners = new Set<() => void>()
  return {
    getSnapshot: () => current,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    replace: (next: ReportCommentWorkflow | null) => { current = next; for (const listener of listeners) listener() },
  }
}

export default function ReportCommentEditor(props: Props) {
  const [store] = useState(workflowStore)
  const workflow = useSyncExternalStore(store.subscribe, store.getSnapshot)
  const initialRecord = useEffectEvent(() => props.record)
  const saved = useEffectEvent(props.onSaved), inspected = useEffectEvent(props.onInspected), busyChanged = useEffectEvent(props.onBusyChange)
  useLayoutEffect(() => {
    const next = new ReportCommentWorkflow({ record: initialRecord(), scope: createWorkspaceScope(), onSaved: (record, scope, signal) => saved(record, scope, signal), onInspected: (record, scope, signal) => inspected(record, scope, signal), onBusyChange: value => busyChanged(value) })
    store.replace(next)
    return () => { next.dispose(); store.replace(null) }
  }, [props.record.id, store])
  return workflow && <CommentEditorPanel {...props} workflow={workflow} />
}

function CommentEditorPanel({ workflow, record, readonly, language, onCancel, onError }: Props & { workflow: ReportCommentWorkflow }) {
  const { modal, message } = App.useApp(), text = translateBusiness(language)
  const [form] = Form.useForm<{ comment: string; reason: string }>()
  const [initial] = useState(() => ({ comment: reportComment(record), reason: '' }))
  const snapshot = useSyncExternalStore(workflow.subscribe, workflow.getSnapshot)
  const comment = Form.useWatch('comment', form) ?? initial.comment, reason = Form.useWatch('reason', form) ?? ''
  const saved = snapshot.state === 'saved'
  const dirty = !saved && (comment !== reportComment(snapshot.record) || reason !== '')
  const blocked = readonly || snapshot.record.archived || snapshot.state !== 'editing'
  function close() {
    if (snapshot.busy) return
    if (!dirty) { onCancel(); return }
    modal.confirm({ title: text('reportCommentDiscardTitle'), content: text('reportCommentDiscardNotice'), okText: text('reportCommentDiscard'), cancelText: text('reportCommentKeepEditing'), onOk: onCancel })
  }
  async function save(values: { comment: string; reason: string }) {
    if (blocked || snapshot.busy) return
    try {
      await workflow.save(values.comment, values.reason)
      if (workflow.active && workflow.getSnapshot().state === 'saved' && !workflow.getSnapshot().refreshFailed) { void message.success(text('saved')); onCancel() }
    } catch (cause) {
      if (workflow.active && (workflow.getSnapshot().state !== 'saved' || cause instanceof ApiError && ['WORKSPACE_CHANGED', 'LOGIN_REQUIRED'].includes(cause.message))) onError(cause)
    }
  }
  async function inspect() {
    try { await workflow.inspect() } catch (cause) { if (workflow.active) onError(cause) }
  }
  return <Modal open width={680} title={text('editReportComment')} onCancel={close} onOk={() => form.submit()} okText={text('save')} cancelText={text('cancel')} closable={!snapshot.busy} keyboard={!snapshot.busy} cancelButtonProps={{ disabled: snapshot.busy }} confirmLoading={snapshot.busy} okButtonProps={{ disabled: blocked || comment.trim() === reportComment(snapshot.record).trim() }} footer={saved ? <Button type="primary" onClick={onCancel} disabled={snapshot.busy}>{text('reportCommentClose')}</Button> : undefined} destroyOnHidden>
    <div className="report-comment-editor">
      <p className="operation-name">{String(record.data.name || '—')}</p>
      {saved ? <><Alert type={snapshot.refreshFailed ? 'warning' : 'success'} showIcon title={text(snapshot.refreshFailed ? 'reportCommentSavedRefreshFailed' : 'reportCommentSaved')} /><p className="preserve-text">{reportComment(snapshot.record) || text('reportCommentEmpty')}</p></> : <>
        {readonly || snapshot.record.archived ? <Alert type="info" showIcon title={text('reportCommentReadOnly')} /> : null}
        {snapshot.error && <Alert type="warning" showIcon title={errorText(snapshot.error, language)} />}
        {(snapshot.state === 'blocked' || snapshot.state === 'inspecting') && snapshot.inspectable && <Alert type="warning" showIcon title={text('reportCommentInspectNotice')} action={<Button size="small" loading={snapshot.busy} onClick={() => void inspect()}>{text('reportCommentInspect')}</Button>} />}
        {snapshot.inspected && <section className="report-comment-inspection"><h3>{text('reportCommentLatest')}</h3><p className="preserve-text">{reportComment(snapshot.inspected) || text('reportCommentEmpty')}</p><Button size="small" disabled={snapshot.busy || snapshot.inspected.archived || readonly} onClick={() => workflow.acceptInspection()}>{text('reportCommentReviewed')}</Button></section>}
        <Form form={form} initialValues={initial} layout="vertical" requiredMark={false} disabled={snapshot.busy || saved} onFinish={values => void save(values)}>
          <Form.Item name="comment" label={text('reportComment')} extra={text('reportCommentSharedNotice')} rules={[{ max: 4000, message: text('reportCommentLength') }]}><Input.TextArea rows={5} maxLength={4000} showCount disabled={snapshot.busy || readonly || snapshot.record.archived} /></Form.Item>
          <Form.Item name="reason" label={text('reason')} rules={[{ required: true, whitespace: true, message: text('required') }, { max: 500 }]}><Input.TextArea rows={2} maxLength={500} disabled={snapshot.busy || readonly || snapshot.record.archived} /></Form.Item>
        </Form>
      </>}
    </div>
  </Modal>
}
