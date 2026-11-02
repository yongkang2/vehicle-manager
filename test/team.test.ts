import { test } from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { performance } from 'node:perf_hooks'
import { setTimeout as delay } from 'node:timers/promises'
import { TeamDirectory } from '../server/team.js'
import { atomicFile } from '../server/sync.js'
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
    assert.equal(bound.bindings.filter(item => item.memberId === target.id).length, 2)
    const renamed = await service.changeMember(shared, team.id, admin, target.id, 'member', true, 'Correct team profile', { name: '  Real Name  ', nickname: '  Team Nickname  ' })
    assert.equal(renamed.members.find(item => item.id === target.id)!.name, 'Real Name')
    assert.equal(renamed.members.find(item => item.id === target.id)!.nickname, 'Team Nickname')
    assert.equal(renamed.bindings.filter(item => item.memberId === target.id).length, 2)
    await assert.rejects(service.changeMember(shared, team.id, member, target.id, 'member', true, 'Unauthorized rename', { name: 'Other', nickname: '' }), { code: 'ADMIN_REQUIRED' })
    await assert.rejects(service.changeMember(shared, team.id, admin, target.id, 'member', true, 'Invalid name', { name: ' ', nickname: '' }), { code: 'INVALID_INPUT' })
    await assert.rejects(service.changeMember(shared, team.id, admin, target.id, 'member', true, 'Long nickname', { name: 'Real Name', nickname: 'x'.repeat(61) }), { code: 'INVALID_INPUT' })
    const revoked = await service.revokeDevice(shared, team.id, admin, bound.bindings.at(-1)!.id, 'Retire second device')
    assert.equal(revoked.bindings.filter(item => item.memberId === target.id && item.enabled).length, 1)
    assert.equal(revoked.members.find(item => item.id === target.id)!.enabled, true)
    const cleared = await service.changeMember(shared, team.id, admin, target.id, 'member', true, 'Clear nickname', { name: 'Real Name', nickname: '' })
    assert.equal(cleared.members.find(item => item.id === target.id)!.nickname, '')
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

test('only administrators can remove non-admin members and all their devices without erasing history', async () => {
  const root = await fs.mkdtemp(path.join(import.meta.dirname, 'test-data-'))
  const service = new TeamDirectory()
  try {
    const team = await service.create(root, 'Engineering', admin)
    const request = await service.join(root, team.id, member)
    const approved = await service.approve(root, team.id, admin, request.requests[0].id, 'member', null, 'Approve member')
    const target = approved.members.find(item => item.role === 'member')!
    const secondDevice = { ...member, deviceId: 'extra-member-device' }
    const extraRequest = await service.join(root, team.id, secondDevice)
    await service.approve(root, team.id, admin, extraRequest.requests.at(-1)!.id, 'member', target.id, 'Approve second device')
    await assert.rejects(service.removeMember(root, team.id, member, target.id, 'Self removal'), { code: 'ADMIN_REQUIRED' })
    await assert.rejects(service.removeMember(root, team.id, admin, team.members[0].id, 'Delete administrator'), { code: 'MEMBER_IS_ADMIN' })
    await service.changeMember(root, team.id, admin, target.id, 'admin', true, 'Promote before stale deletion')
    await assert.rejects(service.removeMember(root, team.id, admin, target.id, 'Stale deletion'), { code: 'MEMBER_IS_ADMIN' })
    await service.changeMember(root, team.id, admin, target.id, 'member', true, 'Restore member role')
    const removed = await service.removeMember(root, team.id, admin, target.id, 'Remove departed member')
    assert.equal(removed.members.filter(item => !item.deletedAt).length, 1)
    assert.equal(removed.members.find(item => item.id === target.id)!.enabled, false)
    assert.equal(removed.bindings.filter(item => item.memberId === target.id && item.enabled).length, 0)
    assert.equal(removed.events.at(-1)!.action, 'member.deleted')
    assert.equal(removed.events.at(-1)!.reason, 'Remove departed member')
    assert.ok(removed.events.some(item => item.action === 'join.approved'))
    for (const identity of [member, secondDevice]) await assert.rejects(service.withAccess(root, team.id, identity, false, async () => true), { code: 'ACCESS_DISABLED' })
    await assert.rejects(service.changeMember(root, team.id, admin, target.id, 'member', true, 'Stale reactivation'), { code: 'MEMBER_UNAVAILABLE' })
    const retried = await service.removeMember(root, team.id, admin, target.id, 'Retry removal')
    assert.equal(retried.revision, removed.revision)
    assert.equal((await service.join(root, team.id, member)).requests.length, removed.requests.length)
  } finally { await fs.rm(root, { recursive: true, force: true }) }
})

