import { useEffect, useEffectEvent, useState } from 'react'
import { App, Alert, Button, Checkbox, Drawer, Empty, Modal, Spin, Tag } from 'antd'
import { ArrowRightLeft, Check, Download, FolderPlus, FolderSync, LogOut, RefreshCw, Unplug, Undo2 } from 'lucide-react'
import type { Status, WorkspaceSummary } from '../shared/types'
import type { Dictionary } from './i18n'
import { api } from './api'

export default function PersonalWorkspaces({ open, text, status, onClose, onConnect, onSelected, onLogout, onUpdates, onError }: { open: boolean; text: Dictionary; status: Status; onClose: () => void; onConnect: () => void; onSelected: (status: Status) => void; onLogout: () => void; onUpdates: () => void; onError: (error: unknown) => void }) {
  const { modal } = App.useApp()
  const [teams, setTeams] = useState<WorkspaceSummary[]>([]), [busy, setBusy] = useState(true)
  const [target, setTarget] = useState<WorkspaceSummary | 'disconnect' | null>(null), [retain, setRetain] = useState(false)
  async function load() { setBusy(true); try { setTeams(await api<WorkspaceSummary[]>('/api/workspaces')) } catch (error) { onError(error) } finally { setBusy(false) } }
  const reportError = useEffectEvent(onError)
  useEffect(() => {
    if (!open) return
    let live = true
    void api<WorkspaceSummary[]>('/api/workspaces').then(value => { if (live) setTeams(value) }).catch(error => { if (live) reportError(error) }).finally(() => { if (live) setBusy(false) })
    return () => { live = false }
  }, [open])
  const source = teams.find(team => team.selected), hasPending = Boolean(source && (source.pending || source.conflicts))
  const labels = { unconfigured: text.notConfigured, approved: text.approved, pending: text.pending, rejected: text.rejected, disabled: text.disabled, unbound: text.unbound }
  async function choose() {
    if (!target) return
    setBusy(true)
    try {
      const next = await api<Status>(target === 'disconnect' ? '/api/workspaces/disconnect' : '/api/workspaces/select', { method: 'POST', body: { teamId: target === 'disconnect' ? undefined : target.id, confirmed: true, retainPending: retain } })
      setTarget(null); onSelected(next); onClose()
    } catch (error) { onError(error); await load() } finally { setBusy(false) }
  }
  function confirmAction(kind: 'cancel-request' | 'resume') {
    modal.confirm({ title: kind === 'resume' ? text.resumeSync : text.cancelRequest, content: kind === 'resume' ? text.resumeWarning : text.withdrawWarning, okText: text.save, cancelText: text.cancel, async onOk() {
      try { onSelected(await api<Status>(`/api/workspaces/${kind}`, { method: 'POST', body: { confirmed: true } })); await load() } catch (error) { onError(error); throw error }
    } })
  }
  return <><Drawer title={text.personal} open={open} onClose={onClose} size={480} className="personal-drawer">
    <div className="personal-heading"><h2>{text.myTeams}</h2><Button type="text" aria-label={text.refresh} title={text.refresh} icon={<RefreshCw size={17} />} loading={busy} onClick={() => void load()} /></div>
    {busy && <Spin />}{!busy && !teams.length && <Empty description={text.noTeams} />}
    <div className="personal-team-list">{teams.map(team => <div className="personal-team" key={team.id}><div className="personal-team-heading"><strong>{team.name}</strong>{team.selected && <Tag icon={<Check size={13} />}>{text.currentTeam}</Tag>}</div><small className="personal-path">{team.sharedPath}</small><small className="personal-team-id">{team.id}</small><div className="personal-team-state"><Tag>{labels[team.access]}</Tag><span>{text.pendingChanges}: {team.pending}</span><span>{text.conflictCount}: {team.conflicts}</span></div>{!team.selected && <Button icon={<ArrowRightLeft size={16} />} disabled={busy} onClick={() => { setRetain(false); setTarget(team) }}>{text.selectTeam}</Button>}</div>)}</div>
    <div className="personal-commands"><Button icon={<FolderPlus size={17} />} disabled={busy} onClick={() => modal.confirm({ title: text.connectTeam, content: text.switchWarning, okText: text.save, cancelText: text.cancel, onOk() { onClose(); onConnect() } })}>{text.connectTeam}</Button>
      {status.access === 'pending' && <Button icon={<Undo2 size={17} />} disabled={busy} onClick={() => confirmAction('cancel-request')}>{text.cancelRequest}</Button>}
      {status.teamId && status.syncPaused && status.access === 'approved' && <><Alert type="warning" showIcon title={text.syncPaused} /><Button icon={<FolderSync size={17} />} disabled={busy} onClick={() => confirmAction('resume')}>{text.resumeSync}</Button></>}
      {status.teamId && <Button icon={<Unplug size={17} />} disabled={busy} onClick={() => { setRetain(false); setTarget('disconnect') }}>{text.disconnect}</Button>}
      <Button icon={<Download size={17} />} disabled={busy} onClick={onUpdates}>{text.programUpdates}</Button>
      <Button type="text" icon={<LogOut size={17} />} onClick={onLogout}>{text.logout}</Button>
    </div>
  </Drawer><Modal title={text.switchTitle} open={Boolean(target)} onCancel={() => { if (!busy) setTarget(null) }} confirmLoading={busy} cancelButtonProps={{ disabled: busy }} closable={!busy} maskClosable={!busy} okText={text.save} cancelText={text.cancel} okButtonProps={{ disabled: hasPending && !retain }} onOk={() => void choose()}>
    <p>{text.switchWarning}</p>{target && target !== 'disconnect' && <p className="personal-path"><strong>{target.name}</strong><br />{target.sharedPath}</p>}
    {source && <p>{text.pendingChanges}: {source.pending} · {text.conflictCount}: {source.conflicts}</p>}
    {hasPending && <Checkbox checked={retain} onChange={event => setRetain(event.target.checked)}>{text.retainPending}</Checkbox>}
  </Modal></>
}