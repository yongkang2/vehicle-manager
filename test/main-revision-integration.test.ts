import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createApp } from '../server/app.js'
import { SharedBusinessSnapshot } from '../server/deletions.js'
import { configurationDecisionKey } from '../shared/configuration-revisions.js'
import type { Actor, BusinessRecord, Change, RestoredHistoryImport } from '../shared/business.js'
import type { ComponentTypeCatalog, ComponentTypeDefinition, ConfigurationDecisions, ConfigurationImport, ConfigurationPreview, ConfigurationPublicationReceipt, ConfigurationPublishRequest } from '../shared/configuration-revisions.js'
import type { WorkspaceSnapshot } from '../shared/workspace.js'
import type { TeamDocument } from '../shared/types.js'

function publication(preview: ConfigurationPreview): ConfigurationPublishRequest {
  const decisions: ConfigurationDecisions = { fields: {}, sections: {} }
  for (const section of preview.sections) {
    if (!section.components.length) decisions.sections[section.typeId] = { state: 'notInstalled', reason: 'Not fitted to this fictional integration vehicle' }
    for (const component of section.components) for (const field of component.fields) {
      if (field.required && !field.value.trim()) decisions.fields[configurationDecisionKey(component.id, field.id)] = { state: 'unknown', reason: 'Fictional supplier information is pending' }
    }
  }
  return { previewToken: preview.token, requestId: randomUUID(), title: 'Fictional reviewed configuration', summary: 'Capture the fictional integration configuration', decisions }
}

async function fixture() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'vm-main-revision-integration-')), shared = path.join(directory, 'fictional-share')
  await fs.mkdir(shared)
  const client = createApp({ dataDir: path.join(directory, 'local') }), server = client.app.listen(0, '127.0.0.1')
  if (!server.listening) await once(server, 'listening')
  let cookie = '', token = ''
  async function request<T = { error: string }>(route: string, method = 'GET', body?: unknown) {
    const response = await fetch(`http://127.0.0.1:${(server.address() as { port: number }).port}/api${route}`, {
      method, headers: { Cookie: cookie, 'X-App-Request': 'vehicle-manager', 'X-Workspace-Token': token, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(10000),
    })
    cookie = response.headers.get('set-cookie')?.split(';')[0] || cookie
    if (response.ok) token = response.headers.get('x-workspace-token') || token
    const data = await response.json() as T
    await client.synchronization.settle()
    return { status: response.status, data }
  }
  const registered = await request('/register', 'POST', { username: 'fictional-owner', displayName: 'Fictional Integration Owner', password: 'fictional-integration-password' })
  if (registered.status !== 201) {
    await new Promise<void>(resolve => server.close(() => resolve()))
    await client.close()
    await fs.rm(directory, { recursive: true, force: true })
    assert.fail(JSON.stringify(registered))
  }
  const setup = await request<{ teamId: string }>('/setup/configure', 'POST', { path: shared, mode: 'create', teamName: 'Fictional Integration Team', confirmed: true })
  assert.equal(setup.status, 200, JSON.stringify(setup.data))
  const workspace = client.workspaces.get(setup.data.teamId), team = workspace.store.get<TeamDocument>('cachedTeam')!
  const member = team.members.find(row => row.role === 'admin')!
  const actor: Actor = { id: member.id, name: member.name, role: member.role, deviceId: workspace.store.deviceId }
  const headPath = path.join(shared, 'business', 'HEAD.json')
  async function enable(policy = false) {
    const enabled = await request<ComponentTypeCatalog>('/business/configuration-revisions/enable', 'POST', { requestId: randomUUID(), reason: 'All fictional clients have upgraded' })
    assert.equal(enabled.status, 200, JSON.stringify(enabled.data))
    if (policy) {
      const type = enabled.data.types.find(row => row.id === 'controllers')!
      const changed = await request<ComponentTypeDefinition>(`/business/component-types/${type.id}`, 'PUT', { name: type.name, description: type.description, version: type.version, reviewState: 'disabled', requestId: randomUUID(), reason: 'Exclude fictional controllers from required review' })
      assert.equal(changed.status, 200, JSON.stringify(changed.data))
    }
  }
  async function car() {
    const created = await request<BusinessRecord>('/business/records', 'POST', { kind: 'vehicle', data: { name: 'Fictional Integration Vehicle', vin: 'TEST0000000000001', status: 'available', complianceLevel: 'Eu7', thermal: 'No Heat Pump' }, reason: 'Register the fictional integration vehicle' })
    assert.equal(created.status, 201, JSON.stringify(created.data)); return created.data
  }
  async function close() {
    await new Promise<void>(resolve => server.close(() => resolve()))
    await client.close()
    assert.equal(path.dirname(directory), os.tmpdir())
    await fs.rm(directory, { recursive: true, force: true })
  }
  return { directory, shared, client, workspace, actor, headPath, request, enable, car, close }
}

