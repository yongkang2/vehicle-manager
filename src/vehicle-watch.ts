export const watchColors = { gold: '#9a6700', blue: '#2458a6', purple: '#7950a1', teal: '#187760', orange: '#b65c16' } as const
export type WatchColor = keyof typeof watchColors
export type VehicleWatch = { onlyWatched: boolean; vehicles: Record<string, WatchColor> }
export function watchKey(userId: string, workspaceId: string) {
  return `vdm-vehicle-watch:${JSON.stringify([userId, workspaceId])}`
}
export function parseWatch(raw: string | null): VehicleWatch {
  const empty: VehicleWatch = { onlyWatched: false, vehicles: {} }
  try {
    const value = JSON.parse(raw || 'null')
    if (!value || typeof value.vehicles !== 'object' || !value.vehicles || Array.isArray(value.vehicles)) return empty
    return { onlyWatched: value.onlyWatched === true, vehicles: Object.fromEntries(Object.entries(value.vehicles).filter(([id, color]) => id.length > 0 && id.length <= 200 && typeof color === 'string' && Object.hasOwn(watchColors, color))) as Record<string, WatchColor> }
  } catch { return empty }
}
