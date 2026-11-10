import { useEffect, useEffectEvent, useRef, useState } from 'react'
import { Alert, Button, Checkbox, Form, Input, Modal, Space, Table, Tag } from 'antd'
import { Layers, Pencil, Plus } from 'lucide-react'
import type { ComponentTypeCatalog, ComponentTypeDefinition } from '../shared/configuration-revisions'
import { ApiError, createWorkspaceScope } from './api'
import { translateBusiness } from './business-i18n'
import type { Language } from './i18n'
import { componentPolicyActionState, componentPolicyStatus, visibleComponentTypes } from './component-review-policy'

type Scope = ReturnType<typeof createWorkspaceScope>
export type ComponentTypeManagementProps = { language: Language; online: boolean; syncPaused: boolean; catalog: ComponentTypeCatalog; onChanged: (scope: Scope, signal: AbortSignal) => Promise<void>; onBusyChange: (busy: boolean) => void; onError: (error: unknown) => void }
type PolicyAction = 'disable' | 'remove' | 'enable' | 'restore'
type Editor = { type: ComponentTypeDefinition | null; action?: PolicyAction; requestId: string; submitted?: unknown }

export default function ComponentTypeManagement({ language, online, syncPaused, catalog, onChanged, onBusyChange, onError }: ComponentTypeManagementProps) {
  const text = translateBusiness(language), at = language === 'zh' ? 1 : 0
  const [scope] = useState(createWorkspaceScope), controller = useRef(new AbortController()), [form] = Form.useForm()
  const active = useRef(true), admitted = useRef(false)
  const [open, setOpen] = useState(false), [editor, setEditor] = useState<Editor | null>(null), [saving, setSaving] = useState(false), [activationReason, setActivationReason] = useState(''), [showRemoved, setShowRemoved] = useState(false)
  const [activationId] = useState(() => crypto.randomUUID())
  const enabled = online && !syncPaused, editable = enabled && catalog.enabled && !saving
  const finishBusy = useEffectEvent(() => { if (admitted.current) { admitted.current = false; onBusyChange(false) } })
  useEffect(() => { active.current = true; if (controller.current.signal.aborted) controller.current = new AbortController(); const current = controller.current; return () => { active.current = false; current.abort(); finishBusy() } }, [])
  useEffect(() => { if (editor && !editor.submitted) { form.resetFields(); form.setFieldsValue({ name: editor.type?.name || '', description: editor.type?.description || '', reason: '' }) } }, [editor, form])
  async function write(url: string, method: string, body: unknown) {
    if (!enabled || saving) return false
    setSaving(true); admitted.current = true; onBusyChange(true)
    try { await scope.request(url, { method, body, signal: controller.current.signal }); scope.assertCurrent(controller.current.signal); await onChanged(scope, controller.current.signal); return active.current }
    catch (cause) {
      if (active.current && !controller.current.signal.aborted && cause instanceof Error && ['NETWORK_ERROR', 'SERVER_ERROR', 'SHARE_IO_ERROR', 'SHARE_LOCK_LOST', 'LOCAL_REFRESH_REQUIRED'].includes(cause.message)) setEditor(previous => previous ? { ...previous, submitted: body } : previous)
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
  async function save(values: { name: string; description: string; reason: string }) {
    if (!editor) return
    const type = editor.type
    const body = editor.submitted || {
      name: editor.action ? type!.name : values.name, description: editor.action ? type!.description : values.description, reason: values.reason, requestId: editor.requestId,
      ...(type ? { version: type.version, ...(editor.action ? { reviewState: componentPolicyActionState(editor.action) } : catalog.policyEnabled ? { reviewState: componentPolicyStatus(type) } : { disabled: type.disabled }) } : {}),
    }
    if (await write(type ? `/api/business/component-types/${encodeURIComponent(type.id)}` : '/api/business/component-types', type ? 'PUT' : 'POST', body)) setEditor(null)
  }
  const actionLabel = (action: PolicyAction) => text(`componentTypeAction${action[0].toUpperCase()}${action.slice(1)}`)
  const beginAction = (type: ComponentTypeDefinition, action: PolicyAction) => setEditor({ type, action, requestId: crypto.randomUUID() })
  const actions = (type: ComponentTypeDefinition) => {
    const state = componentPolicyStatus(type), locked = !editable || type.pendingRestore
    return <Space wrap>
      {!type.builtin && state !== 'removed' && <Button size="small" icon={<Pencil size={14} />} aria-label={`${text('edit')}: ${type.name}`} disabled={locked} onClick={() => setEditor({ type, requestId: crypto.randomUUID() })}>{text('edit')}</Button>}
      {state === 'active' && <Button size="small" disabled={locked} onClick={() => beginAction(type, 'disable')}>{actionLabel('disable')}</Button>}
      {state === 'disabled' && <Button size="small" disabled={locked} onClick={() => beginAction(type, 'enable')}>{actionLabel('enable')}</Button>}
      {state !== 'removed' && <Button size="small" danger disabled={locked} onClick={() => beginAction(type, 'remove')}>{actionLabel('remove')}</Button>}
      {state === 'removed' && <Button size="small" disabled={locked} onClick={() => beginAction(type, 'restore')}>{actionLabel('restore')}</Button>}
    </Space>
  }
  return <>
    <Button type="text" size="small" icon={<Layers size={15} />} onClick={() => setOpen(true)}>{text('componentTypes')}</Button>
    <Modal open={open} className="component-type-management-modal" width={1000} title={text('componentTypes')} onCancel={() => { if (!saving) setOpen(false) }} footer={<Button disabled={saving} onClick={() => setOpen(false)}>{text('vehicleTableColumnsClose')}</Button>} destroyOnHidden>
      <p>{text('componentTypesTeamScope')}</p><p>{text('componentTypeNotice')}</p>
      {!catalog.enabled && <div className="configuration-review"><Alert type="warning" showIcon title={text('configurationActivationNotice')} /><label className="configuration-input-label">{text('configurationActivationReason')}<Input.TextArea value={activationReason} rows={2} maxLength={500} disabled={!enabled || saving} onChange={event => setActivationReason(event.target.value)} /></label><Button type="primary" disabled={!enabled || saving || !activationReason.trim()} loading={saving} onClick={() => void activate()}>{text('activateConfigurationRevisions')}</Button></div>}
      {!enabled && <Alert type="info" showIcon title={text('configurationOfflineNotice')} />}
      <Space wrap className="configuration-revision-toolbar"><Button type="primary" icon={<Plus size={15} />} disabled={!editable} onClick={() => setEditor({ type: null, requestId: crypto.randomUUID() })}>{text('addComponentType')}</Button><Checkbox checked={showRemoved} onChange={event => setShowRemoved(event.target.checked)}>{text('componentTypeShowRemoved')}</Checkbox></Space>
      <Table<ComponentTypeDefinition> rowKey="id" dataSource={visibleComponentTypes(catalog.types, showRemoved)} size="small" pagination={false} scroll={{ x: 850 }} columns={[
        { title: text('componentTypeName'), width: 190, render: (_, row) => <Space wrap>{row.label[at]}{row.builtin && <Tag>{text('componentTypeBuiltin')}</Tag>}</Space> }, { title: text('componentTypeDescription'), dataIndex: 'description', width: 230 },
        { title: text('componentTypeConfigurationStatus'), width: 160, render: (_, row) => <Tag color={row.pendingRestore ? undefined : componentPolicyStatus(row) === 'active' ? 'green' : undefined}>{text(row.pendingRestore ? 'componentTypePendingRestore' : `componentTypeState${componentPolicyStatus(row)[0].toUpperCase()}${componentPolicyStatus(row).slice(1)}`)}</Tag> },
        { title: text('actions'), width: 270, render: (_, row) => actions(row) },
      ]} />
    </Modal>
    <Modal open={Boolean(editor)} className="component-type-policy-modal" width={650} title={editor?.action ? `${actionLabel(editor.action)} · ${editor.type?.label[at]}` : text(editor?.type ? 'edit' : 'addComponentType')} onCancel={() => { if (!saving) setEditor(null) }} onOk={() => form.submit()} okText={editor?.action ? actionLabel(editor.action) : text('save')} cancelText={text('cancel')} confirmLoading={saving} okButtonProps={{ danger: editor?.action === 'remove' || editor?.action === 'disable' }} destroyOnHidden>
      {Boolean(editor?.submitted) && <Alert type="warning" showIcon title={text('componentTypeSaveUnknown')} />}
      {editor?.action && <Alert type={editor.action === 'disable' || editor.action === 'remove' ? 'warning' : 'info'} showIcon title={text('componentTypePolicyEffect')} />}
      {editor?.action && !catalog.policyEnabled && <Alert type="warning" showIcon title={text('componentTypePolicyUpgrade')} />}
      <Form form={form} layout="vertical" requiredMark={false} disabled={saving || Boolean(editor?.submitted)} onFinish={values => void save(values)}>
        {!editor?.action && <><Form.Item name="name" label={text('componentTypeName')} rules={[{ required: true, whitespace: true, message: text('required') }]}><Input maxLength={120} /></Form.Item><Form.Item name="description" label={text('componentTypeDescription')}><Input.TextArea maxLength={4000} rows={2} /></Form.Item></>}
        <Form.Item name="reason" label={text('reason')} rules={[{ required: true, whitespace: true, message: text('required') }]}><Input.TextArea maxLength={500} rows={2} /></Form.Item>
      </Form>
    </Modal>
  </>
}
