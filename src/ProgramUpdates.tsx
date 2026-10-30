import { useEffect, useState } from 'react'
import { Alert, Badge, Button, Checkbox, Modal, Space, Spin, Tag } from 'antd'
import { Download, ExternalLink, RefreshCw, RotateCw } from 'lucide-react'
import type { ApplicationUpdateStatus } from '../shared/application-updates'
import type { Language } from './i18n'
import { errorText } from './i18n'
import { api, ApiError } from './api'

export default function ProgramUpdates({ language, open, onOpenChange }: { language: Language; open: boolean; onOpenChange: (open: boolean) => void }) {
  const zh = language === 'zh'
  const [status, setStatus] = useState<ApplicationUpdateStatus | null>(null)
  const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null), [confirmed, setConfirmed] = useState(false)
  useEffect(() => {
    let live = true
    void api<ApplicationUpdateStatus>('/api/updates').then(async value => {
      if (!live) return
      setStatus(value)
      if (value.supported) {
        const checked = await api<ApplicationUpdateStatus>('/api/updates/check', { method: 'POST' })
        if (live) setStatus(checked)
      }
    }).catch(failure => { if (live) setError(failure instanceof ApiError ? failure.message : 'SERVER_ERROR') })
    return () => { live = false }
  }, [])
  async function act(command: 'check' | 'download' | 'install') {
    setBusy(true); setError(null)
    try { setStatus(await api<ApplicationUpdateStatus>(`/api/updates/${command}`, { method: 'POST', body: command === 'install' ? { confirmed } : undefined })) }
    catch (failure) { setError(failure instanceof ApiError ? failure.message : 'SERVER_ERROR') }
    finally { setBusy(false) }
  }
  const restarting = status?.phase === 'restarting'
  const title = zh ? '程序更新' : 'Program updates'
  return <><Button type="text" icon={<Download size={17} />} onClick={() => onOpenChange(true)}><Badge dot={Boolean(status?.availableVersion)} offset={[7, 0]}>{title}</Badge></Button>
    <Modal title={title} open={open} onCancel={() => { if (!busy && !restarting) onOpenChange(false) }} footer={null} closable={!busy && !restarting} maskClosable={!busy && !restarting} width={480}>
      <Space orientation="vertical" size="middle" style={{ width: '100%' }}>
        {!status && !error && <Spin />}
        {status?.channel === 'pre' && <Tag color="warning">{zh ? '预发布通道' : 'Pre-release channel'}</Tag>}
        {status && <div>{zh ? '当前版本' : 'Current version'}: <strong>{status.currentVersion}</strong></div>}
        {error && <Alert type="error" showIcon title={errorText(error, language)} />}
        {status && !status.supported && <Alert type="info" showIcon title={zh ? '请从固定启动器打开程序后再检查更新。原账号和数据目录保持不变。' : 'Open this application through the stable launcher to enable updates. Accounts and data stay in their existing directory.'} />}
        {status?.supported && !restarting && <>
          <div>{zh ? '可用版本' : 'Available version'}: <strong>{status.availableVersion || status.downloadedVersion || (zh ? '未发现新版' : 'No newer version found')}</strong></div>
          <Button icon={<RefreshCw size={16} />} loading={busy} onClick={() => void act('check')}>{zh ? '检查更新' : 'Check for updates'}</Button>
          {status.availableVersion && status.availableVersion !== status.downloadedVersion && <Button type="primary" icon={<Download size={16} />} loading={busy} onClick={() => void act('download')}>{zh ? '下载新版' : 'Download update'}</Button>}
          {status.downloadedVersion && <>
            <Alert type="warning" showIcon title={zh ? '安装前将停止本机服务并备份全部本机数据。备份包含账号信息，仅保存在本机；失败记录可在 launcher.log 查看。' : 'Installation stops this local service and backs up all local data, including account information. Backups stay on this PC. Failures are recorded in launcher.log.'} />
            <Checkbox checked={confirmed} disabled={busy} onChange={event => setConfirmed(event.target.checked)}>{zh ? '已保存所有应用标签页的内容，确认备份并重启' : 'All application tabs are saved. Back up and restart.'}</Checkbox>
            <Button type="primary" icon={<RotateCw size={16} />} loading={busy} disabled={!confirmed} onClick={() => void act('install')}>{zh ? '备份并安装' : 'Back up and install'}</Button>
          </>}
        </>}
        {restarting && <Alert type="info" showIcon title={zh ? '正在停止服务、备份和安装。完成后将自动打开浏览器，请勿启动旧程序。' : 'Stopping, backing up and installing. The browser will reopen when ready. Do not start the old version.'} />}
        <Button type="link" href="https://github.com/yongkang2/vehicle-manager/releases" target="_blank" rel="noreferrer" icon={<ExternalLink size={16} />}>{zh ? 'GitHub 发布版本' : 'GitHub releases'}</Button>
      </Space>
    </Modal></>
}