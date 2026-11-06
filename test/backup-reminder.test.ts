import { test } from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { TeamDirectory } from '../server/team.js'
import { backupReminderDue } from '../shared/backup-reminder.js'
const identity = { deviceId: 'trial-device', deviceName: 'Trial', localUserId: 'trial-admin', displayName: 'Trial administrator' }
test('backup reminder uses exactly seven elapsed days and treats unknown timestamps as unknown', () => {
  const now = Date.parse('2026-11-05T02:00:00Z')
  assert.equal(backupReminderDue(null, now), true)
  assert.equal(backupReminderDue('2026-10-29T02:00:00Z', now), true)
  assert.equal(backupReminderDue('2026-10-29T02:00:00.001Z', now), false)
  assert.equal(backupReminderDue('invalid', now), true)
})
test('completed backup timestamp is shared, survives reopening and requires live administrator access', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'backup-reminder-'))
  try {
    const service = new TeamDirectory(), team = await service.create(root, 'Reminder team', identity)
    const completed = await service.recordBackup(root, team.id, identity)
    assert.ok(completed.lastBackupAt)
    assert.equal((await new TeamDirectory().read(root, team.id)).lastBackupAt, completed.lastBackupAt)
    await assert.rejects(service.recordBackup(root, team.id, { ...identity, localUserId: 'unbound' }))
    assert.equal((await new TeamDirectory().read(root, team.id)).lastBackupAt, completed.lastBackupAt)
  } finally { await fs.rm(root, { recursive: true, force: true }) }
})
