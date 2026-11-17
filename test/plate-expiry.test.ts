import { test } from 'node:test'
import assert from 'node:assert/strict'
import { localReminderDay } from '../shared/backup-reminder.js'
import { plateExpiryClassName, plateExpiryState } from '../src/plate-expiry.js'
import type { PlateExpiryState } from '../src/plate-expiry.js'

function inTimezone(zone: string, check: () => void): void {
  const previous = process.env.TZ
  process.env.TZ = zone
  try { check() }
  finally { if (previous === undefined) delete process.env.TZ; else process.env.TZ = previous }
}

test('plate expiry distinguishes expired dates from today through six days and excludes exactly seven days', () => {
  const today = '2026-11-17'
  const cases: [string, PlateExpiryState][] = [
    ['2026-11-16', 'expired'], ['2026-11-17', 'expiring'], ['2026-11-18', 'expiring'],
    ['2026-11-23', 'expiring'], ['2026-11-24', 'normal'], ['2026-11-25', 'normal'],
  ]
  for (const [expiry, expected] of cases) assert.equal(plateExpiryState(expiry, today), expected, expiry)
  assert.equal(plateExpiryClassName('2026-11-16', today), 'expired-date')
  assert.equal(plateExpiryClassName('2026-11-17', today), 'expiring-date')
  assert.equal(plateExpiryClassName('2026-11-23', today), 'expiring-date')
  assert.equal(plateExpiryClassName('2026-11-24', today), '')
})

test('calendar boundaries retain the strict six-versus-seven-day rule across months, years and leap day', () => {
  for (const [today, sixDays, sevenDays] of [
    ['2026-01-28', '2026-02-03', '2026-02-04'],
    ['2026-12-28', '2027-01-03', '2027-01-04'],
    ['2028-02-23', '2028-02-29', '2028-03-01'],
    ['2000-02-23', '2000-02-29', '2000-03-01'],
  ]) {
    assert.equal(plateExpiryState(sixDays, today), 'expiring', today)
    assert.equal(plateExpiryState(sevenDays, today), 'normal', today)
  }
  assert.equal(plateExpiryState('1969-12-31', '1970-01-01'), 'expired')
  assert.equal(plateExpiryState('0099-12-31', '0100-01-01'), 'expired')
})

test('blank, non-date and impossible values retain normal styling rather than false warnings', () => {
  for (const value of [undefined, null, '', ' ', false, 20261117, [], {}, new Date(),
    'invalid', '2026/11/17', '2026-1-17', '2026-11-7', '2026-11-17 ', ' 2026-11-17',
    '2026-11-17T00:00:00Z', '2026-02-29', '2026-02-30', '1900-02-29', '2026-04-31',
    '2026-00-17', '2026-13-17', '2026-11-00', '2026-11-32', '10000-01-01']) {
    assert.equal(plateExpiryState(value, '2026-11-17'), 'normal', String(value))
    assert.equal(plateExpiryClassName(value, '2026-11-17'), '')
  }
  for (const today of ['', 'invalid', '2026-02-29', '2026-11-17T00:00:00Z']) {
    assert.equal(plateExpiryState('2026-11-16', today), 'normal')
    assert.equal(plateExpiryClassName('2026-11-16', today), '')
  }
})

test('the injected local day remains correct near midnight on both sides of UTC', () => {
  inTimezone('Asia/Shanghai', () => {
    const now = new Date('2026-11-17T00:30:00+08:00'), today = localReminderDay(now)
    assert.equal(today, '2026-11-17'); assert.equal(now.toISOString().slice(0, 10), '2026-11-16')
    assert.equal(plateExpiryState('2026-11-23', today), 'expiring')
    assert.equal(plateExpiryState('2026-11-24', today), 'normal')
  })
  inTimezone('America/Los_Angeles', () => {
    const now = new Date('2026-11-17T23:30:00-08:00'), today = localReminderDay(now)
    assert.equal(today, '2026-11-17'); assert.equal(now.toISOString().slice(0, 10), '2026-11-18')
    assert.equal(plateExpiryState('2026-11-24', today), 'normal')
    assert.equal(plateExpiryState('2026-11-16', today), 'expired')
  })
})

test('daylight-saving changes do not turn seven calendar days into a warning', () => {
  inTimezone('America/New_York', () => {
    const spring = new Date(2026, 2, 8), springNext = new Date(2026, 2, 15)
    const autumn = new Date(2026, 10, 1), autumnNext = new Date(2026, 10, 8)
    assert.equal((springNext.getTime() - spring.getTime()) / 3600000, 167)
    assert.equal((autumnNext.getTime() - autumn.getTime()) / 3600000, 169)
    for (const [today, sixDays, sevenDays] of [[localReminderDay(spring), '2026-03-14', localReminderDay(springNext)], [localReminderDay(autumn), '2026-11-07', localReminderDay(autumnNext)]]) {
      assert.equal(plateExpiryState(sixDays, today), 'expiring')
      assert.equal(plateExpiryState(sevenDays, today), 'normal')
    }
  })
})
