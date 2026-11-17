export type PlateExpiryState = 'normal' | 'expiring' | 'expired'

function calendarDay(value: unknown): number | null {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null
  const time = Date.parse(`${value}T00:00:00.000Z`)
  if (!Number.isFinite(time) || new Date(time).toISOString().slice(0, 10) !== value) return null
  return Math.floor(time / 86400000)
}

/** Compare local calendar labels without elapsed-hour or daylight-saving shifts. */
export function plateExpiryState(value: unknown, localToday: string): PlateExpiryState {
  const expiry = calendarDay(value), today = calendarDay(localToday)
  if (expiry === null || today === null) return 'normal'
  const remaining = expiry - today
  return remaining < 0 ? 'expired' : remaining < 7 ? 'expiring' : 'normal'
}

export function plateExpiryClassName(value: unknown, localToday: string): '' | 'expiring-date' | 'expired-date' {
  const state = plateExpiryState(value, localToday)
  return state === 'expired' ? 'expired-date' : state === 'expiring' ? 'expiring-date' : ''
}
