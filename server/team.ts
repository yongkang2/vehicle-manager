import { promises as fs } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { AsyncLocalStorage } from 'node:async_hooks'
import { hostname } from 'node:os'
import { performance } from 'node:perf_hooks'
import { setTimeout as delay } from 'node:timers/promises'
import type { Binding, ConnectionCheck, Identity, Member, Role, TeamDocument } from '../shared/types.js'
import { appVersion } from '../shared/version.js'

export class AppError extends Error {
  constructor(public code: string, public status = 400) { super(code) }
}
const created = () => new Date().toISOString()
const application = 'stellantis-vehicle-manager'
const filename = 'team.json'
const lockName = '.vehicle-manager-team-lock'
const lockStale = 120000
const lockUpdate = 10000
const lockWait = 3000
type TeamLease = { directory: string; owner: string; content: string; renewed: number; lost: boolean }
const activeLease = new AsyncLocalStorage<TeamLease>()

async function checkLease(lease: TeamLease): Promise<void> {
  try {
    if (lease.lost || performance.now() - lease.renewed >= lockStale) throw new Error('expired')
    const entries = await fs.readdir(lease.directory)
    if (entries.length !== 1 || entries[0] !== path.basename(lease.owner) || await fs.readFile(lease.owner, 'utf8') !== lease.content) throw new Error('replaced')
    if (lease.lost || performance.now() - lease.renewed >= lockStale) throw new Error('expired')
  } catch {
    lease.lost = true
    throw new AppError('SHARE_LOCK_LOST', 409)
  }
}

export async function assertTeamLock(): Promise<void> {
  const lease = activeLease.getStore()
  if (lease) await checkLease(lease)
}

async function recoverLock(directory: string, lock: string): Promise<boolean> {
  const probe = path.join(directory, `.vdm-probe-${randomUUID()}`)
  try {
    const entries = await fs.readdir(lock)
    if (entries.some(name => name !== 'owner.json' && !/^lease-[a-f0-9-]{36}\.json$/.test(name))) return false
    const files = entries.map(name => path.join(lock, name))
    const targets = files.length ? files : [lock]
    const observed = await Promise.all(targets.map(file => fs.stat(file)))
    await fs.writeFile(probe, '', { flag: 'wx' })
    const currentTime = (await fs.stat(probe)).mtimeMs
    if (observed.some(stat => currentTime - stat.mtimeMs < lockStale)) return false
    const current = await Promise.all(targets.map(file => fs.stat(file)))
    if (current.some((stat, index) => stat.mtimeMs !== observed[index].mtimeMs || stat.ino !== observed[index].ino)) return false
    for (const file of files) await fs.unlink(file).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error })
    await fs.rmdir(lock).catch(error => { if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes((error as NodeJS.ErrnoException).code || '')) throw error })
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true
    throw error
  } finally { await fs.unlink(probe).catch(() => {}) }
}

async function acquireLease(directory: string): Promise<TeamLease> {
  const lock = path.join(directory, lockName), deadline = performance.now() + lockWait
  await fs.stat(directory)
  while (true) {
    let acquired = false
    const token = randomUUID(), owner = path.join(lock, `lease-${token}.json`)
    try {
      await fs.mkdir(lock)
      acquired = true
      const lease: TeamLease = { directory: lock, owner, content: JSON.stringify({ token, host: hostname(), process: process.pid, created: created() }), renewed: performance.now(), lost: false }
      await fs.writeFile(owner, lease.content, { flag: 'wx' })
      await checkLease(lease)
      return lease
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (acquired) {
        await fs.unlink(owner).catch(() => {})
        await fs.rmdir(lock).catch(() => {})
        if ((error instanceof AppError && error.code === 'SHARE_LOCK_LOST') || ['ENOENT', 'EACCES', 'EPERM'].includes(code || '')) {
          if (performance.now() >= deadline) {
            if (['EACCES', 'EPERM'].includes(code || '')) throw error
            throw new AppError('SHARE_BUSY', 409)
          }
          await delay(40 + Math.random() * 80)
          continue
        }
        throw error
      }
      if (['EACCES', 'EPERM'].includes(code || '')) {
        if (performance.now() >= deadline) throw error
        await delay(40 + Math.random() * 80)
        continue
      }
      if (code !== 'EEXIST') throw error
      if (performance.now() >= deadline) throw new AppError('SHARE_BUSY', 409)
      try { if (await recoverLock(directory, lock)) continue } catch (recoveryError) {
        if (!['EACCES', 'EPERM'].includes((recoveryError as NodeJS.ErrnoException).code || '') || performance.now() >= deadline) throw recoveryError
      }
      await delay(Math.min(40 + Math.random() * 80, Math.max(1, deadline - performance.now())))
    }
  }
}

