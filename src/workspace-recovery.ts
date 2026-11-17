import { ApiError } from './api'
import { readWithDeadline } from './read-deadline'

type RecoverySteps = {
  cancelReads: () => void
  probe: (signal: AbortSignal) => Promise<void>
  repair: (signal: AbortSignal) => Promise<void>
  reload: (signal: AbortSignal) => Promise<void>
}

/** Coalesces explicit read recovery; never retries a business mutation. */
export class WorkspaceRecovery {
  private active: { controller: AbortController; promise: Promise<void> } | null = null
  get busy() { return this.active !== null }
  cancel() { this.active?.controller.abort(); this.active = null }
  run(steps: RecoverySteps): Promise<void> {
    if (this.active) return this.active.promise
    const controller = new AbortController()
    const attempt = { controller, promise: Promise.resolve() }
    this.active = attempt
    attempt.promise = (async () => {
      steps.cancelReads()
      await readWithDeadline(steps.probe, { signal: controller.signal, timeoutMs: 5000, timeoutError: new ApiError('LOCAL_SERVICE_UNAVAILABLE') })
      try {
        await readWithDeadline(steps.repair, { signal: controller.signal, timeoutMs: 5000, timeoutError: new ApiError('LOCAL_SERVICE_UNAVAILABLE') })
      } catch (error) {
        controller.signal.throwIfAborted()
        if (error instanceof ApiError) throw error
        throw new ApiError('LOCAL_SERVICE_UNAVAILABLE')
      }
      await readWithDeadline(steps.reload, { signal: controller.signal, timeoutMs: 30000, timeoutError: new ApiError('REFRESH_TIMEOUT') })
    })().finally(() => { if (this.active === attempt) this.active = null })
    return attempt.promise
  }
}
