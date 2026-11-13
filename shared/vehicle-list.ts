import type { VehicleColumnFilters, VehicleFilterColumnId } from './vehicle-table-values.js'
export type VehicleListQuery = { search: string; status?: string; archived: boolean; page: number; pageSize: number; filters: VehicleColumnFilters; detailId?: string; reportId?: string }
export type VehicleListMeta = { total: number; page: number; pageSize: number; ids: string[]; counts: Record<string, number>; options: Partial<Record<VehicleFilterColumnId, string[]>>; detailId: string | null; reportId: string | null }
