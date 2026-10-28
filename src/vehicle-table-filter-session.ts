import { createContext, useContext } from 'react'
import type { Dispatch, SetStateAction } from 'react'
import type { VehicleColumnFilters } from './vehicle-table-filters'

type FilterSession = { filters: VehicleColumnFilters; setFilters: Dispatch<SetStateAction<VehicleColumnFilters>> }
export const VehicleTableFilterContext = createContext<FilterSession | null>(null)

export function useVehicleTableFilterSession(): FilterSession {
  const session = useContext(VehicleTableFilterContext)
  if (!session) throw new Error('Vehicle table filters require a workspace')
  return session
}