export function normalizeDirectory(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 1024 || value.includes('\0') || !path.isAbsolute(value.trim())) throw new AppError('INVALID_PATH')
  return path.resolve(value.trim())
}

function mapFileError(error: unknown): never {
  if (error instanceof AppError) throw error
  const code = (error as NodeJS.ErrnoException).code
  if (['EACCES', 'EPERM', 'EROFS'].includes(code || '')) throw new AppError('SHARE_ACCESS_DENIED', 503)
  if (code === 'ENOENT' || code === 'ENOTDIR') throw new AppError('SHARE_UNAVAILABLE', 503)
  throw new AppError('SHARE_IO_ERROR', 503)
}

async function readDocument(directory: string): Promise<TeamDocument> {
  const file = await fs.readFile(path.join(directory, filename))
  if (file.length > 2 * 1024 * 1024) throw new AppError('UNSUPPORTED_TEAM')
  let team: TeamDocument
  try { team = JSON.parse(file.toString('utf8')) as TeamDocument } catch { throw new AppError('UNSUPPORTED_TEAM') }
  if (team.application !== application || ![1, 2].includes(team.protocol) || (team.protocol === 2 && !validVersion(team.minWritableVersion)) || typeof team.id !== 'string' || typeof team.name !== 'string' || !Number.isSafeInteger(team.revision) || !Array.isArray(team.members) || !Array.isArray(team.bindings) || !Array.isArray(team.requests) || !Array.isArray(team.events)) throw new AppError('UNSUPPORTED_TEAM')
  return team
}

function validVersion(value: unknown): value is string { return typeof value === 'string' && /^\d+\.\d+\.\d+$/.test(value) }

function compareVersions(left: string, right: string): number {
  const a = left.split('.').map(Number), b = right.split('.').map(Number)
  for (let index = 0; index < 3; index++) if (a[index] !== b[index]) return a[index] - b[index]
  return 0
}

async function atomicDocument(directory: string, team: TeamDocument): Promise<void> {
  const temporary = path.join(directory, `.vdm-write-${randomUUID()}.tmp`)
  try {
    const handle = await fs.open(temporary, 'wx')
    try { await handle.writeFile(JSON.stringify(team, null, 2)); await handle.sync() } finally { await handle.close() }
    await assertTeamLock()
    await fs.rename(temporary, path.join(directory, filename))
  } finally { await fs.rm(temporary, { force: true }).catch(() => { }) }
}

export function bindingFor(team: TeamDocument, identity: Identity): { member?: Member; binding?: Binding } {
  const binding = team.bindings.find(item => item.deviceId === identity.deviceId && item.localUserId === identity.localUserId)
  return { binding, member: binding ? team.members.find(item => item.id === binding.memberId) : undefined }
}

function requireAdmin(team: TeamDocument, identity: Identity): Member {
  const { binding, member } = bindingFor(team, identity)
  if (!binding?.enabled || !member?.enabled || member.role !== 'admin') throw new AppError('ADMIN_REQUIRED', 403)
  return member
}