test('abandoned team locks recover automatically, including incomplete and legacy owners', async () => {
  const root = await fs.mkdtemp(path.join(import.meta.dirname, 'test-data-'))
  const service = new TeamDirectory()
  try {
    const team = await service.create(root, 'Engineering', admin)
    const lock = path.join(root, '.vehicle-manager-team-lock')
    for (const owner of [null, '{incomplete', JSON.stringify({ token: 'legacy-owner', process: 12345, created: '2020-01-01T00:00:00.000Z' })]) {
      await fs.mkdir(lock)
      if (owner !== null) await fs.writeFile(path.join(lock, 'owner.json'), owner)
      const stale = new Date(Date.now() - 300000)
      if (owner !== null) await fs.utimes(path.join(lock, 'owner.json'), stale, stale)
      await fs.utimes(lock, stale, stale)
      assert.equal(await service.withAccess(root, team.id, admin, false, async () => 'recovered'), 'recovered')
      await assert.rejects(fs.stat(lock), { code: 'ENOENT' })
    }
  } finally { await fs.rm(root, { recursive: true, force: true }) }
})

test('contending clients serialize roster changes and safely retry bounded busy responses', async () => {
  const root = await fs.mkdtemp(path.join(import.meta.dirname, 'test-data-'))
  try {
    const team = await new TeamDirectory().create(root, 'Engineering', admin)
    const results = await Promise.allSettled(Array.from({ length: 20 }, async (_, index) => {
      const client = new TeamDirectory()
      for (let attempt = 0; ; attempt++) {
        try { return await client.join(root, team.id, { ...member, deviceId: `device-${index}` }) }
        catch (error) { if ((error as { code?: string }).code !== 'SHARE_BUSY' || attempt >= 4) throw error }
      }
    }))
    assert.deepEqual(results.filter(result => result.status === 'rejected'), [])
    const current = await new TeamDirectory().read(root)
    assert.equal(current.requests.length, 20)
    assert.equal(new Set(current.requests.map(request => request.identity.deviceId)).size, 20)
    assert.equal(current.revision, team.revision + 20)
    await assert.rejects(fs.stat(path.join(root, '.vehicle-manager-team-lock')), { code: 'ENOENT' })
  } finally { await fs.rm(root, { recursive: true, force: true }) }
})

test('a failed owner write and a failed operation both release only their own lock', async context => {
  const root = await fs.mkdtemp(path.join(import.meta.dirname, 'test-data-'))
  const service = new TeamDirectory(), writeFile = fs.writeFile.bind(fs)
  try {
    const failing = context.mock.method(fs, 'writeFile', async (...args: Parameters<typeof fs.writeFile>) => {
      if (String(args[0]).includes(`${path.sep}lease-`)) throw Object.assign(new Error('denied'), { code: 'EACCES' })
      return writeFile(...args)
    })
    await assert.rejects(service.create(root, 'Engineering', admin), { code: 'SHARE_ACCESS_DENIED' })
    failing.mock.restore()
    assert.deepEqual(await fs.readdir(root), [])
    let interrupted = false
    const transient = context.mock.method(fs, 'writeFile', async (...args: Parameters<typeof fs.writeFile>) => {
      if (!interrupted && String(args[0]).includes(`${path.sep}lease-`)) {
        interrupted = true
        throw Object.assign(new Error('directory delete pending'), { code: 'EPERM' })
      }
      return writeFile(...args)
    })
    const team = await service.create(root, 'Engineering', admin)
    transient.mock.restore()
    assert.equal(interrupted, true)
    await assert.rejects(service.withAccess(root, team.id, admin, false, async () => { throw new Error('operation failed') }), { code: 'SHARE_IO_ERROR' })
    assert.equal(await service.withAccess(root, team.id, admin, false, async () => true), true)
  } finally { context.mock.restoreAll(); await fs.rm(root, { recursive: true, force: true }) }
})

