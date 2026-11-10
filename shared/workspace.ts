import type { BusinessRecord, Fields, QuarantinedOperation, SyncStatus } from './business.js'
import type { ComponentTypeCatalog, ConfigurationRevisionSummary } from './configuration-revisions.js'

export type AuditEntry = { id: string; actor: string; created: string; action: string; detail: Fields }
export type WorkspaceData = { records: BusinessRecord[]; catalog: ComponentTypeCatalog; revisionSummaries: ConfigurationRevisionSummary[]; audit: AuditEntry[]; quarantined: QuarantinedOperation[]; modificationEnabled?: boolean }
export type WorkspaceSnapshot = { revision: string; data?: WorkspaceData; sync: SyncStatus }
