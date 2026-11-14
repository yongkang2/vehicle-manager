import { test } from 'node:test'
import assert from 'node:assert/strict'
import { errorText } from '../src/i18n.js'

test('uncertain operations ask users to inspect saved results in both languages', () => {
  for (const code of ['NETWORK_ERROR', 'SERVER_ERROR', 'SHARE_IO_ERROR']) {
    assert.match(errorText(code, 'en'), /check the (saved )?result/i)
    assert.match(errorText(code, 'zh'), /(?:检查|核对).*结果/)
  }
  assert.equal(errorText('UNRECOGNIZED_INTERNAL_ERROR', 'en'), errorText('SERVER_ERROR', 'en'))
  assert.equal(errorText('UNRECOGNIZED_INTERNAL_ERROR', 'zh'), errorText('SERVER_ERROR', 'zh'))
})

test('recovery guidance protects unsaved text and shared files without false guarantees', () => {
  for (const code of ['WORKSPACE_CHANGED', 'VERSION_CONFLICT']) {
    assert.match(errorText(code, 'en'), /copy.*unsaved/i)
    assert.match(errorText(code, 'zh'), /复制尚未保存/)
  }
  assert.doesNotMatch(errorText('WORKSPACE_CHANGED', 'en'), /no .*operation was applied/)
  assert.match(errorText('SHARE_BUSY', 'en'), /do not delete/)
  assert.match(errorText('SHARE_BUSY', 'zh'), /不要自行删除/)
  assert.match(errorText('SHARE_UNAVAILABLE', 'en'), /synchronize after reconnecting/)
  assert.doesNotMatch(errorText('SHARE_UNAVAILABLE', 'zh'), /稍后配置|未创建/)
})

test('photo, backup and database failures have specific bilingual recovery guidance', () => {
  for (const code of ['PHOTO_INVALID', 'LOCAL_BACKUP_FAILED', 'LOCAL_SCHEMA_INVALID', 'BACKUP_MODIFICATION_CONFLICT', 'CONFIGURATION_POLICY_NOT_ENABLED']) {
    for (const language of ['en', 'zh'] as const) {
      assert.notEqual(errorText(code, language), errorText('SERVER_ERROR', language), code)
    }
  }
  assert.match(errorText('PHOTO_INVALID', 'en'), /JPEG.*PNG.*10 MB/)
  assert.match(errorText('LOCAL_SCHEMA_INVALID', 'zh'), /不要自行删除数据库文件/)
  assert.match(errorText('LOCAL_BACKUP_FAILED', 'en'), /operation was stopped/)
})