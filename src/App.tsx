import { lazy, Suspense, useEffect, useEffectEvent, useRef, useState } from 'react'
import { App as AntApp, Alert, Button, Checkbox, ConfigProvider, Form, Input, Segmented, Spin, Tabs, Tag, Tooltip } from 'antd'
import enUS from 'antd/locale/en_US'
import zhCN from 'antd/locale/zh_CN'
import { ArrowRight, CarFront, Check, ChevronUp, Clock3, FileSpreadsheet, Files, FolderCog, FolderOpen, FolderSync, HardDrive, History, RefreshCw, ShieldCheck, UserRound, UsersRound, WifiOff } from 'lucide-react'
import type { ConnectionCheck, LocalUser, Status } from '../shared/types'
import { api, ApiError } from './api'
import { trackBrowserPresence } from './browser-presence'
import { dictionaries, errorText } from './i18n'
import type { Dictionary, Language } from './i18n'
import TeamManagement from './TeamManagement'
import PersonalWorkspaces from './PersonalWorkspaces'
import { translateBusiness } from './business-i18n'
import type { BusinessView } from './BusinessApp'
import './App.css'

const BusinessApp = lazy(() => import('./BusinessApp'))
const businessNavigation = [{ view: 'vehicles', icon: CarFront }, { view: 'dove', icon: FileSpreadsheet }, { view: 'reports', icon: Files }, { view: 'history', icon: History }, { view: 'sync', icon: FolderSync }, { view: 'audit', icon: ShieldCheck }] as const
type WorkspaceView = 'workspace' | 'settings' | 'team' | BusinessView
type BaseProps = { text: Dictionary; language: Language; onError: (error: unknown) => void }
const glyph = (Icon: typeof Check) => <Icon size={17} aria-hidden="true" />

function Authentication({ text, onError, onLogin }: BaseProps & { onLogin: (user: LocalUser) => void }) {
  const [mode, setMode] = useState('login'), [busy, setBusy] = useState(false)
  const [form] = Form.useForm()
  async function submit(values: { username: string; displayName?: string; password: string }) {
    setBusy(true)
    try { onLogin(await api<LocalUser>(`/api/${mode === 'login' ? 'login' : 'register'}`, { method: 'POST', body: values })) }
    catch (error) { onError(error) } finally { setBusy(false) }
  }
  return <main className="auth-screen"><div className="auth-content"><img src="/stellantis.svg" className="auth-logo" alt="STELLANTIS" /><h1>{text.product}</h1>
    <Tabs activeKey={mode} onChange={value => { setMode(value); form.resetFields() }} items={[{ key: 'login', label: text.signIn }, { key: 'register', label: text.register }]} />
    <Form form={form} layout="vertical" onFinish={submit} requiredMark={false}>
      {mode === 'register' && <Form.Item label={text.displayName} name="displayName" rules={[{ required: true, whitespace: true, message: text.required }, { max: 60 }]}><Input autoComplete="name" maxLength={60} /></Form.Item>}
      <Form.Item label={text.username} name="username" rules={[{ required: true, message: text.required }, { min: 2, max: 24 }]}><Input autoComplete="username" prefix={glyph(UserRound)} maxLength={24} /></Form.Item>
      <Form.Item label={text.password} name="password" rules={[{ required: true, message: text.required }, ...(mode === 'register' ? [{ min: 10, max: 128, message: text.passwordHint }] : [])]}><Input.Password autoComplete={mode === 'login' ? 'current-password' : 'new-password'} maxLength={128} placeholder={mode === 'register' ? text.passwordHint : undefined} /></Form.Item>
      <Button type="primary" htmlType="submit" loading={busy} block className="auth-submit" icon={glyph(ArrowRight)} iconPlacement="end">{mode === 'login' ? text.signIn : text.register}</Button>
    </Form><div className="auth-bottom">{text.account} <span>•</span> {text.local}</div></div></main>
}

