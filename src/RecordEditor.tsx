import { useEffect } from 'react'
import { AutoComplete, Form, Input, Modal, Select } from 'antd'
import { entryFields, partFields, vehicleFields } from '../shared/business'
import type { BusinessRecord, Fields, RecordKind } from '../shared/business'
import type { Language } from './i18n'
import { translateBusiness } from './business-i18n'

export default function RecordEditor({ record, kind, language, busy, onCancel, onSave }: { record: BusinessRecord | null; kind: RecordKind; language: Language; busy: boolean; onCancel: () => void; onSave: (data: Fields, reason: string) => void }) {
  const [form] = Form.useForm()
  const category = Form.useWatch('category', form) || 'controller', text = translateBusiness(language)
  useEffect(() => { form.resetFields(); form.setFieldsValue({ status: 'available', category: 'controller', ...record?.data, reason: '' }) }, [form, record, kind])
  const names = kind === 'vehicle' ? [...vehicleFields] : kind === 'part' ? partFields.filter(field => !(['hardware', 'software', 'functionalPart', 'productPart', 'calibrationPart', 'calibrationVersion', 'type'].includes(field) && category !== 'controller') && !(['maturity', 'batteryStatus'].includes(field) && category !== 'battery')) : [...entryFields]
  const suggestions: Record<string, string[]> = { project: ['eP64', 'eP74', 'D85', 'OV64'], supplier: ['in house', 'CATL'], maturity: ['Production', 'POC'], type: ['Production', 'ETK'], coolingArchitecture: ['INDIRECT HEAT PUMP', 'WITHOUT HEAT PUMP'] }
  return <Modal open width={800} title={`${text(record ? 'edit' : 'addEntry')} · ${text(kind)}`} onCancel={onCancel} onOk={() => form.submit()} okText={text('save')} cancelText={text('cancel')} confirmLoading={busy} destroyOnHidden>
    <Form name="business-record" form={form} layout="vertical" requiredMark={false} onFinish={values => { const { reason, ...data } = values; onSave(data, reason) }}><div className="record-form-grid">{names.map(field => <Form.Item key={field} name={field} label={text(field)} className={['notes', 'description'].includes(field) ? 'wide-field' : ''} rules={[{ required: ['name', 'vin', 'status', 'category'].includes(field), whitespace: field === 'name', message: text('required') }]}>
      {field === 'status' ? <Select options={['available', 'testing', 'maintenance', 'inactive'].map(value => ({ value, label: text(value) }))} /> : field === 'category' ? <Select disabled={Boolean(record)} options={['controller', 'motor', 'battery'].map(value => ({ value, label: text(value) }))} /> : ['notes', 'description', 'thermal'].includes(field) ? <Input.TextArea rows={2} maxLength={4000} /> : suggestions[field] ? <AutoComplete options={suggestions[field].map(value => ({ value }))} maxLength={4000} /> : <Input type={['plateExpiry', 'installedAt', 'removedAt'].includes(field) ? 'date' : 'text'} maxLength={field === 'vin' ? 30 : field === 'name' ? 120 : 4000} />}
    </Form.Item>)}<Form.Item name="reason" label={text('reason')} className="wide-field" rules={[{ required: true, whitespace: true, message: text('required') }]}><Input.TextArea maxLength={500} rows={2} /></Form.Item></div></Form>
  </Modal>
}