import { test } from 'node:test'
import assert from 'node:assert/strict'
import { SyncPoll } from '../server/sync-poll.js'

test('background polling uses jitter, bounded busy backoff and success resets the delay', t => {
  let now = 100000
  t.mock.method(Date, 'now', () => now)
  t.mock.method(Math, 'random', () => 0.5)
  const poll = new SyncPoll()
  assert.equal(poll.ready(), true)
  poll.complete(false)
  assert.equal(poll.ready(), true)
  now += 30000; assert.equal(poll.ready(), true)
  for (const delay of [60000, 120000, 120000]) {
    poll.complete(true)
    now += delay - 1; assert.equal(poll.ready(), false)
    now++; assert.equal(poll.ready(), true)
  }
  poll.complete(false)
  now += 30000; assert.equal(poll.ready(), true)
})
