/** Bound read-only work, including transports that do not settle after abort. */
export async function readWithDeadline<T>(read: (signal: AbortSignal) => Promise<T>, options: { signal?: AbortSignal; timeoutMs: number; timeoutError: Error }): Promise<T> {
  const controller = new AbortController()
  const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal
  let onAbort: () => void = () => {}
  const cancelled = new Promise<never>((_, reject) => {
    onAbort = () => reject(signal.reason ?? new DOMException('Read cancelled', 'AbortError'))
    if (signal.aborted) onAbort()
    else signal.addEventListener('abort', onAbort, { once: true })
  })
  const timer = setTimeout(() => controller.abort(options.timeoutError), options.timeoutMs)
  try {
    return await Promise.race([cancelled, Promise.resolve().then(() => {
      signal.throwIfAborted()
      return read(signal)
    })])
  } finally {
    clearTimeout(timer)
    signal.removeEventListener('abort', onAbort)
  }
}
