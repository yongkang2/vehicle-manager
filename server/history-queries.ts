import { fork } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { AppError } from './team.js'
import type { History } from './history.js'

type Result = ReturnType<History['query']>
type Pending = { resolve: (result: Result) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }

export class HistoryQueries {
  private child: ChildProcess | null = null
  private pending = new Map<number, Pending>()
  private nextId = 0
  private closed = false
  constructor(private directory: string) {}

  private fail(error: Error): void {
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error) }
    this.pending.clear()
  }
  private start(): ChildProcess {
    const compiled = fileURLToPath(new URL('./history-worker.js', import.meta.url))
    const entry = existsSync(compiled) ? compiled : fileURLToPath(new URL('./history-worker.ts', import.meta.url))
    const child = fork(entry, [this.directory], { execArgv: entry.endsWith('.ts') ? ['--import', 'tsx'] : [], stdio: ['ignore', 'ignore', 'ignore', 'ipc'], serialization: 'advanced', windowsHide: true })
    this.child = child
    child.unref(); child.channel?.unref()
    child.on('message', (message: { id: number; result?: Result; error?: string }) => {
      const pending = this.pending.get(message.id)
      if (!pending) return
      clearTimeout(pending.timer); this.pending.delete(message.id)
      if (message.result) pending.resolve(message.result)
      else pending.reject(new AppError(message.error || 'SERVER_ERROR', 503))
    })
    const stopped = () => {
      if (this.child !== child) return
      this.child = null; this.fail(new AppError(this.closed ? 'REQUEST_CANCELLED' : 'SERVER_ERROR', 503))
    }
    child.on('error', stopped); child.on('exit', stopped)
    return child
  }
  query(input: Parameters<History['query']>[0]): Promise<Result> {
    if (this.closed) return Promise.reject(new AppError('REQUEST_CANCELLED', 409))
    if (this.pending.size >= 8) return Promise.reject(new AppError('WORKSPACE_BUSY', 503))
    const child = this.child || this.start(), id = ++this.nextId
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { if (this.child === child) { this.child = null; child.kill(); this.fail(new AppError('SERVER_ERROR', 503)) } }, 30000)
      this.pending.set(id, { resolve, reject, timer })
      child.send({ id, input }, error => { if (error && this.child === child) { this.child = null; child.kill(); this.fail(new AppError('SERVER_ERROR', 503)) } })
    })
  }
  async close(): Promise<void> {
    this.closed = true
    const child = this.child
    this.child = null; this.fail(new AppError('REQUEST_CANCELLED', 409))
    if (!child) return
    child.ref()
    await new Promise<void>(resolve => { child.once('exit', () => resolve()); child.kill() })
  }
}