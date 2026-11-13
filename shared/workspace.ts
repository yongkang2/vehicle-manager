import type { BusinessRecord, Fields, QuarantinedOperation, SyncStatus } from './business.js'
import type { ComponentTypeCatalog, ConfigurationRevisionSummary } from './configuration-revisions.js'
import type { LocalUser } from './types.js'
import type { VehicleListMeta } from './vehicle-list.js'

export type AuditIdentity = { actorId: string; deviceId: string; account?: LocalUser; member?: { id: string; name: string }; source: 'recorded' | 'resolved' | 'unknown' }
export type AuditEntry = { id: string; actor: string; created: string; action: string; detail: Fields; identity?: AuditIdentity }
export type WorkspaceData = { historyRevision: number; records: BusinessRecord[]; catalog: ComponentTypeCatalog; revisionSummaries: ConfigurationRevisionSummary[]; audit: AuditEntry[]; quarantined: QuarantinedOperation[]; modificationEnabled?: boolean; vehicleList?: VehicleListMeta }
export type WorkspacePatch = { baseRevision: string; upsert: BusinessRecord[]; removed: string[]; data: Omit<WorkspaceData, 'records'> }
export type WorkspaceSnapshot = { revision: string; data?: WorkspaceData; patch?: WorkspacePatch; sync: SyncStatus }
