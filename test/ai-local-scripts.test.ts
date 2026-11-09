import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, copyFileSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
test('Windows local setup stores only a device credential in client configuration and preserves it on rerun', { skip: process.platform !== 'win32' }, () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'ai-local-script-')), config = path.join(root, 'server'), client = path.join(root, 'client')
  mkdirSync(config)
  try {
    const fixture = spawnSync('powershell.exe', ['-NoProfile', '-Command', "$key = ConvertTo-SecureString 'fictional-test-key' -AsPlainText -Force; $key | Export-Clixml -LiteralPath $env:AI_FIXTURE_KEY"], { env: { ...process.env, AI_FIXTURE_KEY: path.join(config, 'provider-key.xml') }, encoding: 'utf8' })
    assert.equal(fixture.status, 0, fixture.stderr)
    const configure = () => spawnSync('powershell.exe', ['-NoProfile', '-File', path.resolve('scripts/configure-ai-local.ps1'), '-UseSavedKey', '-ConfigRoot', config, '-ClientDirectory', client], { encoding: 'utf8' })
    const first = configure(); assert.equal(first.status, 0, first.stderr)
    const saved = readFileSync(path.join(client, 'ai-client.json'), 'utf8').replace(/^\uFEFF/, '')
    assert.equal(saved.includes('fictional-test-key'), false)
    const result = JSON.parse(saved)
    assert.equal(result.gatewayUrl, 'http://127.0.0.1:4420'); assert.equal(result.deviceToken.length, 64)
    const second = configure(); assert.equal(second.status, 0, second.stderr)
    assert.equal(readFileSync(path.join(client, 'ai-client.json'), 'utf8').replace(/^\uFEFF/, ''), saved)
    assert.equal(readFileSync(path.join(config, 'provider-key.xml'), 'utf8').includes('fictional-test-key'), false)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('trial stop targets the trial data directory rather than the default business directory', { skip: process.platform !== 'win32' }, () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'ai-trial-stop-'))
  try {
    copyFileSync('Stop-AI-Trial.cmd', path.join(root, 'Stop-AI-Trial.cmd'))
    writeFileSync(path.join(root, 'Stop.cmd'), '@echo off\r\necho %VEHICLE_MANAGER_DATA_DIR%\r\n')
    const result = spawnSync('cmd.exe', ['/d', '/c', 'Stop-AI-Trial.cmd'], { cwd: root, env: { ...process.env, LOCALAPPDATA: root, VEHICLE_MANAGER_DATA_DIR: 'original-business-directory' }, encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr)
    assert.equal(result.stdout.trim(), path.join(root, 'VehicleManagerAI', 'trial-data'))
  } finally { rmSync(root, { recursive: true, force: true }) }
})
