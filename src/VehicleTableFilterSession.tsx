import { useState } from 'react'
import type { PropsWithChildren } from 'react'
import type { VehicleColumnFilters } from './vehicle-table-filters'
import { VehicleTableFilterContext } from './vehicle-table-filter-session'

/** The keyed workspace owns this memory, independently of the currently open page. */
export function VehicleTableFilterProvider({ children }: PropsWithChildren) {
  const [filters, setFilters] = useState<VehicleColumnFilters>({})
  return <VehicleTableFilterContext value={{ filters, setFilters }}>{children}</VehicleTableFilterContext>
}
