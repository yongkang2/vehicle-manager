import { Alert, Button, Modal, Space } from 'antd'
import { Download, ExternalLink } from 'lucide-react'
import { appVersion } from '../shared/version'
import type { Language } from './i18n'

export default function ProgramUpdates({ language, open, onOpenChange }: { language: Language; open: boolean; onOpenChange: (open: boolean) => void }) {
  const zh = language === 'zh'
  return <Modal title={zh ? '版本与下载' : 'Version and downloads'} open={open} onCancel={() => onOpenChange(false)} footer={null} width={480}>
      <Space orientation="vertical" size="middle" style={{ width: '100%' }}>
        <div>{zh ? '当前版本' : 'Current version'}: <strong>{appVersion}</strong></div>
        <Alert type="info" showIcon title={zh ? '自动更新暂不可用，请从 GitHub 下载发布包。' : 'Automatic updates are currently unavailable. Download releases from GitHub.'} />
        <Space wrap>
          <Button type="primary" href="https://github.com/yongkang2/vehicle-manager/releases" target="_blank" rel="noopener noreferrer" icon={<Download size={16} />}>{zh ? '下载发布版本' : 'Download releases'}</Button>
          <Button href="https://github.com/yongkang2/vehicle-manager" target="_blank" rel="noopener noreferrer" icon={<ExternalLink size={16} />}>{zh ? 'GitHub 项目主页' : 'GitHub project'}</Button>
        </Space>
        <Alert type="warning" showIcon title={zh ? '更换版本前，请保存工作、停止旧程序，并独立备份本机数据和共享目录。团队成员应统一升级。' : 'Before changing versions, save your work, stop the old program, and independently back up local data and the shared folder. Upgrade collaborating clients together.'} />
      </Space>
    </Modal>
}