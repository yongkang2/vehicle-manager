import express from 'express'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { LocalStore } from './store.js'
import { AppError, TeamDirectory } from './team.js'
import { installBusinessRoutes } from './business-routes.js'
import type { TeamDocument } from '../shared/types.js'

export type WorkspaceRow = { id: string; name: string; shared_path: string; directory: string }
export type WorkspaceSession = { workspace_id: string | null; workspace_epoch: number; sync_enabled: number; scope: string }

export class Workspaces {
  private readonly opened = new Map<string, ReturnType<Workspaces['open']>>()
  constructor(readonly root: LocalStore) {}
  private open(row: WorkspaceRow) {
    const directory = path.resolve(this.root.directory, row.directory)
    const store = directory === path.resolve(this.root.directory) ? this.root : new LocalStore(directory, this.root.deviceId)
    const teams = new TeamDirectory(store.get<TeamDocument>('cachedTeam'))
    const cache = (team: TeamDocument) => {
      if (team.id !== row.id) throw new AppError('WRONG_TEAM', 409)
      teams.observe(team)
      store.transaction(() => { store.set('cachedTeam', team); store.set('lastChecked', new Date().toISOString()) })
    }
    const router = express.Router()
    const services = installBusinessRoutes(router, store, teams, cache, this.root)
    return { row, store, teams, cache, router, ...services }
  }
  get(id: string) {
    const row = this.root.db.prepare('SELECT * FROM workspaces WHERE id=?').get(id) as WorkspaceRow | undefined
    if (!row) throw new AppError('WORKSPACE_NOT_FOUND', 404)
    let workspace = this.opened.get(id)
    if (!workspace) { workspace = this.open(row); this.opened.set(id, workspace) }
    return workspace
  }
  connect(team: TeamDocument, sharedPath: string, userId: string) {
    let row = this.root.db.prepare('SELECT * FROM workspaces WHERE id=?').get(team.id) as WorkspaceRow | undefined
    if (!row) {
      const directory = this.root.get('configuration') ? path.join('workspaces', createHash('sha256').update(team.id).digest('hex')) : '.'
      this.root.db.prepare('INSERT INTO workspaces VALUES(?,?,?,?)').run(team.id, team.name, sharedPath, directory)
      row = { id: team.id, name: team.name, shared_path: sharedPath, directory }
    }
    const workspace = this.get(team.id)
    workspace.cache(team)
    workspace.store.set('configuration', { teamId: team.id, sharedPath })
    this.root.transaction(() => {
      this.root.db.prepare('UPDATE workspaces SET name=?,shared_path=? WHERE id=?').run(team.name, sharedPath, team.id)
      this.root.db.prepare('INSERT OR IGNORE INTO account_workspaces VALUES(?,?)').run(userId, team.id)
    })
    return workspace
  }
  session(token: string): WorkspaceSession {
    const session = this.root.db.prepare('SELECT workspace_id,workspace_epoch,sync_enabled FROM sessions WHERE token=? AND expires>?').get(token, Date.now()) as WorkspaceSession | undefined
    if (!session) throw new AppError('LOGIN_REQUIRED', 401)
    return { ...session, scope: createHash('sha256').update(token).digest('hex').slice(0, 24) }
  }
  token(session: WorkspaceSession): string { return `${session.scope}:${session.workspace_id || 'none'}:${session.workspace_epoch}` }
  select(token: string, userId: string, id: string | null, resume: boolean) {
    if (id && !this.root.db.prepare('SELECT 1 FROM account_workspaces WHERE user_id=? AND workspace_id=?').get(userId, id)) throw new AppError('WORKSPACE_NOT_FOUND', 404)
    this.root.db.prepare('UPDATE sessions SET workspace_id=?,workspace_epoch=workspace_epoch+1,sync_enabled=? WHERE token=?').run(id, resume ? 1 : 0, token)
  }
  async settle(): Promise<void> { await Promise.all([...this.opened.values()].map(workspace => workspace.synchronization.settle())) }
  async tick(): Promise<void> {
    const rows = this.root.db.prepare('SELECT DISTINCT workspace_id FROM sessions WHERE workspace_id IS NOT NULL AND sync_enabled=1 AND expires>?').all(Date.now())
    for (const row of rows) await this.get(row.workspace_id as string).tick()
  }
  async close(): Promise<void> {
    await this.settle()
    for (const workspace of this.opened.values()) if (workspace.store !== this.root) workspace.store.db.close()
    this.root.db.close()
  }
}