export type Role = 'admin' | 'member'
export type LocalUser = { id: string; username: string; displayName: string }
export type Identity = { deviceId: string; deviceName: string; localUserId: string; displayName: string }
export type Member = { id: string; name: string; nickname?: string; role: Role; enabled: boolean; created: string }
export type Binding = { id: string; deviceId: string; localUserId: string; deviceName: string; memberId: string; enabled: boolean }
export type JoinRequest = { id: string; identity: Identity; status: 'pending' | 'approved' | 'rejected' | 'cancelled'; created: string }
export type TeamEvent = { id: string; actorId: string; action: string; targetId: string; reason: string; created: string }
export type TeamDocument = {
  application: 'stellantis-vehicle-manager'
  protocol: 1 | 2
  minWritableVersion?: string
  id: string
  name: string
  revision: number
  created: string
  members: Member[]
  bindings: Binding[]
  requests: JoinRequest[]
  events: TeamEvent[]
}
export type ConnectionCheck = { kind: 'empty' | 'existing'; path: string; teamId?: string; teamName?: string; revision?: number }
export type Access = 'unconfigured' | 'pending' | 'rejected' | 'unbound' | 'disabled' | 'approved'
export type Status = {
  version: string
  user: LocalUser | null
  deviceId: string
  deviceName: string
  sharedPath: string | null
  teamId: string | null
  workspaceToken: string
  syncPaused: boolean
  teamName: string | null
  access: Access
  online: boolean
  error: string | null
  lastChecked: string | null
  member: Member | null
}
export type WorkspaceSummary = { id: string; name: string; sharedPath: string; access: Access; pending: number; conflicts: number; selected: boolean }