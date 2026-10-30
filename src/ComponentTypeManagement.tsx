import { useEffect, useEffectEvent, useRef, useState } from 'react'
import { Alert, Button, Checkbox, Form, Input, Modal, Space, Table, Tag } from 'antd'
import { Layers, Pencil, Plus } from 'lucide-react'
import type { ComponentTypeCatalog, ComponentTypeDefinition } from '../shared/configuration-revisions'
import { ApiError, createWorkspaceScope } from './api'
import { translateBusiness } from './business-i18n'
import type { Language } from './i18n'

type Scope = ReturnType<typeof createWorkspaceScope>
export type ComponentTypeManagementProps = { language: Language; online: boolean; syncPaused: boolean; catalog: ComponentTypeCatalog; onChanged: (scope: Scope, signal: AbortSignal) => Promise<void>; onBusyChange: (busy: boolean) => void; onError: (error: unknown) => void }
type Editor = { type: ComponentTypeDefinition | null; requestId: string; submitted?: unknown }

export default function ComponentTypeManagement({ language, online, syncPaused, catalog, onChanged, onBusyChange, onError }: ComponentTypeManagementProps) {
  const text = translateBusiness(language), at = language === 'zh' ? 1 : 0
  const [scope] = useState(createWorkspaceScope), controller = useRef(new AbortController()), [form] = Form.useForm()
  const active = useRef(true), admitted = useRef(false)
  const [open, setOpen] = useState(false), [editor, setEditor] = useState<Editor | null>(null), [saving, setSaving] = useState(false), [activationReason, setActivationReason] = useState('')
  const [activationId] = useState(() => crypto.randomUUID())
  const enabled = online && !syncPaused
  const finishBusy = useEffectEvent(() => { if (admitted.current) { admitted.current = false; onBusyChange(false) } })
  useEffect(() => { active.current = true; if (controller.current.signal.aborted) controller.current = new AbortController(); const current = controller.current; return () => { active.current = false; current.abort(); finishBusy() } }, [])
  useEffect(() => { if (editor && !editor.submitted) { form.resetFields(); form.setFieldsValue({ name: editor.type?.name || '', description: editor.type?.description || '', disabled: editor.type?.disabled || false, reason: '' }) } }, [editor, form])
  async function write(url: string, method: string, body: unknown) {
    if (!enabled || saving) return false
    setSaving(true); admitted.current = true; onBusyChange(true)
    try { await scope.request(url, { method, body, signal: controller.current.signal }); scope.assertCurrent(controller.current.signal); await onChanged(scope, controller.current.signal); return active.current }
    catch (cause) {
      if (active.current && !controller.current.signal.aborted && cause instanceof Error && ['NETWORK_ERROR', 'SERVER_ERROR', 'SHARE_IO_ERROR', 'LOCAL_REFRESH_REQUIRED'].includes(cause.message)) setEditor(previous => previous ? { ...previous, submitted: body } : previous)
      if (active.current && !controller.current.signal.aborted && cause instanceof ApiError && cause.message === 'VERSION_CONFLICT') {
        try { await onChanged(scope, controller.current.signal); if (active.current) setEditor(null) }
        catch (refreshError) { if (active.current && !controller.current.signal.aborted) onError(refreshError) }
      }
      if (active.current && !controller.current.signal.aborted && !(cause instanceof ApiError && cause.message === 'WORKSPACE_CHANGED')) onError(cause)
      return false
    }
    finally { admitted.current = false; if (active.current) { setSaving(false); onBusyChange(false) } }
  }
  async function activate() { await write('/api/business/configuration-revisions/enable', 'POST', { reason: activationReason.trim(), requestId: activationId }) }
  async function save(values: { name: string; description: string; disabled: boolean; reason: string }) {
    if (!editor) return
    if (await write(editor.type ? `/api/business/component-types/${encodeURIComponent(editor.type.id)}` : '/api/business/component-types', editor.type ? 'PUT' : 'POST', editor.submitted || { ...values, requestId: editor.requestId, ...(editor.type ? { version: editor.type.version } : {}) })) setEditor(null)
  }
  return <>
    <Button icon={<Layers size={15} />} onClick={() => setOpen(true)}>{text('componentTypes')}</Button>
    <Modal open={open} width={850} title={text('componentTypes')} onCancel={() => { if (!saving) setOpen(false) }} footer={<Button disabled={saving} onClick={() => setOpen(false)}>{text('vehicleTableColumnsClose')}</Button>} destroyOnHidden>
      <p>{text('componentTypeNotice')}</p>
      {!catalog.enabled && <div className="configuration-review"><Alert type="warning" showIcon title={text('configurationActivationNotice')} /><label className="configuration-input-label">{text('configurationActivationReason')}<Input.TextArea value={activationReason} rows={2} maxLength={500} disabled={!enabled || saving} onChange={event => setActivationReason(event.target.value)} /></label><Button type="primary" disabled={!enabled || saving || !activationReason.trim()} loading={saving} onClick={() => void activate()}>{text('activateConfigurationRevisions')}</Button></div>}
      {!enabled && <Alert type="info" showIcon title={text('configurationOfflineNotice')} />}
      <Space className="configuration-revision-toolbar"><Button icon={<Plus size={15} />} disabled={!enabled || !catalog.enabled || saving} onClick={() => setEditor({ type: null, requestId: crypto.randomUUID() })}>{text('addComponentType')}</Button></Space>
      <Table<ComponentTypeDefinition> rowKey="id" dataSource={catalog.types} size="small" pagination={false} scroll={{ x: 550 }} columns={[
        { title: text('componentTypeName'), width: 190, render: (_, row) => row.label[at] }, { title: text('componentTypeDescription'), dataIndex: 'description', width: 240 },
        { title: text('status'), width: 150, render: (_, row) => <Tag>{text(row.pendingRestore ? 'componentTypePendingRestore' : row.builtin ? 'componentTypeBuiltin' : row.disabled ? 'componentTypeDisabled' : 'available')}</Tag> },
        { title: text('actions'), width: 80, render: (_, row) => !row.builtin && <Button size="small" icon={<Pencil size={14} />} aria-label={`${text('edit')}: ${row.name}`} disabled={!enabled || saving || row.pendingRestore} onClick={() => setEditor({ type: row, requestId: crypto.randomUUID() })} /> },
      ]} />
    </Modal>
    <Modal open={Boolean(editor)} width={650} title={text(editor?.type ? 'edit' : 'addComponentType')} onCancel={() => { if (!saving) setEditor(null) }} onOk={() => form.submit()} okText={text('save')} cancelText={text('cancel')} confirmLoading={saving} destroyOnHidden>
      {Boolean(editor?.submitted) && <Alert type="warning" showIcon title={text('componentTypeSaveUnknown')} />}
      <Form form={form} layout="vertical" requiredMark={false} disabled={saving || Boolean(editor?.submitted)} onFinish={values => void save(values)}>
        <Form.Item name="name" label={text('componentTypeName')} rules={[{ required: true, whitespace: true, message: text('required') }]}><Input maxLength={120} /></Form.Item>
        <Form.Item name="description" label={text('componentTypeDescription')}><Input.TextArea maxLength={4000} rows={2} /></Form.Item>
        <Form.Item name="disabled" valuePropName="checked"><Checkbox>{text('componentTypeDisabled')}</Checkbox></Form.Item>
        <Form.Item name="reason" label={text('reason')} rules={[{ required: true, whitespace: true, message: text('required') }]}><Input.TextArea maxLength={500} rows={2} /></Form.Item>
      </Form>
    </Modal>
  </>
}
