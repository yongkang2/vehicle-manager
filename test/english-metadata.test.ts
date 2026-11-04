import { test } from 'node:test'
import assert from 'node:assert/strict'
import { assertEnglishMetadata } from '../scripts/check-language.mjs'

test('publication metadata accepts English and rejects Chinese', () => {
  assert.doesNotThrow(() => assertEnglishMetadata('fix(release): enforce English metadata\n\nValidation: 388 tests passed.', 'Commit'))
  assert.throws(() => assertEnglishMetadata('Release notes: 版本更新', 'Release'), /Release must use English/)
  assert.throws(() => assertEnglishMetadata('fix: update package\n\n修复打包', 'Commit'), /Commit must use English/)
})
