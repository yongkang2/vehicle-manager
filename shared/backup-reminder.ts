export function backupReminderDue(lastBackupAt: string | null, now = Date.now()): boolean {
  const previous = lastBackupAt ? Date.parse(lastBackupAt) : NaN
  return !Number.isFinite(previous) || now - previous >= 7 * 24 * 60 * 60 * 1000
}
export function localReminderDay(date = new Date()): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}