function Setup({ text, language, onError, status, onDone, onLater }: BaseProps & { status: Status; onDone: () => Promise<void>; onLater: () => void }) {
  const [directory, setDirectory] = useState(status.sharedPath || ''), [checked, setChecked] = useState<ConnectionCheck | null>(null)
  const [busy, setBusy] = useState(false), [teamName, setTeamName] = useState(''), [confirmed, setConfirmed] = useState(false)
  const [retainPending, setRetainPending] = useState(false)
  async function test() {
    setBusy(true); setChecked(null); setConfirmed(false)
    try { setChecked(await api<ConnectionCheck>('/api/setup/check', { method: 'POST', body: { path: directory } })) }
    catch (error) { onError(error) } finally { setBusy(false) }
  }
  async function configure() {
    if (!checked) return
    setBusy(true)
    try { await api<Status>('/api/setup/configure', { method: 'POST', body: { path: checked.path, mode: checked.kind === 'empty' ? 'create' : 'join', teamName, confirmed, teamId: checked.teamId, retainPending } }); await onDone() }
    catch (error) { onError(error) } finally { setBusy(false) }
  }
  return <section className="setup-section"><div className="section-heading"><span className="eyebrow">{text.settings.toUpperCase()}</span><h1>{text.setupTitle}</h1></div>
    {status.teamId && <div className="workspace-switch-notice"><Alert type="info" showIcon title={text.switchWarning} /><Checkbox checked={retainPending} onChange={event => setRetainPending(event.target.checked)}>{text.retainPending}</Checkbox></div>}
    <Form layout="vertical" requiredMark={false} className="setup-form" onFinish={test}><Form.Item label={text.path}><div className="path-row"><Input value={directory} maxLength={1024} disabled={busy} onChange={event => { setDirectory(event.target.value); setChecked(null); setConfirmed(false) }} placeholder="\\fileserver\team\vehicle-data" prefix={glyph(FolderOpen)} aria-label={text.path} /><Button htmlType="submit" icon={glyph(Check)} loading={busy} disabled={!directory.trim()}>{text.test}</Button></div></Form.Item></Form>
    {checked && <div className="connection-result"><div className="verified"><Check size={19} /><div><strong>{checked.kind === 'empty' ? text.emptyFolder : text.existingTeam}</strong><small>{text.checks}</small></div></div>
      {checked.kind === 'existing' ? <dl className="compact-facts"><div><dt>{text.teamName}</dt><dd>{checked.teamName}</dd></div></dl> : <><label className="standalone-label" htmlFor="team-name">{text.teamName}</label><Input id="team-name" maxLength={80} value={teamName} onChange={event => setTeamName(event.target.value)} /><Checkbox checked={confirmed} onChange={event => setConfirmed(event.target.checked)} className="create-confirm">{text.confirmCreate}</Checkbox></>}
      <Button type="primary" icon={glyph(ArrowRight)} iconPlacement="end" loading={busy} disabled={checked.kind === 'empty' && (!confirmed || !teamName.trim())} onClick={() => void configure()}>{checked.kind === 'empty' ? text.create : text.join}</Button></div>}
    <div className="setup-later"><Button type="text" onClick={onLater} disabled={busy}>{text.later}</Button></div>
    {status.error && <Alert title={errorText(status.error, language)} type="warning" showIcon />}</section>
}

