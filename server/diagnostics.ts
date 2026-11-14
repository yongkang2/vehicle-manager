import { AsyncLocalStorage } from 'node:async_hooks'
import { appendFileSync, existsSync, mkdirSync, renameSync, statSync, unlinkSync } from 'node:fs'
import path from 'node:path'
import { appVersion } from '../shared/version.js'

export const diagnosticContext = new AsyncLocalStorage<{ requestId: string }>()

const limit = 2 * 1024 * 1024
const code = (value: unknown) => typeof value === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(value) ? value : undefined
function safeError(error: unknown): Record<string, unknown> {
  const value = error instanceof Error ? error : null
  const frames = value?.stack?.split('\n').slice(1).map(line => /[/\\]([A-Za-z0-9_-]{1,64}\.(?:[cm]?js|tsx?)):(\d{1,10}):(\d{1,10})/.exec(line)).filter(match => match).slice(0, 8).map(match => `${match![1]}:${match![2]}:${match![3]}`) || []
  const cause = value?.cause as { code?: unknown } | undefined
  return { name: value instanceof TypeError ? 'TypeError' : value instanceof RangeError ? 'RangeError' : 'Error', code: code((error as { code?: unknown } | null)?.code), causeCode: code(cause?.code), frames }
}

/** Only allowlisted metadata is persisted; error messages, bodies and absolute paths are deliberately excluded. */
export class Diagnostics {
  private warned = false
  constructor(private readonly directory: string) {}
  write(level: 'info' | 'warn' | 'error', event: string, fields: Record<string, unknown> = {}, error?: unknown): void {
    try {
      const data: Record<string, unknown> = {}
      for (const key of ['status', 'durationMs', 'pending', 'conflicts', 'port', 'bytes', 'exitCode', 'lockWaitMs', 'lockHeldMs']) if (typeof fields[key] === 'number' && Number.isFinite(fields[key])) data[key] = fields[key]
      if (fields.timings && typeof fields.timings === 'object') {
        const timings = fields.timings as Record<string, unknown>
        data.timings = Object.fromEntries(['opening', 'operations', 'records', 'publishing', 'refreshing'].filter(key => typeof timings[key] === 'number' && Number.isFinite(timings[key]) && Number(timings[key]) >= 0).map(key => [key, timings[key]]))
      }
      if (typeof fields.requestId === 'string' && /^[a-f0-9-]{36}$/.test(fields.requestId)) data.requestId = fields.requestId
      if (typeof fields.method === 'string' && ['GET', 'HEAD', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'].includes(fields.method)) data.method = fields.method
      if (typeof fields.route === 'string' && fields.route.length <= 180 && /^\/api(?:\/[A-Za-z0-9:_-]+)*$/.test(fields.route)) data.route = fields.route
      if (typeof fields.phase === 'string' && ['idle', 'syncing', 'ready', 'busy', 'offline', 'conflict'].includes(fields.phase)) data.phase = fields.phase
      if (code(fields.code)) data.code = code(fields.code)
      const record = JSON.stringify({ time: new Date().toISOString(), level, event: /^[a-z][a-z0-9_.]{0,63}$/.test(event) ? event : 'diagnostic.unknown', version: appVersion, node: process.versions.node, pid: process.pid, ...diagnosticContext.getStore(), ...data, ...(error === undefined ? {} : { error: safeError(error) }) }) + '\n'
      const folder = path.join(this.directory, 'logs'), filename = path.join(folder, 'diagnostics.jsonl')
      mkdirSync(folder, { recursive: true })
      if (existsSync(filename) && statSync(filename).size + Buffer.byteLength(record) > limit) {
        const oldest = `${filename}.3`; if (existsSync(oldest)) unlinkSync(oldest)
        for (let index = 2; index >= 1; index--) if (existsSync(`${filename}.${index}`)) renameSync(`${filename}.${index}`, `${filename}.${index + 1}`)
        renameSync(filename, `${filename}.1`)
      }
      appendFileSync(filename, record, { mode: 0o600 })
    } catch {
      if (!this.warned) { this.warned = true; try { console.error('Diagnostic log unavailable; business operations will continue.') } catch { /* Diagnostics must not fail business work, even when stderr is unavailable. */ } }
    }
  }
}