function effectiveAdmins(team: TeamDocument): number {
  return team.members.filter(member => member.enabled && member.role === 'admin' && team.bindings.some(binding => binding.enabled && binding.memberId === member.id)).length
}

function event(team: TeamDocument, actorId: string, action: string, targetId: string, reason: string): void {
  team.events.push({ id: randomUUID(), actorId, action, targetId, reason, created: created() })
  team.revision++
}

async function locked<T>(directory: string, work: () => Promise<T>): Promise<T> {
  let lease: TeamLease | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let updating: Promise<void> | undefined
  let stopped = false
  const schedule = () => {
    timer = setTimeout(() => {
      updating = (async () => {
        await checkLease(lease!)
        const renewed = performance.now()
        await fs.writeFile(lease!.owner, lease!.content, { flag: 'r+' })
        if (performance.now() - lease!.renewed >= lockStale) throw new Error('expired')
        lease!.renewed = renewed
      })().catch(() => { lease!.lost = true }).finally(() => { if (!stopped && !lease!.lost) schedule() })
    }, lockUpdate)
    timer.unref()
  }
  try {
    lease = await acquireLease(directory)
    schedule()
    return await activeLease.run(lease, async () => {
      await assertTeamLock()
      const result = await work()
      await assertTeamLock()
      return result
    })
  } catch (error) { return mapFileError(error) }
  finally {
    stopped = true
    if (lease) lease.lost = true
    clearTimeout(timer)
    await updating
    if (lease) {
      await fs.unlink(lease.owner).catch(() => {})
      await fs.rmdir(lease.directory).catch(() => {})
    }
  }
}

export class TeamDirectory {
  private readonly observed = new Map<string, { revision: number; content: string }>()
  constructor(initial?: TeamDocument | null, private readonly version = appVersion) { if (initial) this.observe(initial) }

  observe(team: TeamDocument): void {
    const previous = this.observed.get(team.id)
    const content = JSON.stringify(team)
    if (previous && (team.revision < previous.revision || (team.revision === previous.revision && content !== previous.content))) throw new AppError('TEAM_ROLLBACK', 409)
    this.observed.set(team.id, { revision: team.revision, content })
  }

  async read(directory: string, expectedId?: string): Promise<TeamDocument> {
    try {
      const team = await readDocument(directory)
      if (expectedId && team.id !== expectedId) throw new AppError('WRONG_TEAM', 409)
      if (team.protocol === 2 && compareVersions(this.version, team.minWritableVersion!) < 0) throw new AppError('CLIENT_UPGRADE_REQUIRED', 409)
      this.observe(team)
      return team
    } catch (error) { return mapFileError(error) }
  }

  async withAccess<T>(directory: string, teamId: string, identity: Identity, admin: boolean, work: (team: TeamDocument, member: Member) => Promise<T>): Promise<T> {
    return locked(directory, async () => {
      const team = await this.read(directory, teamId)
      const access = bindingFor(team, identity)
      if (!access.binding?.enabled || !access.member?.enabled) throw new AppError('ACCESS_DISABLED', 403)
      if (admin && access.member.role !== 'admin') throw new AppError('ADMIN_REQUIRED', 403)
      return work(team, access.member)
    })
  }

  async probe(input: unknown): Promise<ConnectionCheck> {
    const directory = normalizeDirectory(input)
    const original = path.join(directory, `.vdm-probe-${randomUUID()}`)
    const renamed = `${original}.renamed`
    try {
      const stat = await fs.stat(directory)
      if (!stat.isDirectory()) throw new AppError('SHARE_NOT_DIRECTORY')
      const handle = await fs.open(original, 'wx')
      try { await handle.writeFile('vehicle-manager-connection-check'); await handle.sync() } finally { await handle.close() }
      if (await fs.readFile(original, 'utf8') !== 'vehicle-manager-connection-check') throw new AppError('SHARE_IO_ERROR', 503)
      await fs.rename(original, renamed)
      await fs.unlink(renamed)
      const entries = await fs.readdir(directory)
      if (entries.includes(filename)) {
        const team = await this.read(directory)
        return { kind: 'existing', path: directory, teamId: team.id, teamName: team.name, revision: team.revision }
      }
      if (entries.filter(name => !name.startsWith('.vdm-probe-')).length) throw new AppError('SHARE_NOT_EMPTY', 409)
      return { kind: 'empty', path: directory }
    } catch (error) { return mapFileError(error) }
    finally { await Promise.all([original, renamed].map(file => fs.rm(file, { force: true }).catch(() => { }))) }
  }

