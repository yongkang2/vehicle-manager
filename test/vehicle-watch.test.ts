import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseWatch, watchKey } from '../src/vehicle-watch'
test('watch preferences reject corrupt and unsupported stored values', () => {
  for (const value of [null, '{', 'null', '{"vehicles":[]}']) assert.deepEqual(parseWatch(value), {onlyWatched:false,vehicles:{}})
  assert.deepEqual(parseWatch(JSON.stringify({onlyWatched:true,vehicles:{a:'blue',b:'unknown',c:1}})),{onlyWatched:true,vehicles:{a:'blue'}})
})
test('favorites survive storage round trip and keep account/workspace identities separate', () => {
  const preference={onlyWatched:true,vehicles:{'vehicle-id':'purple'}}
  assert.deepEqual(parseWatch(JSON.stringify(preference)),preference)
  assert.notEqual(watchKey('user-a','team-a'),watchKey('user-b','team-a'))
  assert.notEqual(watchKey('user-a','team-a'),watchKey('user-a','team-b'))
})
