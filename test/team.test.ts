import { test } from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { TeamDirectory } from '../server/team.js'
import { appVersion } from '../shared/version.js'
import type { Identity } from '../shared/types.js'

const admin: Identity = { deviceId: 'admin-device', deviceName: 'ADMIN-PC', localUserId: 'admin-account', displayName: 'Administrator' }
const member: Identity = { deviceId: 'member-device', deviceName: 'MEMBER-PC', localUserId: 'member-account', displayName: 'Team member' }

test('setup requires an existing empty directory; join and administration use latest team roles', async () => {
  const root = await fs.mkdtemp(path.join(import.meta.dirname, 'test-data-'))
  const service = new TeamDirectory()
  try {
    const absent = path.join(root, 'not-created')
    await assert.rejects(service.probe(absent), { code: 'SHARE_UNAVAILABLE' })
    await assert.rejects(fs.stat(absent), { code: 'ENOENT' })
    await assert.rejects(service.probe('relative/path'), { code: 'INVALID_PATH' })
    const shared = path.join(root, 'shared'); await fs.mkdir(shared)
    assert.equal((await service.probe(shared)).kind, 'empty')
    assert.deepEqual(await fs.readdir(shared), [])
    const team = await service.create(shared, 'Engineering', admin)
    assert.equal(team.members[0].role, 'admin')
    await assert.rejects(service.create(shared, 'Another team', member), { code: 'SHARE_NOT_EMPTY' })
    assert.equal((await service.probe(shared)).teamId, team.id)
    const pending = await service.join(shared, team.id, member)
    assert.equal(pending.requests[0].status, 'pending')
    assert.equal((await service.join(shared, team.id, member)).requests.length, 1)
    await assert.rejects(service.approve(shared, team.id, member, pending.requests[0].id, 'admin', null, 'self approval'), { code: 'ADMIN_REQUIRED' })
    const approved = await service.approve(shared, team.id, admin, pending.requests[0].id, 'member', null, 'Identity checked')
    const target = approved.members.find(item => item.role === 'member')!
    await assert.rejects(service.changeMember(shared, team.id, member, target.id, 'admin', true, 'self promotion'), { code: 'ADMIN_REQUIRED' })
    await assert.rejects(service.changeMember(shared, team.id, admin, team.members[0].id, 'member', true, 'demotion'), { code: 'LAST_ADMIN' })
    await assert.rejects(service.revokeDevice(shared, team.id, admin, team.bindings[0].id, 'revoke'), { code: 'LAST_ADMIN' })
    const secondDevice = { ...member, deviceId: 'second-device', localUserId: 'second-local-account' }
    const secondRequest = await service.join(shared, team.id, secondDevice)
    const bound = await service.approve(shared, team.id, admin, secondRequest.requests.at(-1)!.id, 'admin', target.id, 'Same person, another device')
    assert.equal(bound.members.length, 2)
    assert.equal(bound.members.find(item => item.id === target.id)!.role, 'member')
    const rejectedDevice = { ...member, deviceId: 'rejected-device', localUserId: 'rejected-account' }
    const requested = await service.join(shared, team.id, rejectedDevice)
    const requestId = requested.requests.at(-1)!.id
    await assert.rejects(service.reject(shared, team.id, member, requestId, 'Not allowed'), { code: 'ADMIN_REQUIRED' })
    assert.equal((await service.reject(shared, team.id, admin, requestId, 'Unknown device')).requests.at(-1)!.status, 'rejected')
    assert.equal((await service.join(shared, team.id, rejectedDevice)).requests.at(-1)!.status, 'pending')
    await assert.rejects(service.read(shared, 'different-team'), { code: 'WRONG_TEAM' })
    const lock = path.join(shared, '.vehicle-manager-team-lock'); await fs.mkdir(lock)
    await assert.rejects(service.changeMember(shared, team.id, admin, target.id, 'admin', true, 'role change'), { code: 'SHARE_BUSY' })
    await fs.rm(lock, { recursive: true })
    assert.ok((await service.read(shared)).events.length >= 4)
    const currentDocument = await fs.readFile(path.join(shared, 'team.json'), 'utf8')
    await fs.writeFile(path.join(shared, 'team.json'), JSON.stringify(team))
    await assert.rejects(service.changeMember(shared, team.id, admin, target.id, 'admin', true, 'Must not mutate an old roster'), { code: 'TEAM_ROLLBACK' })
    assert.equal(await fs.readFile(path.join(shared, 'team.json'), 'utf8'), JSON.stringify(team))
    await fs.writeFile(path.join(shared, 'team.json'), currentDocument)
    const occupied = path.join(root, 'occupied'); await fs.mkdir(occupied); await fs.writeFile(path.join(occupied, 'HEAD.json'), '{}')
    await assert.rejects(service.probe(occupied), { code: 'SHARE_NOT_EMPTY' })
  } finally { await fs.rm(root, { recursive: true, force: true }) }
})

test('two independent initializers cannot both create administrators', async () => {
  const root = await fs.mkdtemp(path.join(import.meta.dirname, 'test-data-'))
  const service = new TeamDirectory()
  try {
    const results = await Promise.allSettled([service.create(root, 'First', admin), service.create(root, 'Second', member)])
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1)
    assert.equal((await service.read(root)).members.length, 1)
  } finally { await fs.rm(root, { recursive: true, force: true }) }
})

test('upgrade gate requires an administrator and rejects clients below its minimum version', async () => {
  const root = await fs.mkdtemp(path.join(import.meta.dirname, 'test-data-'))
  const shared = path.join(root, 'shared'); await fs.mkdir(shared)
  const current = new TeamDirectory(null, appVersion), older = new TeamDirectory(null, '1.0.3')
  try {
    const team = await current.create(shared, 'Engineering', admin)
    await assert.rejects(current.enableUpgradeGate(shared, team.id, member, 'Require current version'), { code: 'ADMIN_REQUIRED' })
    await assert.rejects(current.enableUpgradeGate(shared, team.id, admin, 'Require current version'), { code: 'TWO_ADMINS_REQUIRED' })
    const secondAdmin = { ...member, displayName: 'Second administrator' }
    const request = await current.join(shared, team.id, secondAdmin)
    await current.approve(shared, team.id, admin, request.requests[0].id, 'admin', null, 'Approve second administrator')
    const gated = await current.enableUpgradeGate(shared, team.id, admin, 'Require current version')
    assert.equal(gated.protocol, 2)
    assert.equal(gated.minWritableVersion, appVersion)
    await assert.rejects(older.read(shared, team.id), { code: 'CLIENT_UPGRADE_REQUIRED' })
    assert.equal((await current.read(shared, team.id)).protocol, 2)
    const nextVersion = new TeamDirectory(null, '1.2.0')
    const advanced = await nextVersion.enableUpgradeGate(shared, team.id, admin, 'Raise minimum version')
    assert.equal(advanced.minWritableVersion, '1.2.0')
    await assert.rejects(current.read(shared, team.id), { code: 'CLIENT_UPGRADE_REQUIRED' })
  } finally { await fs.rm(root, { recursive: true, force: true }) }
})