  async create(directory: string, teamName: string, identity: Identity): Promise<TeamDocument> {
    if (!teamName.trim() || teamName.length > 80) throw new AppError('INVALID_TEAM_NAME')
    return locked(directory, async () => {
      const entries = (await fs.readdir(directory)).filter(name => name !== lockName && !name.startsWith('.vdm-probe-'))
      if (entries.length) throw new AppError('SHARE_NOT_EMPTY', 409)
      const member: Member = { id: randomUUID(), name: identity.displayName, role: 'admin', enabled: true, created: created() }
      const team: TeamDocument = {
        application, protocol: 1, id: randomUUID(), name: teamName.trim(), revision: 1, created: created(), members: [member],
        bindings: [{ id: randomUUID(), deviceId: identity.deviceId, deviceName: identity.deviceName, localUserId: identity.localUserId, memberId: member.id, enabled: true }],
        requests: [], events: [],
      }
      event(team, member.id, 'team.created', team.id, 'Explicit team initialization')
      await atomicDocument(directory, team)
      return team
    })
  }

  async enableUpgradeGate(directory: string, teamId: string, actor: Identity, reason: string): Promise<TeamDocument> {
    return locked(directory, async () => {
      const team = await this.read(directory, teamId)
      const admin = requireAdmin(team, actor)
      if (team.protocol === 2 && compareVersions(this.version, team.minWritableVersion!) <= 0) return team
      if (effectiveAdmins(team) < 2) throw new AppError('TWO_ADMINS_REQUIRED', 409)
      team.protocol = 2
      team.minWritableVersion = this.version
      event(team, admin.id, 'team.upgrade-gate.advanced', team.id, reason)
      await atomicDocument(directory, team)
      return team
    })
  }

  async join(directory: string, teamId: string, identity: Identity): Promise<TeamDocument> {
    return locked(directory, async () => {
      const team = await this.read(directory, teamId)
      if (bindingFor(team, identity).binding) return team
      if (!team.requests.some(request => request.identity.deviceId === identity.deviceId && request.identity.localUserId === identity.localUserId && request.status === 'pending')) {
        const id = randomUUID()
        team.requests.push({ id, identity, status: 'pending', created: created() })
        event(team, identity.localUserId, 'join.requested', id, 'Local account and device registration')
        await atomicDocument(directory, team)
      }
      return team
    })
  }

  async cancelRequest(directory: string, teamId: string, identity: Identity): Promise<TeamDocument> {
    return locked(directory, async () => {
      const team = await this.read(directory, teamId)
      const request = team.requests.find(item => item.status === 'pending' && item.identity.deviceId === identity.deviceId && item.identity.localUserId === identity.localUserId)
      if (!request) throw new AppError('REQUEST_CHANGED', 409)
      request.status = 'cancelled'
      event(team, identity.localUserId, 'join.cancelled', request.id, 'Withdrawn by applicant')
      await atomicDocument(directory, team)
      return team
    })
  }

