export const MIN_COLUMN_WIDTH = 80
export const MAX_COLUMN_WIDTH = 1000

export function clampColumnWidth(width: number): number {
  return Number.isFinite(width) ? Math.max(MIN_COLUMN_WIDTH, Math.min(MAX_COLUMN_WIDTH, Math.round(width))) : MIN_COLUMN_WIDTH
}

export function resizedColumnWidth(startWidth: number, startX: number, currentX: number): number {
  return clampColumnWidth(startWidth + (currentX - startX))
}

export function keyboardColumnWidth(width: number, key: string, shiftKey = false): number | null {
  const current = clampColumnWidth(width), step = shiftKey ? 50 : 10
  if (key === 'ArrowLeft') return clampColumnWidth(current - step)
  if (key === 'ArrowRight') return clampColumnWidth(current + step)
  if (key === 'Home') return MIN_COLUMN_WIDTH
  if (key === 'End') return MAX_COLUMN_WIDTH
  return null
}
