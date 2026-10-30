import { useEffect, useEffectEvent, useRef, useState } from 'react'
import { Alert, Button, Descriptions, Form, Input, Modal, Space, Table, Tag } from 'antd'
import { Pencil, Plus, RefreshCw, Wrench } from 'lucide-react'
import type { BusinessRecord, Fields } from '../shared/business'
import { thermalSystemTypes } from '../shared/business'
import type { ComponentTypeCatalog } from '../shared/configuration-revisions'
import { ApiError, createWorkspaceScope } from './api'
import { translateBusiness } from './business-i18n'
import type { Language } from './i18n'

type Scope = ReturnType<typeof createWorkspaceScope>
export type ComponentSectionsProps = {
  vehicle: BusinessRecord; records: BusinessRecord[]; typeId: string; language: Language; catalog: ComponentTypeCatalog; disabled?: boolean; includeArchived?: boolean
  onChanged: (scope: Scope, signal: AbortSignal) => Promise<void>; onBusyChange: (busy: boolean) => void; onError: (error: unknown) => void; onEditThermal?: () => void
}
type Editor = { record: BusinessRecord | null; removal: boolean }
const value = (item: unknown) => item === undefined || item === null || item === '' ? '—' : String(item)

export default function ComponentSections({ vehicle, records, typeId, language, catalog, disabled = false, includeArchived = false, onChanged, onBusyChange, onError, onEditThermal }: ComponentSectionsProps) {
  const text = translateBusiness(language), at = language === 'zh' ? 1 : 0, type = catalog.types.find(item => item.id === typeId)
  const [scope] = useState(createWorkspaceScope), controller = useRef(new AbortController()), [form] = Form.useForm()
  const active = useRef(true), admitted = useRef(false)
  const [editor, setEditor] = useState<Editor | null>(null), [saving, setSaving] = useState(false), [unknown, setUnknown] = useState(false)
  const finishBusy = useEffectEvent(() => { if (admitted.current) { admitted.current = false; onBusyChange(false) } })
  useEffect(() => { active.current = true; if (controller.current.signal.aborted) controller.current = new AbortController(); const current = controller.current; return () => { active.current = false; current.abort(); finishBusy() } }, [])
  useEffect(() => {
    if (!editor) return
    form.resetFields(); form.setFieldsValue({ ...editor.record?.data, removedAt: new Date().toISOString().slice(0, 10), reason: '' })
  }, [editor, form])
  if (!type) return null
  const items = records.filter(record => record.kind === 'part' && record.vehicleId === vehicle.id && (typeId === 'emotor' ? record.data.category === 'motor' : record.data.category === 'component' && record.data.componentTypeId === typeId) && (includeArchived || !record.archived))
  const fields = type.fields
  const locked = disabled || vehicle.archived || saving
  async function save(values: Fields) {
    if (!editor || !type || locked || unknown) return
    const { reason, removedAt, ...valuesData } = values
    const record = editor.record
    const data: Fields = editor.removal ? { ...record!.data, removedAt } : {
      ...record?.data, ...valuesData, category: typeId === 'emotor' ? 'motor' : 'component', componentTypeId: typeId === 'emotor' ? '' : typeId,
      name: typeId === 'emotor' ? record?.data.name || type.name : valuesData.name,
    }
    setSaving(true); admitted.current = true; onBusyChange(true)
    try {
      await scope.request(record ? `/api/business/records/${encodeURIComponent(record.id)}` : '/api/business/records', { method: record ? 'PUT' : 'POST', body: { kind: 'part', vehicleId: vehicle.id, data, reason, ...(record ? { version: record.version } : {}) }, signal: controller.current.signal })
      scope.assertCurrent(controller.current.signal); await onChanged(scope, controller.current.signal)
      if (active.current) setEditor(null)
    } catch (cause) {
      if (!active.current || controller.current.signal.aborted || cause instanceof ApiError && cause.message === 'WORKSPACE_CHANGED') return
      if (!record && cause instanceof Error && ['NETWORK_ERROR', 'SERVER_ERROR', 'SHARE_IO_ERROR'].includes(cause.message)) setUnknown(true)
      onError(cause)
    } finally { admitted.current = false; if (active.current) { setSaving(false); onBusyChange(false) } }
  }
  async function inspectSaved() {
    setSaving(true); admitted.current = true; onBusyChange(true)
    try { await onChanged(scope, controller.current.signal); if (active.current) setEditor(null) }
    catch (cause) { if (active.current && !controller.current.signal.aborted) onError(cause) }
    finally { admitted.current = false; if (active.current) { setSaving(false); onBusyChange(false) } }
  }
  return <div className="component-section">
    {!catalog.enabled && <Alert type="info" showIcon title={text('configurationDisabledNotice')} />}
    {type.disabled && <Alert type="info" showIcon title={text('componentTypeDisabled')} description={text('componentTypeNotice')} />}
    {typeId === 'thermal-management' && <Descriptions size="small" column={1} items={[{ key: 'thermal', label: text('thermal'), children: <Space wrap><span>{thermalSystemTypes.some(item => item === vehicle.data.thermal) ? text(String(vehicle.data.thermal)) : value(vehicle.data.thermal)}</span>{onEditThermal && <Button size="small" icon={<Pencil size={13} />} disabled={locked} onClick={onEditThermal}>{text('edit')}</Button>}</Space> }]} />}
    <div className="section-toolbar"><h3>{type.label[at]}</h3><Button icon={<Plus size={15} />} disabled={locked || type.disabled || !catalog.enabled} onClick={() => { setUnknown(false); setEditor({ record: null, removal: false }) }}>{text('addComponent')}</Button></div>
    <Table<BusinessRecord> rowKey="id" size="small" dataSource={items} scroll={{ x: Math.max(700, fields.length * 170 + 220) }} pagination={{ pageSize: 8, hideOnSinglePage: true }} locale={{ emptyText: text('componentNone') }} columns={[
      ...fields.map(field => ({ key: field.id, title: field.label[at], width: field.id === 'notes' ? 230 : 170, ellipsis: { showTitle: true }, render: (_: unknown, record: BusinessRecord) => <span title={value(record.data[field.id])}>{value(record.data[field.id])}</span> })),
      { key: 'state', title: text('status'), width: 135, render: (_, record) => <Tag>{record.archived ? text('archived') : record.data.removedAt ? `${text('removed')} · ${record.data.removedAt}` : text('installed')}</Tag> },
      { key: 'actions', title: text('actions'), width: 110, render: (_, record) => <Space><Button size="small" icon={<Pencil size={14} />} aria-label={`${text('editComponent')}: ${value(record.data.name)}`} disabled={locked || record.archived} onClick={() => { setUnknown(false); setEditor({ record, removal: false }) }} />{!record.data.removedAt && <Button size="small" icon={<Wrench size={14} />} aria-label={`${text('removeComponent')}: ${value(record.data.name)}`} disabled={locked || record.archived} onClick={() => { setUnknown(false); setEditor({ record, removal: true }) }} />}</Space> },
    ]} />
    <Modal open={Boolean(editor)} title={`${text(editor?.removal ? 'removeComponent' : editor?.record ? 'editComponent' : 'addComponent')} · ${type.label[at]}`} width={760} onCancel={() => { if (!saving) setEditor(null) }} onOk={() => form.submit()} okText={text('save')} cancelText={text('cancel')} confirmLoading={saving} okButtonProps={{ disabled: unknown }} destroyOnHidden>
      {unknown && <Alert type="warning" showIcon title={text('componentSaveUnknown')} action={<Button size="small" icon={<RefreshCw size={14} />} onClick={() => void inspectSaved()}>{text('refresh')}</Button>} />}
      <Form form={form} layout="vertical" requiredMark={false} disabled={saving || unknown} onFinish={values => void save(values)}><div className="record-form-grid">{editor?.removal ? <Form.Item name="removedAt" label={text('componentRemovedAt')} rules={[{ required: true, message: text('required') }]}><Input type="date" /></Form.Item> : fields.map(field => <Form.Item key={field.id} name={field.id} label={field.label[at]} className={field.id === 'notes' ? 'wide-field' : undefined} rules={[{ required: field.id === 'name', whitespace: field.id === 'name', message: text('required') }]}>{field.id === 'notes' ? <Input.TextArea rows={3} maxLength={4000} /> : <Input maxLength={field.id === 'name' ? 120 : 4000} />}</Form.Item>)}<Form.Item name="reason" label={text('reason')} className="wide-field" rules={[{ required: true, whitespace: true, message: text('required') }]}><Input.TextArea rows={2} maxLength={500} /></Form.Item></div></Form>
    </Modal>
  </div>
}
