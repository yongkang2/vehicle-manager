export type ApplicationUpdateStatus = {
  supported: boolean
  channel?: 'pre'
  currentVersion: string
  availableVersion: string | null
  downloadedVersion: string | null
  phase: 'idle' | 'checking' | 'downloading' | 'ready' | 'restarting'
}