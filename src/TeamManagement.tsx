import { useEffect, useEffectEvent, useState } from 'react'
import { Button, Checkbox, Input, Modal, Select, Table, Tabs, Tag } from 'antd'
import { Check, RefreshCw } from 'lucide-react'
import type { Binding, JoinRequest, Member, Role, TeamDocument, TeamEvent } from '../shared/types'
import { api } from './api'
import type { Dictionary, Language } from './i18n'

type Decision = { kind: 'approve' | 'reject' | 'member' | 'device'; id: string; title: string; role: Role; enabled: boolean; memberId: string | null; reason: string }
export default function TeamManagement({ text, language, onError, onUpdated }: { text: Dictionary; language: Language; onError: (error: unknown) => void; onUpdated: () => Promise<void> }) {
  const [team, setTeam] = useState<TeamDocument | null>(null), [loading, setLoading] = useState(true)
  const [decision, setDecision] = useState<Decision | null>(null), [saving, setSaving] = useState(false)
  async function load() { setLoading(true); try { setTeam(await api<TeamDocument>('/api/team')) } catch (error) { onError(error) } finally { setLoading(false) } }
  const reportError = useEffectEvent(onError)
  useEffect(() => { let live = true; void api<TeamDocument>('/api/team').then(value => { if (live) setTeam(value) }).catch(error => reportError(error)).finally(() => { if (live) setLoading(false) }); return () => { live = false } }, [])
  const periodicLoad = useEffectEvent(async () => { if (!decision) await load() })
  useEffect(() => { const timer = setInterval(() => { void periodicLoad() }, 30000); return () => clearInterval(timer) }, [])
  const nameOf = (id: string) => team?.members.find(member => member.id === id)?.name || id.slice(0, 12)
  const roleName = (value: Role) => value === 'admin' ? text.firstAdmin : text.member
  const date = (value: string) => new Date(value).toLocaleString(language === 'zh' ? 'zh-CN' : 'en-GB')
  async function save() {
    if (!decision || !decision.reason.trim()) return
    setSaving(true)
    try {
      const endpoint = decision.kind === 'approve' || decision.kind === 'reject' ? `/api/team/requests/${decision.id}/${decision.kind}` : decision.kind === 'member' ? `/api/team/members/${decision.id}` : `/api/team/devices/${decision.id}/revoke`
      setTeam(await api<TeamDocument>(endpoint, { method: 'POST', body: { role: decision.role, enabled: decision.enabled, memberId: decision.memberId, reason: decision.reason } }))
      setDecision(null); await onUpdated()
    } catch (error) { onError(error) } finally { setSaving(false) }
  }
  const requestColumns = [
    { title: text.name, key: 'name', render: (_: unknown, record: JoinRequest) => <div className="record-title">{record.identity.displayName}<small>{record.identity.localUserId.slice(0, 12)}</small></div> },
    { title: text.device, key: 'device', render: (_: unknown, record: JoinRequest) => <span className="mono">{record.identity.deviceName}</span> },
    { title: text.created, key: 'created', render: (_: unknown, record: JoinRequest) => date(record.created) },
    { title: text.actions, key: 'action', render: (_: unknown, record: JoinRequest) => <div className="row-actions"><Button size="small" icon={<Check size={15} />} onClick={() => setDecision({ kind: 'approve', id: record.id, title: `${text.approve} · ${record.identity.displayName}`, role: 'member', enabled: true, memberId: null, reason: '' })}>{text.approve}</Button><Button size="small" danger onClick={() => setDecision({ kind: 'reject', id: record.id, title: `${text.reject} · ${record.identity.displayName}`, role: 'member', enabled: false, memberId: null, reason: '' })}>{text.reject}</Button></div> },
  ]
  const memberColumns = [
    { title: text.name, key: 'name', render: (_: unknown, record: Member) => <div className="record-title">{record.name}<small className="mono">{record.id.slice(0, 12)}</small></div> },
    { title: text.role, key: 'role', render: (_: unknown, record: Member) => <Tag color={record.role === 'admin' ? 'blue' : 'default'}>{roleName(record.role)}</Tag> },
    { title: text.status, key: 'status', render: (_: unknown, record: Member) => <span className={record.enabled ? 'positive' : 'muted'}>{record.enabled ? text.enabled : text.disabled}</span> },
    { title: text.actions, key: 'actions', render: (_: unknown, record: Member) => <Button size="small" onClick={() => setDecision({ kind: 'member', id: record.id, title: `${text.edit} · ${record.name}`, role: record.role, enabled: record.enabled, memberId: null, reason: '' })}>{text.edit}</Button> },
  ]
  const deviceColumns = [
    { title: text.name, key: 'name', render: (_: unknown, record: Binding) => nameOf(record.memberId) },
    { title: text.device, key: 'device', render: (_: unknown, record: Binding) => <div className="record-title">{record.deviceName}<small className="mono">{record.deviceId.slice(0, 12)}</small></div> },
    { title: text.status, key: 'status', render: (_: unknown, record: Binding) => record.enabled ? text.approved : text.disabled },
    { title: text.actions, key: 'action', render: (_: unknown, record: Binding) => <Button size="small" danger disabled={!record.enabled} onClick={() => setDecision({ kind: 'device', id: record.id, title: `${text.revoke} · ${record.deviceName}`, role: 'member', enabled: false, memberId: null, reason: '' })}>{text.revoke}</Button> },
  ]
  const operations: Record<string, string> = { 'team.created': text.teamCreated, 'join.requested': text.joinRequested, 'join.cancelled': text.joinCancelled, 'join.approved': text.joinApproved, 'join.rejected': text.joinRejected, 'member.updated': text.memberUpdated, 'device.revoked': text.deviceRevoked }
  return <><div className="page-heading"><div><span className="eyebrow">TEAM ACCESS</span><h1>{text.team}</h1></div><Button icon={<RefreshCw size={16} />} onClick={() => void load()} loading={loading}>{text.refresh}</Button></div><Tabs items={[
    { key: 'requests', label: `${text.requests} (${team?.requests.filter(request => request.status === 'pending').length || 0})`, children: <Table<JoinRequest> rowKey="id" loading={loading} columns={requestColumns} dataSource={team?.requests.filter(request => request.status === 'pending') || []} scroll={{ x: 650 }} locale={{ emptyText: text.noRequests }} pagination={{ pageSize: 8, hideOnSinglePage: true }} /> },
    { key: 'members', label: text.members, children: <Table<Member> rowKey="id" columns={memberColumns} dataSource={team?.members || []} scroll={{ x: 580 }} pagination={{ pageSize: 8, hideOnSinglePage: true }} /> },
    { key: 'devices', label: text.devices, children: <Table<Binding> rowKey="id" columns={deviceColumns} dataSource={team?.bindings || []} scroll={{ x: 650 }} pagination={{ pageSize: 8, hideOnSinglePage: true }} /> },
    { key: 'events', label: text.events, children: <Table<TeamEvent> rowKey="id" dataSource={team?.events.toReversed() || []} columns={[{ title: text.created, render: (_, record) => date(record.created) }, { title: text.actor, render: (_, record) => nameOf(record.actorId) }, { title: text.operation, render: (_, record) => operations[record.action] || record.action }, { title: text.reason, dataIndex: 'reason' }]} scroll={{ x: 700 }} pagination={{ pageSize: 8, hideOnSinglePage: true }} /> },
  ]} /><Modal open={Boolean(decision)} title={decision?.title} onCancel={() => { if (!saving) setDecision(null) }} onOk={() => void save()} confirmLoading={saving} okText={text.save} cancelText={text.cancel} okButtonProps={{ disabled: !decision?.reason.trim() }} destroyOnHidden>
    {decision && <div className="decision-form">
      {decision.kind === 'approve' && <label>{text.bindIdentity}<Select value={decision.memberId || 'new'} onChange={value => setDecision({ ...decision, memberId: value === 'new' ? null : value })} options={[{ value: 'new', label: text.newIdentity }, ...(team?.members.filter(member => member.enabled).map(member => ({ value: member.id, label: `${member.name} · ${roleName(member.role)}` })) || [])]} /></label>}
      {(decision.kind === 'approve' || decision.kind === 'member') && <label>{text.role}<Select value={decision.memberId ? team?.members.find(member => member.id === decision.memberId)?.role : decision.role} disabled={Boolean(decision.memberId)} onChange={(value: Role) => setDecision({ ...decision, role: value })} options={[{ value: 'member', label: text.member }, { value: 'admin', label: text.firstAdmin }]} /></label>}
      {decision.kind === 'member' && <Checkbox checked={decision.enabled} onChange={event => setDecision({ ...decision, enabled: event.target.checked })}>{text.enabled}</Checkbox>}
      <label>{text.reason}<Input.TextArea value={decision.reason} maxLength={500} rows={3} onChange={event => setDecision({ ...decision, reason: event.target.value })} /></label>
    </div>}</Modal></>
}