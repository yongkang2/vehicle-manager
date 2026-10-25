import { useEffect, useRef, useState } from 'react'
import { defaultVehicleTablePreferences } from '../shared/vehicle-table'
import type { VehicleTablePreferences } from '../shared/vehicle-table'
import { createWorkspaceScope } from './api'
import { VehicleTablePreferenceSession } from './vehicle-table-preference-session'
import type { VehicleTablePreferenceState } from './vehicle-table-preference-session'

export function useVehicleTablePreferences(active: boolean) {
  const [state, setState] = useState<VehicleTablePreferenceState>(() => ({ layout: defaultVehicleTablePreferences(), saveStatus: 'loading' }))
  const session = useRef<VehicleTablePreferenceSession | null>(null)
  useEffect(() => () => { session.current?.dispose(); session.current = null }, [])
  useEffect(() => {
    if (!active || session.current) return
    const current = new VehicleTablePreferenceSession(createWorkspaceScope(), value => {
      if (session.current === current) setState(value)
    })
    session.current = current; current.start()
  }, [active])
  return { ...state, onChange: (next: VehicleTablePreferences) => session.current?.change(next), retry: () => session.current?.retry() }
}
