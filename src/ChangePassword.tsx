import { useState } from 'react'
import { Alert, Button, Form, Input, Modal } from 'antd'
import { api, ApiError } from './api'
import type { Dictionary } from './i18n'

export default function ChangePassword({ text, onChanged }: { text: Dictionary; onChanged: () => void }) {
  const [open, setOpen] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState('')
  const [form] = Form.useForm()
  function close() { if (!busy) { setOpen(false); form.resetFields(); setError('') } }
  async function save(values: { currentPassword: string; newPassword: string }) {
    setBusy(true); setError('')
    try {
      await api('/api/account/password', { method: 'POST', body: { currentPassword: values.currentPassword, newPassword: values.newPassword } })
      form.resetFields(); setOpen(false); onChanged()
    } catch (e) { setError(e instanceof ApiError && e.message === 'INVALID_CREDENTIALS' ? text.oldPasswordWrong : e instanceof ApiError && e.message === 'WORKSPACE_BUSY' ? text.passwordBusy : e instanceof ApiError && e.message === 'INVALID_PASSWORD' ? text.passwordHint : text.passwordUncertain) }
    finally { setBusy(false) }
  }
  return <><Button onClick={() => setOpen(true)}>{text.changePassword}</Button><Modal open={open} title={text.changePassword} onCancel={close} confirmLoading={busy} closable={!busy} maskClosable={!busy} cancelButtonProps={{ disabled: busy }} okText={text.changePassword} cancelText={text.cancel} onOk={() => form.submit()}>
    <Alert showIcon type="warning" title={text.passwordExitWarning} />
    <Form form={form} layout="vertical" onFinish={save} requiredMark={false} style={{ marginTop: 16 }}>
      <Form.Item name="currentPassword" label={text.oldPassword} rules={[{ required: true, message: text.required }]}><Input.Password autoComplete="current-password" maxLength={128} disabled={busy} /></Form.Item>
      <Form.Item name="newPassword" label={text.newPassword} rules={[{ required: true, message: text.required }, { min: 10, max: 128, message: text.passwordHint }, ({getFieldValue}) => ({ validator(_, value) { return !value || value !== getFieldValue('currentPassword') ? Promise.resolve() : Promise.reject(new Error(text.passwordDifferent)) } })]}><Input.Password autoComplete="new-password" maxLength={128} disabled={busy} /></Form.Item>
      <Form.Item name="confirmation" label={text.confirmPassword} dependencies={['newPassword']} rules={[{ required: true, message: text.required }, ({getFieldValue}) => ({ validator(_, value) { return !value || value === getFieldValue('newPassword') ? Promise.resolve() : Promise.reject(new Error(text.passwordMismatch)) } })]}><Input.Password autoComplete="new-password" maxLength={128} disabled={busy} /></Form.Item>
    </Form>{error && <Alert type="error" showIcon title={error} />}
  </Modal></>
}