function Workspace({ text, language, onError, user, onLogout }: BaseProps & { user: LocalUser; onLogout: () => void }) {
  const [status, setStatus] = useState<Status | null>(null), [view, setView] = useState<WorkspaceView>('vehicles')
  const [deferred, setDeferred] = useState(false), [refreshing, setRefreshing] = useState(false)
  const [personalOpen, setPersonalOpen] = useState(false)
  async function reload() { const next = await api<Status>('/api/status'); setStatus(next); if (next.member?.role !== 'admin' || !next.online || next.access !== 'approved') setView(current => current === 'team' ? 'workspace' : current) }
  const reportError = useEffectEvent(onError)
  useEffect(() => { void api<Status>('/api/status').then(setStatus).catch(error => reportError(error)) }, [])
  const periodicReload = useEffectEvent(async () => { try { await reload() } catch (error) { onError(error) } })
  useEffect(() => { const timer = setInterval(() => { void periodicReload() }, 30000); return () => clearInterval(timer) }, [])
  async function refresh() { setRefreshing(true); try { await reload() } catch (error) { onError(error) } finally { setRefreshing(false) } }
  async function logout() { try { await api('/api/logout', { method: 'POST' }); onLogout() } catch (error) { onError(error) } }
  function selected(next: Status) { setStatus(next); setView(next.access === 'approved' ? 'vehicles' : 'workspace'); setDeferred(true) }
  if (!status) return <div className="boot"><Spin /></div>
  const admin = status.access === 'approved' && status.member?.role === 'admin'
  const labels = { unconfigured: text.notConfigured, pending: text.pendingTitle, approved: text.approved, disabled: text.disabled, unbound: text.unbound, rejected: text.rejected }
  const setup = view === 'settings' || (status.access === 'unconfigured' && !deferred)
  const businessView = status.access === 'approved' && businessNavigation.some(item => item.view === view)
  const businessText = translateBusiness(language)
  return <div className="workspace-layout"><aside className="sidebar"><div className="sidebar-brand"><img src="/stellantis.svg" alt="STELLANTIS" /><span>{text.product}</span></div><nav>
    {status.access === 'approved' && businessNavigation.filter(item => item.view !== 'audit' || admin).map(item => <button key={item.view} className={view === item.view && !setup ? 'active' : ''} onClick={() => setView(item.view)}>{glyph(item.icon)}{businessText(item.view)}</button>)}
    {admin && <button className={view === 'team' ? 'active' : ''} disabled={!status.online} onClick={() => setView('team')}>{glyph(UsersRound)}{text.team}</button>}
  </nav><div className="sidebar-bottom"><span className="build-label">{text.foundation} · 1.0.1</span><button className="account-row personal-trigger" aria-label={text.personal} onClick={() => setPersonalOpen(true)}><span className="avatar">{user.displayName.slice(0, 1).toUpperCase()}</span><div><strong>{user.displayName}</strong><small>{admin ? text.firstAdmin : status.access === 'approved' ? text.member : text.account}</small></div>{glyph(ChevronUp)}</button></div></aside>
    {personalOpen && <PersonalWorkspaces open text={text} status={status} onClose={() => setPersonalOpen(false)} onConnect={() => setView('settings')} onSelected={selected} onLogout={() => void logout()} onError={onError} />}
    <main className="workspace-main"><header className="workspace-topbar"><span className="current-team-label" title={status.sharedPath || undefined}>{status.teamName || text.workspace} <b>/</b> {setup ? text.settings : view === 'team' ? text.team : businessView ? businessText(view) : text.accessTitle}</span><div><Tag variant="filled" color={status.online ? 'success' : 'default'} icon={status.online ? glyph(Check) : glyph(WifiOff)}>{status.online ? text.online : text.offline}</Tag><Tooltip title={text.refresh}><Button type="text" loading={refreshing} icon={glyph(RefreshCw)} aria-label={text.refresh} onClick={() => void refresh()} /></Tooltip><Tooltip title={text.personal}><Button className="mobile-logout" type="text" icon={glyph(UserRound)} aria-label={text.personal} onClick={() => setPersonalOpen(true)} /></Tooltip></div></header>
      <div className="page-content" key={status.workspaceToken}>{status.teamId && status.syncPaused && status.access === 'approved' && <Alert className="connection-alert" type="warning" showIcon title={text.syncPaused} action={<Button size="small" icon={glyph(FolderSync)} onClick={() => setPersonalOpen(true)}>{text.resumeSync}</Button>} />}{setup ? <Setup text={text} language={language} onError={onError} status={status} onDone={async () => { await reload(); setView('vehicles'); setDeferred(true) }} onLater={() => { setDeferred(true); setView('workspace') }} /> : view === 'team' && admin && status.online ? <TeamManagement text={text} language={language} onError={onError} onUpdated={reload} /> : businessView ? <Suspense fallback={<Spin />}><BusinessApp view={view as BusinessView} language={language} admin={admin} online={status.online} syncPaused={status.syncPaused} onError={onError} /></Suspense> : <>
        <div className="page-heading"><div><span className="eyebrow">WORKSPACE ACCESS</span><h1>{status.teamName || text.workspace}</h1></div><Button icon={glyph(FolderCog)} onClick={() => setPersonalOpen(true)}>{text.myTeams}</Button></div>
        <div className={`access-banner ${status.access}`}><span className="access-symbol">{status.access === 'approved' ? glyph(ShieldCheck) : status.access === 'pending' ? glyph(Clock3) : glyph(FolderOpen)}</span><strong>{labels[status.access]}</strong></div>
        {status.error && <Alert className="connection-alert" type="warning" showIcon title={errorText(status.error, language)} />}
        <dl className="workspace-facts"><div><dt>{text.path}</dt><dd className="mono">{status.sharedPath || '—'}</dd></div><div><dt>{text.identity}</dt><dd>{status.member?.name || '—'} {status.member && <Tag>{status.member.role === 'admin' ? text.firstAdmin : text.member}</Tag>}</dd></div><div><dt>{text.device}</dt><dd>{status.deviceName}</dd></div><div><dt>{text.deviceId}</dt><dd className="mono">{status.deviceId}</dd></div><div><dt>{text.lastChecked}</dt><dd>{status.lastChecked ? new Date(status.lastChecked).toLocaleString(language === 'zh' ? 'zh-CN' : 'en-GB') : '—'}</dd></div><div><dt>{text.account}</dt><dd>{user.username}</dd></div></dl>
      </>}</div><footer className="workspace-footer"><span>{glyph(HardDrive)}{text.local}</span><span>{text.foundation} · 1.0.1</span></footer></main></div>
}

