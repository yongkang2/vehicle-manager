import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createApp } from '../server/app.js'
import type { BusinessRecord } from '../shared/business.js'
import type { ComponentTypeDefinition, ConfigurationDecisions, ConfigurationPreview } from '../shared/configuration-revisions.js'
import { configurationDecisionKey } from '../shared/configuration-revisions.js'

async function fixture() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'vm-component-policy-api-'))
  const client = createApp({ dataDir: path.join(directory, 'local') }), server = client.app.listen(0, '127.0.0.1')
  if (!server.listening) await once(server, 'listening')
  const sessions = new Map<string, { cookie: string; token: string }>()
  async function request(route: string, method = 'GET', body?: unknown, session = 'owner', token?: string) {
    const credentials = sessions.get(session) || { cookie: '', token: '' }
    const response = await fetch(`http://127.0.0.1:${(server.address() as { port: number }).port}/api${route}`, {
      method, headers: { Cookie: credentials.cookie, 'X-App-Request': 'vehicle-manager', 'X-Workspace-Token': token ?? credentials.token, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body),
    })
    const cookie = response.headers.get('set-cookie'); if (cookie) credentials.cookie = cookie.split(';')[0]
    if (response.ok) credentials.token = response.headers.get('x-workspace-token') || credentials.token
    sessions.set(session, credentials)
    const data = await response.json()
    await client.synchronization.settle()
    return { status: response.status, data }
  }
  async function register(session: string) {
    const result = await request('/register', 'POST', { username: `policy-${session}`, displayName: `Fictional ${session}`, password: 'policy-test-password' }, session)
    assert.equal(result.status, 201, JSON.stringify(result.data))
  }
  async function team(name = 'Fictional Policy Team') {
    const shared = path.join(directory, name); await fs.mkdir(shared)
    const result = await request('/setup/configure', 'POST', { path: shared, mode: 'create', teamName: name, confirmed: true, retainPending: true })
    assert.equal(result.status, 200, JSON.stringify(result.data)); return { id: result.data.teamId as string, shared }
  }
  async function member(target: { id: string; shared: string }) {
    await register('member')
    assert.equal((await request('/setup/configure', 'POST', { path: target.shared, teamId: target.id, mode: 'join' }, 'member')).status, 200)
    const roster = (await request('/team')).data, pending = roster.requests.find((entry: { status: string }) => entry.status === 'pending')
    assert(pending)
    assert.equal((await request(`/team/requests/${pending.id}/approve`, 'POST', { role: 'member', memberId: null, reason: 'Approve fictional policy reader' })).status, 200)
    assert.equal((await request('/status', 'GET', undefined, 'member')).data.member.role, 'member')
  }
  async function enable() { assert.equal((await request('/business/configuration-revisions/enable', 'POST', { requestId: randomUUID(), reason: 'Fictional clients are upgraded' })).status, 200) }
  async function catalog() { return (await request('/business/component-types')).data as { policyEnabled: boolean; types: ComponentTypeDefinition[] } }
  const command = (type: ComponentTypeDefinition, reviewState: string) => ({ name: type.name, description: type.description, version: type.version, reviewState, reason: 'Review scope change for fictional test', requestId: randomUUID() })
  function publication(value: ConfigurationPreview) {
    const decisions: ConfigurationDecisions = { fields: {}, sections: {} }
    for (const section of value.sections) {
      if (!section.components.length) decisions.sections[section.typeId] = { state: 'notInstalled', reason: 'Not fitted to this fictional vehicle' }
      for (const component of section.components) for (const field of component.fields) if (field.required && !field.value.trim()) decisions.fields[configurationDecisionKey(component.id, field.id)] = { state: 'unknown', reason: 'Fictional supplier information pending' }
    }
    return { previewToken: value.token, requestId: randomUUID(), title: '', summary: 'Reviewed fictional configuration', decisions }
  }
  async function close() { await new Promise<void>(resolve => server.close(() => resolve())); await client.close(); await fs.rm(directory, { recursive: true, force: true }) }
  await register('owner')
  return { directory, client, sessions, request, team, member, enable, catalog, command, publication, close }
}

