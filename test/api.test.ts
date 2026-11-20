import { test } from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { createApp } from '../server/app.js'
import type { Status, TeamDocument } from '../shared/types.js'
import { LocalStore, auditAccountContext } from '../server/store.js'

test('separate local accounts join one team, require approval and never expose credentials', async () => {
  const root = await fs.mkdtemp(path.join(import.meta.dirname, 'test-data-'))
  const shared = path.join(root, 'shared'); await fs.mkdir(shared)
  const clients = ['alpha', 'beta'].map(name => {
    const client = createApp({ dataDir: path.join(root, name) })
    return { ...client, server: client.app.listen(0, '127.0.0.1'), cookie: '', workspaceToken: '' }
  })
  for (const client of clients) if (!client.server.listening) await new Promise(resolve => client.server.once('listening', resolve))
  async function request(client: typeof clients[number], url: string, method = 'GET', body?: unknown) {
    const address = client.server.address() as { port: number }
    const response = await fetch(`http://127.0.0.1:${address.port}${url}`, { method, headers: { Cookie: client.cookie, 'X-Workspace-Token': client.workspaceToken, 'X-App-Request': 'vehicle-manager', ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined })
    client.workspaceToken = response.headers.get('x-workspace-token') || client.workspaceToken
    const cookie = response.headers.get('set-cookie')
    if (cookie) client.cookie = cookie.split(';')[0]
    return { status: response.status, data: await response.json() }
  }
  try {
    const [alpha, beta] = clients
    assert.equal((await request(alpha, '/api/status')).status, 401)
    for (const client of clients) assert.equal((await request(client, '/api/register', 'POST', { username: 'same-name', displayName: 'Member', password: 'setup-test-password' })).status, 201)
    assert.notEqual(alpha.store.db.prepare('SELECT id FROM accounts').get()!.id, beta.store.db.prepare('SELECT id FROM accounts').get()!.id)
    const unconfigured = (await request(alpha, '/api/status')).data as Status
    assert.equal(unconfigured.access, 'unconfigured'); assert.equal(unconfigured.sharedPath, null)
    const absent = await request(alpha, '/api/setup/check', 'POST', { path: path.join(root, 'absent') })
    assert.equal(absent.data.error, 'SHARE_UNAVAILABLE')
    assert.equal((await request(alpha, '/api/setup/configure', 'POST', { path: shared, mode: 'create', teamName: 'Engineering' })).status, 409)
    const created = await request(alpha, '/api/setup/configure', 'POST', { path: shared, mode: 'create', teamName: 'Engineering', confirmed: true })
    assert.equal(created.status, 200); assert.equal(created.data.member.role, 'admin')
    const check = await request(beta, '/api/setup/check', 'POST', { path: shared })
    const joined = await request(beta, '/api/setup/configure', 'POST', { path: shared, mode: 'join', teamId: check.data.teamId })
    assert.equal(joined.data.access, 'pending')
    assert.equal((await request(beta, '/api/team')).status, 403)
    const team = (await request(alpha, '/api/team')).data as TeamDocument
    assert.equal((await request(alpha, `/api/team/requests/${team.requests[0].id}/approve`, 'POST', { role: 'member', memberId: null, reason: 'Verified device and person' })).status, 200)
    const approved = (await request(beta, '/api/status')).data as Status
    assert.equal(approved.access, 'approved'); assert.equal(approved.member!.role, 'member')
    const deleteBody = { confirmation: 'DELETE_MEMBER', reason: 'Remove team membership' }
    assert.equal((await request(alpha, `/api/team/members/${approved.member!.id}`, 'DELETE', { reason: 'Missing confirmation' })).data.error, 'TEAM_CONFIRMATION_REQUIRED')
    assert.equal((await request(beta, `/api/team/members/${approved.member!.id}`, 'DELETE', deleteBody)).status, 403)
    assert.equal((await request(alpha, `/api/team/members/${created.data.member.id}`, 'DELETE', deleteBody)).data.error, 'MEMBER_IS_ADMIN')
    assert.equal((await request(alpha, '/api/team/upgrade-gate', 'POST', { reason: 'Missing confirmation' })).data.error, 'TEAM_CONFIRMATION_REQUIRED')
    assert.equal((await request(alpha, '/api/team/upgrade-gate', 'POST', { confirmation: 'UPGRADE_CLIENTS', reason: 'Confirm version impact' })).data.error, 'TWO_ADMINS_REQUIRED')
    assert.equal((await request(beta, `/api/team/members/${approved.member!.id}`, 'POST', { role: 'admin', enabled: true, reason: 'Self promotion' })).status, 403)
    const profileBody = { role: 'member', enabled: true, name: 'Real Name', nickname: 'Team Nickname', reason: 'Correct team profile' }
    assert.equal((await request(beta, `/api/team/members/${approved.member!.id}`, 'POST', profileBody)).status, 403)
    assert.equal((await request(alpha, `/api/team/members/${approved.member!.id}`, 'POST', { ...profileBody, name: ' ' })).status, 400)
    assert.equal((await request(alpha, `/api/team/members/${approved.member!.id}`, 'POST', { ...profileBody, nickname: 'x'.repeat(61) })).status, 400)
    const renamed = await request(alpha, `/api/team/members/${approved.member!.id}`, 'POST', profileBody)
    assert.equal(renamed.status, 200)
    assert.equal(renamed.data.members.find((item: { id: string }) => item.id === approved.member!.id).nickname, 'Team Nickname')
    const refreshed = (await request(beta, '/api/status')).data as Status
    assert.equal(refreshed.member!.name, 'Real Name')
    assert.equal(refreshed.member!.nickname, 'Team Nickname')
    assert.equal(refreshed.user!.displayName, 'Member')
    const auditBefore = alpha.store.auditEntries()
    const configured = auditBefore.find(entry => entry.action === 'workspace.configured')!
    const registered = auditBefore.find(entry => entry.action === 'account.registered')!
    assert.equal(configured.actor, 'Member (same-name)')
    assert.equal(registered.actor, configured.actor)
    assert.equal(configured.identity!.source, 'recorded')
    assert.equal(configured.identity!.account!.id, created.data.user.id)
    const exported = await request(alpha, '/api/business/export')
    assert.equal(exported.status, 200)
    const exportAudit = (await request(alpha, '/api/business/audit')).data.find((entry: { action: string }) => entry.action === 'business.exported')
    assert.equal(exportAudit.actor, configured.actor)
    assert.equal(exportAudit.identity.member.id, created.data.member.id)
    assert.equal(exportAudit.identity.account.id, created.data.user.id)
    assert.equal(exportAudit.detail.__auditActor, undefined)
    assert.ok(!JSON.stringify(exportAudit).includes('"hash"'))
    assert.ok(!JSON.stringify(exportAudit).includes('"salt"'))
    const sharedText = await fs.readFile(path.join(shared, 'team.json'), 'utf8')
    assert.ok(!sharedText.includes('setup-test-password')); assert.ok(!sharedText.includes('"hash"')); assert.ok(!sharedText.includes('"salt"'))
    await fs.rename(shared, `${shared}-offline`)
    const offline = (await request(beta, '/api/status')).data as Status
    assert.equal(offline.online, false); assert.equal(offline.access, 'approved')
    assert.equal((await request(alpha, '/api/team')).status, 503)
    await fs.rename(`${shared}-offline`, shared)
    assert.equal((await request(alpha, `/api/team/members/${approved.member!.id}`, 'POST', { role: 'member', enabled: false, reason: 'Access removed' })).status, 200)
    assert.equal((await request(beta, '/api/status')).data.access, 'disabled')
    const deleted = await request(alpha, `/api/team/members/${approved.member!.id}`, 'DELETE', deleteBody)
    assert.equal(deleted.status, 200)
    const deletedTeam = deleted.data as TeamDocument
    assert.ok(deletedTeam.members.find(member => member.id === approved.member!.id)!.deletedAt)
    assert.equal(deletedTeam.bindings.filter(binding => binding.memberId === approved.member!.id && binding.enabled).length, 0)
    assert.equal((await request(beta, '/api/status')).data.access, 'disabled')
    assert.equal((await request(beta, '/api/business/records')).status, 403)
    assert.equal((await request(alpha, `/api/team/members/${approved.member!.id}`, 'POST', profileBody)).status, 404)
    assert.equal((await request(alpha, `/api/team/members/${approved.member!.id}`, 'DELETE', deleteBody)).status, 200)
    assert.equal((await request(beta, '/api/login', 'POST', { username: 'same-name', password: 'setup-test-password' })).status, 200)
    assert.equal((await request(beta, '/api/status')).data.access, 'disabled')
    assert.equal((await request(alpha, '/api/logout', 'POST')).status, 200)
    assert.equal((await request(alpha, '/api/status')).status, 401)
    assert.equal((await request(alpha, '/api/login', 'POST', { username: 'same-name', password: 'wrong' })).status, 401)
    assert.equal((await request(alpha, '/api/login', 'POST', { username: 'same-name', password: 'setup-test-password' })).status, 200)
    assert.equal(alpha.store.db.prepare('PRAGMA integrity_check').get()!.integrity_check, 'ok')
  } finally {
    for (const client of clients) { await new Promise<void>(resolve => client.server.close(() => resolve())); client.store.db.close() }
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('device audit preserves identity snapshots across rename, missing members, offline reads and restart without guessing legacy accounts', async () => {
  const root = await fs.mkdtemp(path.join(import.meta.dirname, 'test-data-'))
  let store = new LocalStore(root)
  const account = { id: 'local-alice', username: 'alice', displayName: 'Local Alice' }
  const other = { id: 'local-bob', username: 'bob', displayName: 'Local Bob' }
  const actor = { id: 'team-alice', name: 'Team Alice', role: 'admin' as const, deviceId: store.deviceId }
  try {
    for (const user of [account, other]) store.db.prepare('INSERT INTO accounts VALUES(?,?,?,?,?,?)').run(user.id, user.username, user.displayName, 'private-salt', 'private-hash', '2026-11-11')
    store.event(account, 'workspace.configured', { mode: 'create' })
    await Promise.all([account, other].map(user => auditAccountContext.run(user, async () => {
      await new Promise(resolve => setImmediate(resolve))
      store.event(actor, 'business.exported', { owner: user.id })
    })))
    store.set('cachedTeam', { members: [{ id: actor.id, name: 'Renamed Team Alice' }], bindings: [{ memberId: actor.id, localUserId: account.id, deviceId: store.deviceId }, { memberId: actor.id, localUserId: other.id, deviceId: store.deviceId }] })
    const legacy = store.db.prepare('INSERT INTO local_events VALUES(?,?,?,?,?)')
    for (const id of [account.id, actor.id, 'missing-identity']) legacy.run(`legacy-${id}`, id, 'legacy.event', '{}', '2026-11-10')
    const check = () => {
      const entries = store.auditEntries()
      const exports = entries.filter(entry => entry.action === 'business.exported')
      assert.equal(exports.length, 2)
      for (const entry of exports) {
        const user = entry.detail.owner === account.id ? account : other
        assert.equal(entry.actor, `${user.displayName} (${user.username})`)
        assert.equal(entry.identity!.account!.id, user.id)
        assert.equal(entry.identity!.member!.name, 'Team Alice')
        assert.equal(entry.identity!.source, 'recorded')
        assert.equal(entry.identity!.actorId, actor.id)
        assert.equal(entry.identity!.deviceId, store.deviceId)
      }
      assert.equal(entries.find(entry => entry.id === `legacy-${account.id}`)!.identity!.source, 'resolved')
      assert.equal(entries.find(entry => entry.id === `legacy-${actor.id}`)!.identity!.account, undefined)
      assert.equal(entries.find(entry => entry.id === 'legacy-missing-identity')!.identity!.source, 'unknown')
      assert.equal(entries.find(entry => entry.id === 'legacy-missing-identity')!.actor, 'missing-identity')
      assert.equal(store.db.prepare('PRAGMA user_version').get()!.user_version, 6)
    }
    check()
    store.set('cachedTeam', { members: [], bindings: [] })
    store.db.prepare('UPDATE accounts SET display_name=? WHERE id=?').run('Renamed local account', account.id)
    check()
    store.db.close()
    store = new LocalStore(root)
    check()
    assert.equal(store.db.prepare("SELECT detail FROM local_events WHERE id='legacy-team-alice'").get()!.detail, '{}')
  } finally {
    store.db.close()
    await fs.rm(root, { recursive: true, force: true })
  }
})