function Application({ language, text }: { language: Language; text: Dictionary }) {
  const { message, modal } = AntApp.useApp()
  const staleNotice = useRef(false)
  const [user, setUser] = useState<LocalUser | null>(null), [loading, setLoading] = useState(true)
  const onError = (error: unknown) => { const code = error instanceof ApiError ? error.message : 'SERVER_ERROR'; if (code === 'LOGIN_REQUIRED') setUser(null); if (code === 'WORKSPACE_CHANGED') { if (!staleNotice.current) { staleNotice.current = true; modal.warning({ title: errorText(code, language), okText: text.reloadPage, onOk: () => location.reload() }) }; return }; void message.error({ key: code, content: errorText(code, language) }) }
  const reportError = useEffectEvent(onError)
  useEffect(() => { void api<{ user: LocalUser | null }>('/api/bootstrap').then(result => setUser(result.user)).catch(error => reportError(error)).finally(() => setLoading(false)) }, [])
  if (loading) return <div className="boot"><Spin /></div>
  return user ? <Workspace key={user.id} user={user} language={language} text={text} onError={onError} onLogout={() => setUser(null)} /> : <Authentication language={language} text={text} onError={onError} onLogin={setUser} />
}

export default function App() {
  useEffect(() => trackBrowserPresence(), [])
  const [language, setLanguage] = useState<Language>(() => localStorage.getItem('vdm-language') === 'zh' ? 'zh' : 'en')
  const text = dictionaries[language]
  useEffect(() => { localStorage.setItem('vdm-language', language); document.documentElement.lang = language === 'zh' ? 'zh-CN' : 'en'; document.title = `STELLANTIS · ${text.product}` }, [language, text.product])
  return <ConfigProvider locale={language === 'zh' ? zhCN : enUS} theme={{ token: { colorPrimary: '#263781', borderRadius: 5, fontFamily: 'Bahnschrift, DengXian, Microsoft YaHei UI, sans-serif', fontSize: 13, controlHeight: 40, motion: false } }}><AntApp><div className="language-control"><Segmented aria-label="Language / 语言" value={language} options={[{ label: 'English', value: 'en' }, { label: '中文', value: 'zh' }]} onChange={value => setLanguage(value as Language)} /></div><Application language={language} text={text} /></AntApp></ConfigProvider>
}