test('protocol-4 background HEAD checks reject downgrades and ingest pending configuration and history restores', async t => {
  const f = await fixture(); t.after(f.close)
  const car = await f.car()
  await f.enable(true)
  const first = await f.request<WorkspaceSnapshot>('/business/workspace?full=1')
  assert.equal(first.status, 200); assert.equal(first.data.sync.phase, 'ready')
  assert.equal(first.data.data!.catalog.policyEnabled, true)
  const open = t.mock.method(SharedBusinessSnapshot, 'open')
  const unchanged = await f.request<WorkspaceSnapshot>(`/business/workspace?known=${first.data.revision}`)
  assert.equal(unchanged.data.data, undefined); assert.equal(unchanged.data.sync.error, null)
  assert.equal(open.mock.callCount(), 0, 'unchanged protocol-4 polls retain the HEAD-only optimization')

  const restored: BusinessRecord = { id: randomUUID(), kind: 'componentType', vehicleId: null, archived: false, version: 1, updated: new Date().toISOString(), data: { schema: 2, name: 'Fictional Restored Inverter', description: 'Only integration fixture data', reviewState: 'active', definitionVersion: 1 } }
  const imported: ConfigurationImport = { id: randomUUID(), records: [restored], actor: f.actor, reason: 'Restore the fictional catalog', receipts: [] }
  f.workspace.store.set('pendingConfigurationImports', [imported])
  assert.equal(f.workspace.synchronization.status().pending, 1)
  const importedSnapshot = await f.request<WorkspaceSnapshot>('/business/workspace')
  assert.equal(open.mock.callCount(), 1, 'a pending configuration import bypasses the cached HEAD')
  assert.equal(importedSnapshot.data.sync.pending, 0)
  assert.equal(importedSnapshot.data.data!.catalog.types.find(row => row.id === restored.id)!.pendingRestore, undefined)
  assert.equal(f.workspace.store.get<ConfigurationImport[]>('pendingConfigurationImports')!.length, 0)

  const historical = JSON.parse(String(f.workspace.store.db.prepare('SELECT payload FROM changes WHERE record_id=? LIMIT 1').get(car.id)!.payload)) as Change
  historical.id = randomUUID(); historical.reason = 'Recover a fictional history-only backup'
  const historyImport: RestoredHistoryImport = { id: randomUUID(), actor: f.actor, changes: [historical] }
  f.workspace.store.set('pendingHistoryImports', [historyImport])
  assert.equal(f.workspace.synchronization.status().pending, 1)
  const recovered = await f.request<WorkspaceSnapshot>('/business/workspace')
  assert.equal(open.mock.callCount(), 2, 'a history-only restore also bypasses the cached HEAD')
  assert.equal(recovered.data.sync.pending, 0)
  assert.equal((await f.request<Change>(`/business/history/changes/${historical.id}`)).data.id, historical.id)
  assert.deepEqual(f.workspace.store.get('pendingHistoryImports'), [])

  const before = open.mock.callCount(), bytes = await fs.readFile(f.headPath, 'utf8'), head = JSON.parse(bytes)
  assert.equal(head.protocol, 4)
  await f.request<WorkspaceSnapshot>(`/business/workspace?known=${importedSnapshot.data.revision}`)
  assert.equal(open.mock.callCount(), before)
  await fs.writeFile(f.headPath, JSON.stringify({ ...head, protocol: 3 }))
  const rollback = await f.request<WorkspaceSnapshot>('/business/workspace')
  assert.equal(rollback.data.sync.error, 'BUSINESS_ROLLBACK')
  assert.equal(open.mock.callCount(), before, 'the fast reader validates monotonic protocol before opening any snapshot')
  await fs.writeFile(f.headPath, bytes)
  assert.equal((await f.request<WorkspaceSnapshot>('/business/workspace?full=1')).data.sync.phase, 'ready')
  await fs.writeFile(f.headPath, JSON.stringify({ ...head, protocol: 6 }))
  assert.equal((await f.request<WorkspaceSnapshot>('/business/workspace')).data.sync.error, 'CLIENT_UPGRADE_REQUIRED')
  await fs.writeFile(f.headPath, bytes)
})

