import type { BusinessRecord, Change, Fields, QuarantinedOperation, SyncStatus } from './business.js'

export type AuditEntry = { id: string; actor: string; created: string; action: string; detail: Fields }
export type WorkspaceData = { records: BusinessRecord[]; changes: Change[]; audit: AuditEntry[]; quarantined: QuarantinedOperation[] }
export type WorkspaceSnapshot = { revision: string; data?: WorkspaceData; sync: SyncStatus }