  async approve(directory: string, teamId: string, actor: Identity, requestId: string, role: Role, existingMemberId: string | null, reason: string): Promise<TeamDocument> {
    return locked(directory, async () => {
      const team = await this.read(directory, teamId)
      const admin = requireAdmin(team, actor)
      const request = team.requests.find(item => item.id === requestId && item.status === 'pending')
      if (!request) throw new AppError('REQUEST_CHANGED', 409)
      let member = existingMemberId ? team.members.find(item => item.id === existingMemberId && item.enabled) : undefined
      if (existingMemberId && !member) throw new AppError('MEMBER_UNAVAILABLE', 409)
      if (!member) {
        member = { id: randomUUID(), name: request.identity.displayName, role, enabled: true, created: created() }
        team.members.push(member)
      }
      if (team.bindings.some(item => item.deviceId === request.identity.deviceId && item.localUserId === request.identity.localUserId)) throw new AppError('REQUEST_CHANGED', 409)
      team.bindings.push({ id: randomUUID(), deviceId: request.identity.deviceId, deviceName: request.identity.deviceName, localUserId: request.identity.localUserId, memberId: member.id, enabled: true })
      request.status = 'approved'
      event(team, admin.id, 'join.approved', request.id, reason)
      await atomicDocument(directory, team)
      return team
    })
  }

  async changeMember(directory: string, teamId: string, actor: Identity, memberId: string, role: Role, enabled: boolean, reason: string, profile?: { name: string; nickname: string }): Promise<TeamDocument> {
    return locked(directory, async () => {
      const team = await this.read(directory, teamId)
      const admin = requireAdmin(team, actor)
      const member = team.members.find(item => item.id === memberId)
      if (!member || member.deletedAt) throw new AppError('MEMBER_UNAVAILABLE', 404)
      if (profile) {
        if (typeof profile.name !== 'string' || !profile.name.trim() || profile.name.length > 60 || typeof profile.nickname !== 'string' || profile.nickname.length > 60) throw new AppError('INVALID_INPUT')
        member.name = profile.name.trim()
        member.nickname = profile.nickname.trim()
      }
      member.role = role; member.enabled = enabled
      if (!effectiveAdmins(team)) throw new AppError('LAST_ADMIN', 409)
      event(team, admin.id, 'member.updated', memberId, reason)
      await atomicDocument(directory, team)
      return team
    })
  }

  async removeMember(directory: string, teamId: string, actor: Identity, memberId: string, reason: string): Promise<TeamDocument> {
    return locked(directory, async () => {
      const team = await this.read(directory, teamId)
      const admin = requireAdmin(team, actor)
      const member = team.members.find(item => item.id === memberId)
      if (!member) throw new AppError('MEMBER_UNAVAILABLE', 404)
      if (member.role === 'admin') throw new AppError('MEMBER_IS_ADMIN', 409)
      if (member.deletedAt) return team
      member.enabled = false
      member.deletedAt = created()
      for (const binding of team.bindings) if (binding.memberId === memberId) binding.enabled = false
      event(team, admin.id, 'member.deleted', memberId, reason)
      await atomicDocument(directory, team)
      return team
    })
  }

  async reject(directory: string, teamId: string, actor: Identity, requestId: string, reason: string): Promise<TeamDocument> {
    return locked(directory, async () => {
      const team = await this.read(directory, teamId)
      const admin = requireAdmin(team, actor)
      const request = team.requests.find(item => item.id === requestId && item.status === 'pending')
      if (!request) throw new AppError('REQUEST_CHANGED', 409)
      request.status = 'rejected'
      event(team, admin.id, 'join.rejected', request.id, reason)
      await atomicDocument(directory, team)
      return team
    })
  }

  async revokeDevice(directory: string, teamId: string, actor: Identity, bindingId: string, reason: string): Promise<TeamDocument> {
    return locked(directory, async () => {
      const team = await this.read(directory, teamId)
      const admin = requireAdmin(team, actor)
      const binding = team.bindings.find(item => item.id === bindingId)
      if (!binding) throw new AppError('MEMBER_UNAVAILABLE', 404)
      binding.enabled = false
      if (!effectiveAdmins(team)) throw new AppError('LAST_ADMIN', 409)
      event(team, admin.id, 'device.revoked', bindingId, reason)
      await atomicDocument(directory, team)
      return team
    })
  }
}