test('a live lease renews and is not stolen by another client', async () => {
  const root = await fs.mkdtemp(path.join(import.meta.dirname, 'test-data-'))
  const service = new TeamDirectory()
  try {
    const team = await service.create(root, 'Engineering', admin)
    await service.withAccess(root, team.id, admin, false, async () => {
      const lock = path.join(root, '.vehicle-manager-team-lock')
      const [owner] = await fs.readdir(lock), before = await fs.stat(path.join(lock, owner))
      await delay(10500)
      assert.ok((await fs.stat(path.join(lock, owner))).mtimeMs > before.mtimeMs)
      await assert.rejects(new TeamDirectory().join(root, team.id, member), { code: 'SHARE_BUSY' })
      assert.deepEqual(await fs.readdir(lock), [owner])
    })
    assert.equal((await service.read(root)).requests.length, 0)
  } finally { await fs.rm(root, { recursive: true, force: true }) }
})

test('a displaced owner cannot publish business files or remove its successor lock', async () => {
  const root = await fs.mkdtemp(path.join(import.meta.dirname, 'test-data-'))
  const service = new TeamDirectory()
  let releaseSuccessor!: () => void
  const successorGate = new Promise<void>(resolve => { releaseSuccessor = resolve })
  let successor: Promise<unknown> | undefined
  try {
    const team = await service.create(root, 'Engineering', admin)
    const destination = path.join(root, 'HEAD.json')
    await fs.writeFile(destination, 'original')
    await assert.rejects(service.withAccess(root, team.id, admin, false, async () => {
      const lock = path.join(root, '.vehicle-manager-team-lock')
      await fs.rename(lock, `${lock}.saved`)
      let entered!: () => void
      const ready = new Promise<void>(resolve => { entered = resolve })
      successor = new TeamDirectory().withAccess(root, team.id, admin, false, async () => { entered(); await successorGate })
      await ready
      await assert.rejects(atomicFile(destination, 'stale publication'), { code: 'SHARE_LOCK_LOST' })
      assert.equal(await fs.readFile(destination, 'utf8'), 'original')
    }), { code: 'SHARE_LOCK_LOST' })
    assert.equal((await fs.readdir(path.join(root, '.vehicle-manager-team-lock'))).length, 1)
    releaseSuccessor()
    await successor
    await assert.rejects(fs.stat(path.join(root, '.vehicle-manager-team-lock')), { code: 'ENOENT' })
  } finally { releaseSuccessor(); await successor; await fs.rm(root, { recursive: true, force: true }) }
})

test('publication rechecks the lease after preparing either team or business data', async context => {
  const root = await fs.mkdtemp(path.join(import.meta.dirname, 'test-data-'))
  const service = new TeamDirectory(), open = fs.open.bind(fs)
  try {
    const team = await service.create(root, 'Engineering', admin)
    for (const kind of ['team', 'business']) {
      const lock = path.join(root, '.vehicle-manager-team-lock')
      const destination = path.join(root, kind === 'team' ? 'team.json' : 'HEAD.json')
      if (kind === 'business') await fs.writeFile(destination, 'original')
      const original = await fs.readFile(destination, 'utf8')
      const opening = context.mock.method(fs, 'open', async (...args: Parameters<typeof fs.open>) => {
        const handle = await open(...args)
        if (String(args[0]).endsWith('.tmp')) {
          const sync = handle.sync.bind(handle)
          context.mock.method(handle, 'sync', async () => {
            await sync()
            await fs.rename(lock, `${lock}.saved-${kind}`)
          })
        }
        return handle
      })
      await assert.rejects(kind === 'team'
        ? service.changeMember(root, team.id, admin, team.members[0].id, 'admin', true, 'Interrupted publication', { name: 'Must not publish', nickname: '' })
        : service.withAccess(root, team.id, admin, false, () => atomicFile(destination, 'must not publish')), { code: 'SHARE_LOCK_LOST' })
      opening.mock.restore()
      assert.equal(await fs.readFile(destination, 'utf8'), original)
      assert.equal((await fs.readdir(root)).filter(name => name.endsWith('.tmp')).length, 0)
    }
  } finally { context.mock.restoreAll(); await fs.rm(root, { recursive: true, force: true }) }
})

