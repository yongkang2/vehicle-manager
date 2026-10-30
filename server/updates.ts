import { execFile } from 'node:child_process'
import { promises as fs } from 'node:fs'
import { promisify } from 'node:util'
import { AppError } from './team.js'
import { appVersion } from '../shared/version.js'
import type { ApplicationUpdateStatus } from '../shared/application-updates.js'

const execute = promisify(execFile)
export type UpdateResult = { version: string | null; downloaded: string | null }
export type UpdateBackend = { run: (command: 'check' | 'download') => Promise<UpdateResult>; prepare: (version: string) => Promise<void> }
export function installedUpdateBackend(): UpdateBackend | undefined {
  const home = process.env.VEHICLE_MANAGER_STABLE_HOME, request = process.env.VEHICLE_MANAGER_UPDATE_REQUEST
  if (!home || !request) return undefined
  return {
    async run(command) {
      const { stdout } = await execute(process.execPath, [`${home}/stable-launcher.mjs`, `--${command}`], { env: { ...process.env, VEHICLE_MANAGER_PROGRAM_DIR: home }, windowsHide: true, timeout: 15 * 60 * 1000, maxBuffer: 128 * 1024 })
      const result = JSON.parse(stdout.trim()) as UpdateResult
      if ((result.version !== null && typeof result.version !== 'string') || (result.downloaded !== null && typeof result.downloaded !== 'string')) throw new Error('Invalid updater response')
      return result
    },
    async prepare(version) { await fs.writeFile(request, JSON.stringify({ version }), { flag: 'wx' }) },
  }
}

export class ApplicationUpdates {
  private phase: 'idle' | 'checking' | 'downloading' | 'ready' | 'restarting' = 'idle'
  private availableVersion: string | null = null
  private downloaded: string | null = null
  constructor(private readonly backend?: UpdateBackend) {}
  get installing(): boolean { return this.phase === 'restarting' }
  status(): ApplicationUpdateStatus { return { supported: Boolean(this.backend), channel: this.backend ? 'pre' : undefined, currentVersion: process.env.VEHICLE_MANAGER_RELEASE_VERSION || appVersion, availableVersion: this.availableVersion, downloadedVersion: this.downloaded, phase: this.phase } }
  async run(command: 'check' | 'download') {
    if (!this.backend) throw new AppError('UPDATE_NOT_INSTALLED', 409)
    if (this.phase !== 'idle' && this.phase !== 'ready') throw new AppError('UPDATE_BUSY', 409)
    this.phase = command === 'check' ? 'checking' : 'downloading'
    try {
      const result = await this.backend.run(command)
      this.availableVersion = result.version
      this.downloaded = result.downloaded
      return this.status()
    } catch { throw new AppError('UPDATE_SOURCE_UNAVAILABLE', 503) }
    finally { this.phase = this.downloaded ? 'ready' : 'idle' }
  }
  async install(preflight: () => Promise<void>): Promise<void> {
    if (!this.backend) throw new AppError('UPDATE_NOT_INSTALLED', 409)
    if (this.phase !== 'ready' || !this.downloaded) throw new AppError('UPDATE_NOT_READY', 409)
    this.phase = 'restarting'
    try { await preflight(); await this.backend.prepare(this.downloaded) }
    catch (error) { this.phase = 'ready'; throw error }
  }
}