test('local and known workspace snapshots carry catalog and revision changes without protected working records', async t => {
  const f = await fixture(); t.after(f.close)
  const car = await f.car(); await f.enable(true)
  const initial = (await f.request<WorkspaceSnapshot>('/business/workspace?local=1')).data
  assert.equal(initial.data!.catalog.enabled, true); assert.equal(initial.data!.catalog.policyEnabled, true)
  assert.deepEqual(initial.data!.revisionSummaries, [])
  const synchronize = t.mock.method(f.workspace.synchronization, 'synchronize')
  const pending: ConfigurationImport = { id: randomUUID(), actor: f.actor, reason: 'Stage a fictional restored catalog locally', receipts: [], records: [{ id: randomUUID(), kind: 'componentType', vehicleId: null, archived: false, version: 1, updated: new Date().toISOString(), data: { schema: 2, name: 'Fictional Local Charger', description: '', reviewState: 'active', definitionVersion: 1 } }] }
  f.workspace.store.set('pendingConfigurationImports', [pending])
  const local = (await f.request<WorkspaceSnapshot>(`/business/workspace?local=1&known=${initial.revision}`)).data
  assert.equal(synchronize.mock.callCount(), 0, 'local-first snapshots never contact the shared snapshot')
  assert.notEqual(local.revision, initial.revision)
  assert.deepEqual(local.data!.records, initial.data!.records); assert.deepEqual(local.data!.changes, initial.data!.changes)
  assert.equal(local.data!.catalog.types.find(row => row.id === pending.records[0].id)!.pendingRestore, true)
  assert.equal((await f.request<WorkspaceSnapshot>(`/business/workspace?local=1&known=${local.revision}`)).data.data, undefined)
  synchronize.mock.restore()
  await f.request('/business/sync', 'POST', {})

  const endpoint = `/business/vehicles/${car.id}/configuration-revisions`
  const preview = await f.request<ConfigurationPreview>(`${endpoint}/preview`, 'POST', {})
  assert.equal(preview.status, 200, JSON.stringify(preview.data))
  const published = await f.request<ConfigurationPublicationReceipt>(endpoint, 'POST', publication(preview.data))
  assert.equal(published.status, 201, JSON.stringify(published.data))
  const after = (await f.request<WorkspaceSnapshot>(`/business/workspace?local=1&known=${local.revision}`)).data
  assert.equal(after.data!.revisionSummaries[0].revisionId, published.data.revisionId)
  assert.equal(after.data!.revisionSummaries[0].label, 'R01'); assert.equal(after.data!.revisionSummaries[0].hasChanges, false)
  assert(after.data!.records.every(row => !['configurationRevision', 'componentType'].includes(row.kind)))
  assert.equal((await f.request<WorkspaceSnapshot>(`/business/workspace?known=${after.revision}`)).data.data, undefined)
})

