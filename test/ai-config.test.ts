import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { loadAiClientConfig } from '../server/ai-config.js'

test('client configuration is local, validates its destination and allows explicit environment overrides', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'ai-config-')), file = path.join(root, 'client.json')
  try {
    assert.equal(loadAiClientConfig({}, file), null)
    writeFileSync(file, JSON.stringify({ gatewayUrl: 'http://127.0.0.1:4420', deviceToken: 'x'.repeat(64) }))
    assert.equal(loadAiClientConfig({}, file)?.gatewayUrl, 'http://127.0.0.1:4420')
    writeFileSync(file, '\uFEFF' + JSON.stringify({ gatewayUrl: 'http://127.0.0.1:4420', deviceToken: 'x'.repeat(64) }))
    assert.equal(loadAiClientConfig({}, file)?.gatewayUrl, 'http://127.0.0.1:4420')
    assert.throws(() => loadAiClientConfig({ VEHICLE_AI_GATEWAY_URL: 'http://remote', VEHICLE_AI_DEVICE_TOKEN: 'x'.repeat(64) }, file), /AI_INVALID_CONFIGURATION/)
    assert.throws(() => loadAiClientConfig({ VEHICLE_AI_GATEWAY_URL: 'https://user:secret@example.com' }, file), /AI_INVALID_CONFIGURATION/)
    assert.equal(loadAiClientConfig({ VEHICLE_AI_GATEWAY_URL: 'https://example.com', VEHICLE_AI_DEVICE_TOKEN: 'y'.repeat(64) }, file)?.deviceToken, 'y'.repeat(64))
  } finally { rmSync(root, { recursive: true, force: true }) }
})
