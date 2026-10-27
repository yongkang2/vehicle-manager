import { useEffect, useEffectEvent, useState } from 'react'
import { Button, Checkbox, Input, Modal, Select, Table, Tabs, Tag, Tooltip } from 'antd'
import { Check, ChevronDown, ChevronRight, Monitor, Pencil, RefreshCw, Search, ShieldOff, X } from 'lucide-react'
import type { Binding, JoinRequest, Member, Role, TeamDocument, TeamEvent } from '../shared/types'
import { api } from './api'
import type { Dictionary, Language } from './i18n'

type Decision = { kind: 'approve' | 'reject' | 'member' | 'device'; id: string; title: string; role: Role; enabled: boolean; memberId: string | null; reason: string; name?: string; nickname?: string }
export default function TeamManagement({ text, language, onError, onUpdated }: { text: Dictionary; language: Language; onError: (error: unknown) => void; onUpdated: () => Promise<void> }) {
  const [team, setTeam] = useState<TeamDocument | null>(null), [loading, setLoading] = useState(true)
  const [decision, setDecision] = useState<Decision | null>(null), [saving, setSaving] = useState(false)
  const [query, setQuery] = useState('')
  async function load() { setLoading(true); try { setTeam(await api<TeamDocument>('/api/team')) } catch (error) { onError(error) } finally { setLoading(false) } }
  const reportError = useEffectEvent(onError)
  useEffect(() => { let live = true; void api<TeamDocument>('/api/team').then(value => { if (live) setTeam(value) }).catch(error => reportError(error)).finally(() => { if (live) setLoading(false) }); return () => { live = false } }, [])
  const periodicLoad = useEffectEvent(async () => { if (!decision) await load() })
  useEffect(() => { const timer = setInterval(() => { void periodicLoad() }, 30000); return () => clearInterval(timer) }, [])
  const memberName = (member: Member) => member.nickname || member.name
  const nameOf = (id: string) => { const member = team?.members.find(item => item.id === id); return member ? memberName(member) : id.slice(0, 12) }
  const bindingsOf = (id: string) => team?.bindings.filter(binding => binding.memberId === id) || []
  const roleName = (value: Role) => value === 'admin' ? text.firstAdmin : text.member
  const date = (value: string) => new Date(value).toLocaleString(language === 'zh' ? 'zh-CN' : 'en-GB')
  const validDecision = Boolean(decision?.reason.trim() && (decision.kind !== 'member' || decision.name?.trim()))
  const normalizedQuery = query.trim().toLocaleLowerCase()
  const members = team?.members.filter(member => [member.name, member.nickname || '', member.id, ...bindingsOf(member.id).flatMap(binding => [binding.deviceName, binding.deviceId, binding.localUserId])].some(value => value.toLocaleLowerCase().includes(normalizedQuery))) || []
  const pendingRequests = team?.requests.filter(request => request.status === 'pending') || []
  const selectedRequest = decision && team?.requests.find(request => request.id === decision.id)
  async function save() {
    if (!decision || !validDecision || saving) return
    setSaving(true)
    try {
      const endpoint = decision.kind === 'approve' || decision.kind === 'reject' ? `/api/team/requests/${decision.id}/${decision.kind}` : decision.kind === 'member' ? `/api/team/members/${decision.id}` : `/api/team/devices/${decision.id}/revoke`
      setTeam(await api<TeamDocument>(endpoint, { method: 'POST', body: { role: decision.role, enabled: decision.enabled, memberId: decision.memberId, reason: decision.reason, ...(decision.kind === 'member' ? { name: decision.name, nickname: decision.nickname } : {}) } }))
      setDecision(null); await onUpdated()
    } catch (error) { onError(error) } finally { setSaving(false) }
  }
  const requestColumns = [
    { title: text.name, key: 'name', render: (_: unknown, record: JoinRequest) => <div className="record-title">{record.identity.displayName}<small>{record.identity.localUserId.slice(0, 12)}</small></div> },
    { title: text.device, key: 'device', render: (_: unknown, record: JoinRequest) => <div className="record-title">{record.identity.deviceName}<small className="mono">{record.identity.deviceId}</small></div> },
    { title: text.created, key: 'created', render: (_: unknown, record: JoinRequest) => date(record.created) },
    { title: text.actions, key: 'action', render: (_: unknown, record: JoinRequest) => <div className="row-actions"><Button size="small" icon={<Check size={15} />} onClick={() => setDecision({ kind: 'approve', id: record.id, title: `${text.approve} · ${record.identity.displayName}`, role: 'member', enabled: true, memberId: null, reason: '' })}>{text.approve}</Button><Button size="small" danger icon={<X size={15} />} onClick={() => setDecision({ kind: 'reject', id: record.id, title: `${text.reject} · ${record.identity.displayName}`, role: 'member', enabled: false, memberId: null, reason: '' })}>{text.reject}</Button></div> },
  ]
  const memberColumns = [
    { title: text.name, key: 'name', render: (_: unknown, record: Member) => <div className="record-title"><strong>{memberName(record)}</strong>{record.nickname && <small>{record.name}</small>}<small className="mono" title={record.id}>{record.id.slice(0, 12)}</small></div> },
    { title: text.role, key: 'role', render: (_: unknown, record: Member) => <Tag color={record.role === 'admin' ? 'blue' : 'default'}>{roleName(record.role)}</Tag> },
    { title: text.status, key: 'status', render: (_: unknown, record: Member) => <span className={record.enabled ? 'positive' : 'muted'}>{record.enabled ? text.enabled : text.disabled}</span> },
    { title: text.devices, key: 'devices', render: (_: unknown, record: Member) => { const approved = bindingsOf(record.id).filter(binding => binding.enabled); return <span className="team-device-count"><Monitor size={15} /><span className={approved.length ? '' : 'muted'}>{approved.length || text.noApprovedDevices}</span></span> } },
    { title: text.actions, key: 'actions', width: 120, render: (_: unknown, record: Member) => <Button size="small" icon={<Pencil size={14} />} onClick={() => setDecision({ kind: 'member', id: record.id, title: `${text.editMember} · ${memberName(record)}`, role: record.role, enabled: record.enabled, memberId: null, reason: '', name: record.name, nickname: record.nickname || '' })}>{text.editMember}</Button> },
  ]
  const deviceRow = (binding: Binding) => <li key={binding.id} className="team-device-row">
    <Monitor size={18} aria-hidden="true" />
    <div className="team-device-info"><strong>{binding.deviceName}</strong><span className="mono">{text.deviceId}: {binding.deviceId}</span><span className="mono muted">{text.localAccountId}: {binding.localUserId}</span></div>
    <Tag color={binding.enabled ? 'success' : 'default'}>{binding.enabled ? text.approved : text.revoked}</Tag>
    <Tooltip title={text.revoke}><Button type="text" danger icon={<ShieldOff size={16} />} aria-label={`${text.revoke} ${binding.deviceName}`} disabled={!binding.enabled} onClick={() => setDecision({ kind: 'device', id: binding.id, title: `${text.revoke} · ${binding.deviceName}`, role: 'member', enabled: false, memberId: null, reason: '' })} /></Tooltip>
  </li>
  const operations: Record<string, string> = { 'team.created': text.teamCreated, 'join.requested': text.joinRequested, 'join.cancelled': text.joinCancelled, 'join.approved': text.joinApproved, 'join.rejected': text.joinRejected, 'member.updated': text.memberUpdated, 'device.revoked': text.deviceRevoked }
  return <section className="team-management"><div className="page-heading"><div><span className="eyebrow">TEAM ACCESS</span><h1>{text.team}</h1></div><Button icon={<RefreshCw size={16} />} onClick={() => void load()} loading={loading} disabled={Boolean(decision)}>{text.refresh}</Button></div><Tabs defaultActiveKey="members" items={[
    { key: 'members', label: text.membersDevices, children: <><div className="team-toolbar"><span className="muted">{team?.members.length || 0} {text.memberCount}<span className="team-summary-separator">/</span>{team?.bindings.filter(binding => binding.enabled).length || 0} {text.deviceCount}</span><Input allowClear prefix={<Search size={16} />} value={query} onChange={event => setQuery(event.target.value)} placeholder={text.searchMembers} aria-label={text.searchMembers} /></div><Table<Member> rowKey="id" loading={loading} columns={memberColumns} dataSource={members} scroll={{ x: 640 }} locale={{ emptyText: text.noMembers }} expandable={{ rowExpandable: member => bindingsOf(member.id).length > 0, expandedRowRender: member => <div className="team-member-devices"><div className="team-member-id mono muted">{text.memberId}: {member.id}</div><ul className="team-device-list">{bindingsOf(member.id).map(deviceRow)}</ul></div>, expandIcon: ({ expanded, onExpand, record, expandable }) => expandable ? <Tooltip title={expanded ? text.collapseDevices : text.expandDevices}><Button type="text" size="small" className="team-expand" aria-label={`${expanded ? text.collapseDevices : text.expandDevices} ${memberName(record)}`} aria-expanded={expanded} icon={expanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />} onClick={event => onExpand(record, event)} /></Tooltip> : null }} pagination={{ pageSize: 8, hideOnSinglePage: true }} /></> },
    { key: 'requests', label: `${text.requests} (${pendingRequests.length})`, children: <Table<JoinRequest> rowKey="id" loading={loading} columns={requestColumns} dataSource={pendingRequests} scroll={{ x: 650 }} locale={{ emptyText: text.noRequests }} pagination={{ pageSize: 8, hideOnSinglePage: true }} /> },
    { key: 'events', label: text.events, children: <Table<TeamEvent> rowKey="id" loading={loading} dataSource={team?.events.toReversed() || []} columns={[{ title: text.created, render: (_, record) => date(record.created) }, { title: text.actor, render: (_, record) => nameOf(record.actorId) }, { title: text.operation, render: (_, record) => operations[record.action] || record.action }, { title: text.reason, dataIndex: 'reason' }]} scroll={{ x: 700 }} pagination={{ pageSize: 8, hideOnSinglePage: true }} /> },
  ]} /><Modal open={Boolean(decision)} title={decision?.title} onCancel={() => { if (!saving) setDecision(null) }} onOk={() => void save()} confirmLoading={saving} okText={text.save} cancelText={text.cancel} cancelButtonProps={{ disabled: saving }} okButtonProps={{ disabled: !validDecision }} destroyOnHidden>
      {decision && <div className="decision-form team-decision-form">
        {selectedRequest && <div className="team-approval-device"><Monitor size={18} aria-hidden="true" /><div><strong>{selectedRequest.identity.deviceName}</strong><span className="mono">{selectedRequest.identity.deviceId}</span></div></div>}
        {decision.kind === 'approve' && <label htmlFor="team-bind-identity">{text.bindIdentity}<Select id="team-bind-identity" showSearch optionFilterProp="label" disabled={saving} value={decision.memberId || 'new'} onChange={value => setDecision({ ...decision, memberId: value === 'new' ? null : value })} options={[{ value: 'new', label: text.newIdentity }, ...(team?.members.filter(member => member.enabled).map(member => ({ value: member.id, label: `${memberName(member)}${member.nickname ? ` (${member.name})` : ''} · ${roleName(member.role)} · ${member.id.slice(0, 8)}` })) || [])]} /></label>}
        {decision.kind === 'member' && <><label htmlFor="team-nickname">{text.nickname}<Input id="team-nickname" value={decision.nickname} disabled={saving} maxLength={60} onChange={event => setDecision({ ...decision, nickname: event.target.value })} /></label><label htmlFor="team-real-name">{text.realName}<Input id="team-real-name" value={decision.name} disabled={saving} maxLength={60} required onChange={event => setDecision({ ...decision, name: event.target.value })} /></label></>}
        {(decision.kind === 'approve' || decision.kind === 'member') && <label htmlFor="team-role">{text.role}<Select id="team-role" value={decision.memberId ? team?.members.find(member => member.id === decision.memberId)?.role : decision.role} disabled={saving || Boolean(decision.memberId)} onChange={(value: Role) => setDecision({ ...decision, role: value })} options={[{ value: 'member', label: text.member }, { value: 'admin', label: text.firstAdmin }]} /></label>}
        {decision.kind === 'member' && <Checkbox checked={decision.enabled} disabled={saving} onChange={event => setDecision({ ...decision, enabled: event.target.checked })}>{text.enabled}</Checkbox>}
        <label htmlFor="team-reason">{text.reason}<Input.TextArea id="team-reason" value={decision.reason} disabled={saving} maxLength={500} rows={3} required onChange={event => setDecision({ ...decision, reason: event.target.value })} /></label>
      </div>}</Modal></section>
}