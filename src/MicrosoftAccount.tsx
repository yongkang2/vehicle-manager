import { useEffect, useState } from 'react'
import { Alert, Button, Form, Input, Modal, Space, Spin } from 'antd'
import { api } from './api'
import type { Dictionary } from './i18n'

export default function MicrosoftAccount({ text, bind = false }: { text: Dictionary; bind?: boolean }) {
  const [status, setStatus] = useState<{ configured: boolean; identity: { label: string; verifiedAt: string } | null } | null>(null)
  const [failed, setFailed] = useState(false), [busy, setBusy] = useState(false), [open, setOpen] = useState(false)
  const [error, setError] = useState('')
  const [form] = Form.useForm()
  useEffect(() => {
    const controller = new AbortController()
    void api<typeof status>('/api/microsoft/status', { signal: controller.signal }).then(setStatus).catch(() => { if (!controller.signal.aborted) setFailed(true) })
    return () => controller.abort()
  }, [])
  async function start(password?: string) {
    setBusy(true); setError('')
    try {
      const result = await api<{ url: string }>('/api/microsoft/start', { method: 'POST', body: { mode: bind ? 'bind' : 'login', password } })
      const url = new URL(result.url)
      if (url.origin !== 'https://login.microsoftonline.com') throw new Error('Invalid authorization URL')
      window.location.assign(url.href)
    } catch { setError(text.microsoftStartFailed); setBusy(false) }
  }
  return <Space orientation="vertical" style={{ width: '100%' }}>
    {!status && !failed && <Spin size="small" />}
    {failed && <Alert type="warning" showIcon title={text.microsoftStatusFailed} />}
    {status && !status.configured && <Alert type="info" showIcon title={text.microsoftNotConfigured} />}
    {status?.identity ? <Alert type="success" showIcon title={status.identity.label} description={`${text.microsoftVerified}: ${new Date(status.identity.verifiedAt).toLocaleString()}`} /> : <Button block disabled={!status?.configured || busy} loading={busy} onClick={() => bind ? setOpen(true) : void start()}>{bind ? text.microsoftBind : text.microsoftLogin}</Button>}
    {!open && error && <Alert type="error" showIcon title={error} />}
    <Modal title={text.microsoftBind} open={open} onCancel={() => { if (!busy) { setOpen(false); form.resetFields(); setError('') } }} destroyOnHidden okText={text.microsoftContinue} cancelText={text.cancel} confirmLoading={busy} cancelButtonProps={{ disabled: busy }} closable={!busy} maskClosable={!busy} onOk={() => form.submit()}>
      <p>{text.microsoftBindingHelp}</p>
      <Form form={form} layout="vertical" onFinish={(values: { password: string }) => void start(values.password)}>
        <Form.Item label={text.password} name="password" rules={[{ required: true, message: text.required }]}><Input.Password autoComplete="current-password" maxLength={128} disabled={busy} /></Form.Item>
      </Form>
      {error && <Alert type="error" showIcon title={error} />}
    </Modal>
  </Space>
}

export function MicrosoftResult({ text }: { text: Dictionary }) {
  const [result] = useState(() => new URLSearchParams(window.location.search).get('microsoft'))
  useEffect(() => {
    if (!result) return
    const url = new URL(window.location.href)
    url.searchParams.delete('microsoft')
    window.history.replaceState(null, '', url.href)
  }, [result])
  if (!result) return null
  return <Alert closable showIcon type={result === 'success' ? 'success' : 'warning'} title={result === 'success' ? text.microsoftSuccess : result === 'unbound' ? text.microsoftUnbound : text.microsoftFailed} />
}