test('HTTP component policies preserve member working access, immutable history, and idempotent built-in changes', async () => {
  const f = await fixture()
  try {
    const team = await f.team(); await f.enable(); await f.member(team)
    const car = (await f.request('/business/records', 'POST', { kind: 'vehicle', data: { vin: 'TEST0000000000001', status: 'available', complianceLevel: 'Eu7' }, reason: 'Create fictional vehicle' })).data as BusinessRecord
    const endpoint = `/business/vehicles/${car.id}/configuration-revisions`
    const firstPreview = (await f.request(`${endpoint}/preview`, 'POST', {}, 'member')).data as ConfigurationPreview
    const first = await f.request(endpoint, 'POST', f.publication(firstPreview), 'member')
    assert.equal(first.status, 201, JSON.stringify(first.data))
    const frozen = (await f.request(`${endpoint}/${first.data.revisionId}`)).data
    const stale = (await f.request(`${endpoint}/preview`, 'POST', {}, 'member')).data as ConfigurationPreview
    const type = (await f.catalog()).types.find(row => row.id === 'hv-battery')!, change = f.command(type, 'removed')
    assert.equal((await f.request(`/business/component-types/${type.id}`, 'PUT', change, 'anonymous')).status, 401)
    assert.equal((await f.request(`/business/component-types/${type.id}`, 'PUT', change, 'member')).status, 403)
    const changed = await f.request(`/business/component-types/${type.id}`, 'PUT', change)
    assert.equal(changed.status, 200, JSON.stringify(changed.data)); assert.equal(changed.data.reviewState, 'removed')
    const headPath = path.join(team.shared, 'business', 'HEAD.json'), head = await fs.readFile(headPath, 'utf8')
    assert.equal(JSON.parse(head).protocol, 4)
    const retried = await f.request(`/business/component-types/${type.id}`, 'PUT', change)
    assert.deepEqual(retried.data, changed.data); assert.equal(await fs.readFile(headPath, 'utf8'), head)
    assert.equal((await f.request(endpoint, 'POST', f.publication(stale), 'member')).data.error, 'REVISION_PREVIEW_CHANGED')
    assert.deepEqual((await f.request(`${endpoint}/${first.data.revisionId}`)).data, frozen)
    const newPreview = (await f.request(`${endpoint}/preview`, 'POST', {}, 'member')).data as ConfigurationPreview
    assert(!newPreview.sections.some(section => section.typeId === type.id))
    const battery = await f.request('/business/records', 'POST', { kind: 'part', vehicleId: car.id, data: { name: 'HV Battery', category: 'battery', productPart: 'BAT-PN', serial: '000123', maturity: 'POC', lifeStatus: 'BOL' }, reason: 'Install battery excluded from revision review' }, 'member')
    assert.equal(battery.status, 201, JSON.stringify(battery.data))
    assert.equal((await f.request('/business/working-view', 'GET', undefined, 'member')).data.catalog.types.find((row: ComponentTypeDefinition) => row.id === type.id).reviewState, 'removed')
    const renamed = await f.request(`/business/component-types/${type.id}`, 'PUT', { ...f.command(changed.data, 'active'), name: 'Different built-in name' })
    assert.equal(renamed.status, 400, JSON.stringify(renamed.data))
    const restored = await f.request(`/business/component-types/${type.id}`, 'PUT', f.command(changed.data, 'active'))
    assert.equal(restored.status, 200, JSON.stringify(restored.data)); assert.equal(restored.data.id, type.id)
    assert.equal(restored.data.reviewState, 'active')
  } finally { await f.close() }
})

test('HTTP policies reject paused sessions and old workspace tokens without changing either team', async () => {
  const f = await fixture()
  try {
    const first = await f.team(); await f.enable()
    const initial = await f.catalog(), type = initial.types.find(row => row.id === 'controllers')!, change = f.command(type, 'disabled')
    const headPath = path.join(first.shared, 'business', 'HEAD.json'), head = await fs.readFile(headPath, 'utf8')
    f.client.store.db.exec('UPDATE sessions SET sync_enabled=0')
    const paused = await f.request(`/business/component-types/${type.id}`, 'PUT', change)
    assert.equal(paused.data.error, 'CONFIRM_RESUME'); assert.equal(await fs.readFile(headPath, 'utf8'), head)
    assert.equal((await f.catalog()).policyEnabled, false)
    f.client.store.db.exec('UPDATE sessions SET sync_enabled=1')
    const token = f.sessions.get('owner')!.token
    const second = await f.team('Fictional Isolated Policy Team'); await f.enable()
    const secondHead = path.join(second.shared, 'business', 'HEAD.json'), secondBytes = await fs.readFile(secondHead, 'utf8')
    const stale = await f.request(`/business/component-types/${type.id}`, 'PUT', change, 'owner', token)
    assert.equal(stale.data.error, 'WORKSPACE_CHANGED')
    assert.equal(await fs.readFile(headPath, 'utf8'), head); assert.equal(await fs.readFile(secondHead, 'utf8'), secondBytes)
    assert.equal((await f.catalog()).policyEnabled, false)
  } finally { await f.close() }
})
