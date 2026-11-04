import { test } from 'node:test'
import assert from 'node:assert/strict'
import { assertEnglishMetadata, commitRange } from '../scripts/check-language.mjs'

test('publication metadata accepts English and rejects Chinese', () => {
  assert.doesNotThrow(() => assertEnglishMetadata('fix(release): enforce English metadata\n\nValidation: 388 tests passed.', 'Commit'))
  assert.throws(() => assertEnglishMetadata('Release notes: 版本更新', 'Release'), /Release must use English/)
  assert.throws(() => assertEnglishMetadata('fix: update package\n\n修复打包', 'Commit'), /Commit must use English/)
})

test('publication checks cover every introduced PR or push commit', () => {
  assert.deepEqual(commitRange({ pull_request: { base: { sha: 'base' }, head: { sha: 'head' } } }), ['base..head'])
  assert.deepEqual(commitRange({ before: 'before', after: 'after' }), ['before..after'])
  assert.deepEqual(commitRange({ before: '0000000000', after: 'after' }), ['after'])
  assert.deepEqual(commitRange({}), ['-1'])
})
