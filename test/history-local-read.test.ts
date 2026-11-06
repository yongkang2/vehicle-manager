import { test } from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { once } from 'node:events'
import { createApp } from '../server/app.js'

test('history browsing reads authorized local data without running shared snapshot synchronization', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'history-local-read-')), client = createApp({ dataDir: path.join(root, 'local') }), server = client.app.listen(0, '127.0.0.1')
  if (!server.listening) await once(server, 'listening')
  let cookie = '', token = ''
  async function request(route: string, body?: unknown) {
    const response = await fetch(`http://127.0.0.1:${(server.address() as { port: number }).port}/api${route}`, { method: body ? 'POST' : 'GET', headers: { Cookie: cookie, 'X-App-Request': 'vehicle-manager', 'X-Workspace-Token': token, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined })
    cookie = response.headers.get('set-cookie')?.split(';')[0] || cookie; token = response.headers.get('x-workspace-token') || token
    const data = await response.json(); await client.synchronization.settle(); return { status: response.status, data }
  }
  try {
    assert.equal((await request('/register', { username: 'history-test', displayName: 'History tester', password: 'History-Fixture-Password1' })).status, 201)
    const shared = path.join(root, 'shared'); await fs.mkdir(shared)
    const setup = await request('/setup/configure', { path: shared, mode: 'create', teamName: 'Synthetic history', confirmed: true })
    assert.equal(setup.status, 200)
    const created = await request('/business/records', { kind: 'vehicle', data: { vin: 'TEST0000000000001', status: 'available', complianceLevel: 'Eu7' }, reason: 'Synthetic history fixture' })
    assert.equal(created.status, 201)
    const workspace = client.workspaces.get(setup.data.teamId), original = workspace.synchronization.synchronize.bind(workspace.synchronization)
    workspace.synchronization.synchronize = async () => { throw new Error('History must not await snapshot synchronization') }
    try {
      const result = await request('/business/history/query?summary=1')
      assert.equal(result.status, 200); assert.equal(result.data.total, 1)
      assert.equal(result.data.items[0].before, null)
      assert.equal(typeof result.data.items[0].changedFieldCount, 'number')
      const options = await request('/business/history/options')
      assert.equal(options.status, 200); assert.equal(options.data.vehicleOptions[0].id, created.data.id)
      const detail = await request(`/business/history/changes/${result.data.items[0].id}`)
      assert.equal(detail.status, 200); assert.equal(detail.data.after.vin, 'TEST0000000000001')
    } finally { workspace.synchronization.synchronize = original }
    assert.equal((await request('/logout', {})).status, 200)
    assert.equal((await request('/business/history/query?summary=1')).status, 401)
    assert.equal((await request('/business/history/options')).status, 401)
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); await client.close(); await fs.rm(root, { recursive: true, force: true }) }
})