test('a process resuming after its lease deadline cannot publish even before a takeover', async context => {
  const root = await fs.mkdtemp(path.join(import.meta.dirname, 'test-data-'))
  const service = new TeamDirectory(), clock = performance.now.bind(performance)
  try {
    const team = await service.create(root, 'Engineering', admin), destination = path.join(root, 'HEAD.json')
    await fs.writeFile(destination, 'original')
    await assert.rejects(service.withAccess(root, team.id, admin, false, async () => {
      context.mock.method(performance, 'now', () => clock() + 120001)
      await assert.rejects(atomicFile(destination, 'expired publication'), { code: 'SHARE_LOCK_LOST' })
    }), { code: 'SHARE_LOCK_LOST' })
    context.mock.restoreAll()
    assert.equal(await fs.readFile(destination, 'utf8'), 'original')
    assert.equal(await service.withAccess(root, team.id, admin, false, async () => true), true)
  } finally { context.mock.restoreAll(); await fs.rm(root, { recursive: true, force: true }) }
})

test('a killed process leaves a recoverable lease and concurrent recovery admits only one writer', async () => {
  const root = await fs.mkdtemp(path.join(import.meta.dirname, 'test-data-'))
  let child: ReturnType<typeof spawn> | undefined
  try {
    const service = new TeamDirectory(), team = await service.create(root, 'Engineering', admin)
    child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `
      import { TeamDirectory } from ${JSON.stringify(new URL('../server/team.ts', import.meta.url).href)};
      import { setTimeout as delay } from 'node:timers/promises';
      await new TeamDirectory().withAccess(process.argv[1], process.argv[2], JSON.parse(process.argv[3]), false, async () => {
        process.stdout.write('locked');
        await delay(60000);
      });
    `, root, team.id, JSON.stringify(admin)], { stdio: ['ignore', 'pipe', 'pipe'] })
    const exit = once(child, 'exit')
    const ready = await Promise.race([once(child.stdout!, 'data').then(([bytes]) => String(bytes)), exit.then(() => 'exited')])
    assert.equal(ready, 'locked')
    child.kill()
    await exit
    const lock = path.join(root, '.vehicle-manager-team-lock'), [owner] = await fs.readdir(lock)
    const stale = new Date(Date.now() - 300000)
    await fs.utimes(path.join(lock, owner), stale, stale)
    let active = 0, maximum = 0
    const results = await Promise.allSettled(Array.from({ length: 12 }, () => new TeamDirectory().withAccess(root, team.id, admin, false, async () => {
      active++; maximum = Math.max(maximum, active)
      await delay(10)
      active--
    })))
    assert.deepEqual(results.filter(result => result.status === 'rejected'), [])
    assert.equal(maximum, 1)
    await assert.rejects(fs.stat(lock), { code: 'ENOENT' })
  } finally { if (child && child.exitCode === null && child.signalCode === null) { child.kill(); await once(child, 'exit') }; await fs.rm(root, { recursive: true, force: true }) }
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
    const updated = await current.changeMember(shared, team.id, admin, gated.members[0].id, 'admin', true, 'Edit profile after upgrade', { name: 'Team administrator', nickname: 'Team lead' })
    assert.equal(updated.members[0].nickname, 'Team lead')
    assert.equal(updated.minWritableVersion, appVersion)
    await assert.rejects(older.changeMember(shared, team.id, admin, gated.members[0].id, 'member', true, 'Stale client update'), { code: 'CLIENT_UPGRADE_REQUIRED' })
    const extraDevice = { ...secondAdmin, deviceId: 'second-admin-extra-device' }
    const extraRequest = await current.join(shared, team.id, extraDevice)
    const bound = await current.approve(shared, team.id, admin, extraRequest.requests.at(-1)!.id, 'member', gated.members[1].id, 'Bind another approved device')
    assert.equal(bound.members.length, 2)
    assert.equal(bound.bindings.filter(binding => binding.memberId === gated.members[1].id && binding.enabled).length, 2)
    assert.equal(bound.members[1].role, 'admin')
    const nextVersion = new TeamDirectory(null, '1.2.0')
    const advanced = await nextVersion.enableUpgradeGate(shared, team.id, admin, 'Raise minimum version')
    assert.equal(advanced.minWritableVersion, '1.2.0')
    await assert.rejects(current.read(shared, team.id), { code: 'CLIENT_UPGRADE_REQUIRED' })
  } finally { await fs.rm(root, { recursive: true, force: true }) }
})