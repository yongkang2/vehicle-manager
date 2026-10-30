export type ApplicationUpdateStatus = {
  supported: boolean
  currentVersion: string
  availableVersion: string | null
  downloadedVersion: string | null
  phase: 'idle' | 'checking' | 'downloading' | 'ready' | 'restarting'
}
