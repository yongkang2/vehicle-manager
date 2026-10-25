import { defaultVehicleTablePreferences, parseVehicleTablePreferences } from '../shared/vehicle-table.js'
import type { VehicleTablePreferences } from '../shared/vehicle-table.js'
import { LocalStore } from './store.js'
import { AppError } from './team.js'

/** Private to one local account and workspace; never enters the business outbox. */
export class VehicleTablePreferencesStore {
  constructor(readonly store: LocalStore) {}
  private key(accountId: string): string { return `vehicleTablePreferences:${accountId}` }
  get(accountId: string): VehicleTablePreferences {
    const stored = this.store.get<unknown>(this.key(accountId))
    if (stored === null) return defaultVehicleTablePreferences()
    const parsed = parseVehicleTablePreferences(stored)
    if (!parsed) throw new AppError('INVALID_INPUT')
    return parsed
  }
  put(accountId: string, input: unknown): VehicleTablePreferences {
    const parsed = parseVehicleTablePreferences(input)
    if (!parsed) throw new AppError('INVALID_INPUT')
    this.store.transaction(() => {
      this.store.assertWritable()
      this.store.set(this.key(accountId), parsed)
    })
    return parsed
  }
}