test('paused refreshes retain local changes and publication rechecks the session after its final async lease check', async t => {
  const f = await fixture(); t.after(async () => { t.mock.restoreAll(); await f.close() })
  const car = await f.car(); await f.enable(true)
  const endpoint = `/business/vehicles/${car.id}/configuration-revisions`
  const preview = await f.request<ConfigurationPreview>(`${endpoint}/preview`, 'POST', {})
  assert.equal(preview.status, 200)
  const initial = (await f.request<WorkspaceSnapshot>('/business/workspace?local=1')).data
  const head = await fs.readFile(f.headPath, 'utf8')
  f.client.store.db.exec('UPDATE sessions SET sync_enabled=0')
  const edit = await f.request<BusinessRecord>(`/business/records/${car.id}`, 'PUT', { data: { ...car.data, notes: 'Fictional edit retained while paused' }, version: car.version, reason: 'Keep a fictional offline note' })
  assert.equal(edit.status, 200, JSON.stringify(edit.data))
  const paused = await f.request<WorkspaceSnapshot>(`/business/workspace?known=${initial.revision}`)
  assert.equal(paused.status, 200); assert.equal(paused.data.sync.pending, 1)
  assert.equal(paused.data.data!.records.find(row => row.id === car.id)!.data.notes, 'Fictional edit retained while paused')
  assert.equal(paused.data.data!.catalog.policyEnabled, true)
  assert.equal((await f.request('/business/sync', 'POST', {})).data.error, 'CONFIRM_RESUME')
  assert.equal((await f.request(`${endpoint}/preview`, 'POST', {})).data.error, 'CONFIRM_RESUME')
  assert.equal((await f.request(endpoint, 'POST', publication(preview.data))).data.error, 'CONFIRM_RESUME')
  assert.equal(await fs.readFile(f.headPath, 'utf8'), head)

  assert.equal((await f.request('/workspaces/resume', 'POST', { confirmed: true })).status, 200)
  assert.equal((await f.request('/business/sync', 'POST', {})).status, 200)
  const fresh = await f.request<ConfigurationPreview>(`${endpoint}/preview`, 'POST', {})
  assert.equal(fresh.status, 200, JSON.stringify(fresh.data))
  const beforeCommit = await fs.readFile(f.headPath, 'utf8'), readFile = fs.readFile.bind(fs)
  let pausedAtCommit = false
  t.mock.method(fs, 'readFile', async (...args: Parameters<typeof fs.readFile>) => {
    const bytes = await readFile(...args)
    if (!pausedAtCommit && path.dirname(String(args[0])) === path.join(f.shared, '.vehicle-manager-team-lock')) {
      const names = await fs.readdir(path.dirname(f.headPath))
      if (names.some(name => name.startsWith('HEAD.json.') && name.endsWith('.tmp'))) {
        f.client.store.db.exec('UPDATE sessions SET sync_enabled=0')
        pausedAtCommit = true
      }
    }
    return bytes
  })
  const interrupted = await f.request(endpoint, 'POST', publication(fresh.data))
  assert.equal(pausedAtCommit, true, 'inject the pause while validating the lease after HEAD bytes are prepared')
  assert.equal(interrupted.status, 409); assert.equal(interrupted.data.error, 'CONFIRM_RESUME')
  assert.equal(await fs.readFile(f.headPath, 'utf8'), beforeCommit)
  assert.equal((await f.request<WorkspaceSnapshot>('/business/workspace?local=1')).data.data!.revisionSummaries.length, 0)
  assert.equal((await fs.readdir(path.dirname(f.headPath))).filter(name => name.endsWith('.tmp')).length, 0)
})
