import { test } from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createApp } from '../server/app.js'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execute = promisify(execFile)

test('launcher rejects retired commands and legacy update locks before opening data', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vehicle-retired-launcher-'))
  const data = path.join(root, 'data')
  const launcher = path.resolve(import.meta.dirname, '..', 'launcher.mjs')
  const options = { env: { ...process.env, VEHICLE_MANAGER_DATA_DIR: data }, windowsHide: true }
  try {
    for (const flag of ['--check', '--download', '--apply']) {
      await assert.rejects(execute(process.execPath, [launcher, flag], options), error => /Automatic updates are not supported/.test(String((error as { stderr: string }).stderr)))
    }
    await fs.writeFile(`${data}.update-lock`, 'legacy updater')
    await assert.rejects(execute(process.execPath, [launcher], options), error => /legacy application update lock/.test(String((error as { stderr: string }).stderr)))
    await assert.rejects(fs.stat(path.join(data, 'local.sqlite')), { code: 'ENOENT' })
  } finally { await fs.rm(root, { recursive: true, force: true }) }
})

test('retired update endpoints cannot check, download, install or gate normal startup', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'vehicle-no-updates-'))
  const client = createApp({ dataDir: directory })
  const server = client.app.listen(0, '127.0.0.1')
  if (!server.listening) await new Promise(resolve => server.once('listening', resolve))
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  try {
    const schema = client.store.db.prepare('SELECT sql FROM sqlite_master ORDER BY name').all()
    const version = client.store.db.prepare('PRAGMA user_version').get()
    const registration = await fetch(`${base}/api/register`, { method: 'POST', headers: { 'X-App-Request': 'vehicle-manager', 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'demo', displayName: 'Test', password: 'test-password-2026' }) })
    assert.equal(registration.status, 201)
    const cookie = registration.headers.get('set-cookie')!.split(';')[0]
    for (const [url, method] of [['/updates', 'GET'], ['/updates/check', 'POST'], ['/updates/download', 'POST'], ['/updates/install', 'POST'], ['/local/update-health', 'POST'], ['/local/update-activate', 'POST']]) {
      const response = await fetch(`${base}/api${url}`, { method, headers: { Cookie: cookie, 'X-App-Request': 'vehicle-manager' } })
      assert.equal(response.status, 404, url)
      assert.deepEqual(await response.json(), { error: 'NOT_FOUND' })
    }
    assert.equal((await fetch(`${base}/api/bootstrap`)).status, 200)
    assert.deepEqual(client.store.db.prepare('SELECT sql FROM sqlite_master ORDER BY name').all(), schema)
    assert.deepEqual(client.store.db.prepare('PRAGMA user_version').get(), version)
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    await client.close()
    await fs.rm(directory, { recursive: true, force: true })
  }
})
