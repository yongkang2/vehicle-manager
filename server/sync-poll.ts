/** Scheduling only: manual synchronization never consults this background timer. */
export class SyncPoll {
  private nextAt = 0
  private busyCount = 0
  ready(): boolean { return Date.now() >= this.nextAt }
  complete(busy: boolean): void {
    this.busyCount = busy ? Math.min(this.busyCount + 1, 2) : 0
    if (!busy) { this.nextAt = 0; return }
    const delay = Math.min(120000, 30000 * 2 ** this.busyCount)
    this.nextAt = Date.now() + Math.round(delay * (0.8 + Math.random() * 0.4))
  }
}
