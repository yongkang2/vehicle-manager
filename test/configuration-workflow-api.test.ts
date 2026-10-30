import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createApp } from '../server/app.js'
import type { BusinessRecord } from '../shared/business.js'
import type { ConfigurationDecisions, ConfigurationPreview } from '../shared/configuration-revisions.js'
import { configurationDecisionKey } from '../shared/configuration-revisions.js'

function reviewed(preview: ConfigurationPreview): ConfigurationDecisions {
  const decisions: ConfigurationDecisions = { fields: {}, sections: {} }
  for (const section of preview.sections) {
    if (!section.components.length) decisions.sections[section.typeId] = { state: 'notInstalled', reason: 'Not fitted to this fictional trial vehicle' }
    for (const component of section.components) for (const field of component.fields) if (field.required && !field.value.trim()) decisions.fields[configurationDecisionKey(component.id, field.id)] = { state: 'unknown', reason: 'Supplier identification is pending for this fictional sample' }
  }
  return decisions
}

async function fixture() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'vm-configuration-api-'))
  const client = createApp({ dataDir: path.join(directory, 'local') }), server = client.app.listen(0, '127.0.0.1')
  if (!server.listening) await once(server, 'listening')
  const sessions = new Map<string, { cookie: string; token: string }>()
  async function request(route: string, method = 'GET', body?: unknown, session = 'owner', token?: string) {
    const credentials = sessions.get(session) || { cookie: '', token: '' }
    const response = await fetch(`http://127.0.0.1:${(server.address() as { port: number }).port}/api${route}`, { method, headers: { Cookie: credentials.cookie, 'X-App-Request': 'vehicle-manager', 'X-Workspace-Token': token ?? credentials.token, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body) })
    const cookie = response.headers.get('set-cookie'); if (cookie) credentials.cookie = cookie.split(';')[0]
    if (response.ok) credentials.token = response.headers.get('x-workspace-token') || credentials.token
    sessions.set(session, credentials)
    const data = await response.json()
    await client.synchronization.settle()
    return { status: response.status, data }
  }
  async function register(session: string) { const result = await request('/register', 'POST', { username: `revision-${session}`, displayName: `Fictional ${session}`, password: 'revision-test-password' }, session); assert.equal(result.status, 201); return result.data }
  async function team(name = 'Team A') {
    const shared = path.join(directory, name); await fs.mkdir(shared)
    const result = await request('/setup/configure', 'POST', { path: shared, mode: 'create', teamName: name, confirmed: true, retainPending: true })
    assert.equal(result.status, 200, JSON.stringify(result.data)); return { id: result.data.teamId as string, shared }
  }
  async function member(team: { id: string; shared: string }) {
    await register('member')
    assert.equal((await request('/setup/configure', 'POST', { path: team.shared, teamId: team.id, mode: 'join' }, 'member')).status, 200)
    const roster = (await request('/team')).data, pending = roster.requests.find((entry: { status: string }) => entry.status === 'pending')
    assert(pending)
    assert.equal((await request(`/team/requests/${pending.id}/approve`, 'POST', { role: 'member', memberId: null, reason: 'Approve fictional revision author' })).status, 200)
    assert.equal((await request('/status', 'GET', undefined, 'member')).data.member.role, 'member')
  }
  async function car(vin = 'TEST0000000000001') {
    const result = await request('/business/records', 'POST', { kind: 'vehicle', data: { vin, status: 'available', complianceLevel: 'Eu7', thermal: 'No Heat Pump' }, reason: 'Register fictional revision vehicle' })
    assert.equal(result.status, 201, JSON.stringify(result.data)); return result.data as BusinessRecord
  }
  async function enable() { const result = await request('/business/configuration-revisions/enable', 'POST', { requestId: randomUUID(), reason: 'All fictional clients upgraded' }); assert.equal(result.status, 200, JSON.stringify(result.data)) }
  async function preview(vehicleId: string, session = 'owner') { const result = await request(`/business/vehicles/${vehicleId}/configuration-revisions/preview`, 'POST', {}, session); assert.equal(result.status, 200, JSON.stringify(result.data)); return result.data as ConfigurationPreview }
  const publication = (value: ConfigurationPreview) => ({ previewToken: value.token, requestId: randomUUID(), title: 'Fictional trial configuration', summary: 'Record the reviewed retrofit configuration', decisions: reviewed(value) })
  async function close() { await new Promise<void>(resolve => server.close(() => resolve())); await client.close(); await fs.rm(directory, { recursive: true, force: true }) }
  await register('owner')
  return { directory, client, sessions, request, team, member, car, enable, preview, publication, close }
}

test('revision HTTP workflow freezes reviewed configurations, rejects silent blanks, and keeps working counters separate', async () => {
  const f = await fixture()
  try {
    await f.team(); const car = await f.car()
    assert.equal((await f.request(`/business/vehicles/${car.id}/configuration-revisions/preview`, 'POST', {})).status, 409)
    await f.enable()
    const preview = await f.preview(car.id), command = f.publication(preview)
    const missing = await f.request(`/business/vehicles/${car.id}/configuration-revisions`, 'POST', { ...command, decisions: { fields: {}, sections: {} } })
    assert.equal(missing.status, 409); assert.equal(missing.data.error, 'REVISION_INFORMATION_REQUIRED')
    const result = await f.request(`/business/vehicles/${car.id}/configuration-revisions`, 'POST', command)
    assert.equal(result.status, 201, JSON.stringify(result.data)); assert.equal(result.data.label, 'R01')
    const repeated = await f.request(`/business/vehicles/${car.id}/configuration-revisions`, 'POST', command)
    assert.equal(repeated.data.revisionId, result.data.revisionId)
    const view = (await f.request('/business/working-view')).data
    assert.equal(view.revisionSummaries[0].hasChanges, false)
    assert.equal(view.records.find((row: BusinessRecord) => row.id === car.id).version, car.version)
    assert(view.records.every((row: BusinessRecord) => !['configurationRevision', 'componentType'].includes(row.kind)))
    const immutable = await f.request(`/business/records/${result.data.revisionId}`, 'PUT', { version: 1, data: {}, reason: 'Attempt to rewrite published history' })
    assert.equal(immutable.status, 409); assert.equal(immutable.data.error, 'CONFIGURATION_IMMUTABLE')
    assert.equal((await f.request(`/business/records/${result.data.revisionId}/archive`, 'POST', { version: 1, archived: true, reason: 'Attempt to hide published history' })).status, 409)
    const updated = await f.request(`/business/records/${car.id}`, 'PUT', { data: { ...car.data, owner: 'Another owner', physicalLocation: 'Fictional garage' }, version: car.version, reason: 'Change administrative information' })
    assert.equal(updated.status, 200)
    assert.equal((await f.request('/business/working-view')).data.revisionSummaries[0].hasChanges, false)
    const motor = await f.request('/business/records', 'POST', { kind: 'part', vehicleId: car.id, data: { name: 'Front eMotor', category: 'motor', position: 'Front', productPart: 'MOTOR-PN-001', serial: 'MOTOR-SN-001', maturity: 'POC' }, reason: 'Fit fictional eMotor' })
    assert.equal(motor.status, 201)
    assert.equal((await f.request('/business/working-view')).data.revisionSummaries[0].hasChanges, true)
    const next = await f.request(`/business/vehicles/${car.id}/configuration-revisions`, 'POST', f.publication(await f.preview(car.id)))
    assert.equal(next.data.label, 'R02')
    assert.equal((await f.request(`/business/vehicles/${car.id}/configuration-revisions`)).data.length, 2)
  } finally { await f.close() }
})

test('catalog administration and component writes preserve member access, disabled references, and paused read access', async () => {
  const f = await fixture()
  try {
    const team = await f.team(); const car = await f.car(); await f.enable(); await f.member(team)
    assert.equal((await f.request('/business/component-types', 'POST', { name: 'Charger' }, 'member')).status, 403)
    const created = await f.request('/business/component-types', 'POST', { name: 'Charger', description: 'Fictional OBC', requestId: randomUUID(), reason: 'Add trial component category' })
    assert.equal(created.status, 201, JSON.stringify(created.data))
    const type = created.data
    const body = { kind: 'part', vehicleId: car.id, data: { category: 'component', componentTypeId: type.id, name: 'On-board charger', productPart: 'OBC-PN', serial: 'OBC-SN', maturity: 'POC' }, reason: 'Fit fictional charger' }
    const component = await f.request('/business/records', 'POST', body, 'member')
    assert.equal(component.status, 201, JSON.stringify(component.data))
    const disabled = await f.request(`/business/component-types/${type.id}`, 'PUT', { version: type.version, name: type.name, description: type.description, disabled: true, requestId: randomUUID(), reason: 'Retire from new selection' })
    assert.equal(disabled.status, 200, JSON.stringify(disabled.data))
    assert.equal((await f.request('/business/records', 'POST', body, 'member')).data.error, 'COMPONENT_TYPE_DISABLED')
    assert.equal((await f.request(`/business/records/${component.data.id}`, 'PUT', { version: component.data.version, data: { ...component.data.data, notes: 'Keep maintaining an existing disabled type' }, reason: 'Update installed charger' }, 'member')).status, 200)
    const memberRevision = await f.request(`/business/vehicles/${car.id}/configuration-revisions`, 'POST', f.publication(await f.preview(car.id, 'member')), 'member')
    assert.equal(memberRevision.status, 201, JSON.stringify(memberRevision.data)); assert.equal(memberRevision.data.label, 'R01')
    f.client.store.db.exec('UPDATE sessions SET sync_enabled=0')
    assert.equal((await f.request('/business/working-view', 'GET', undefined, 'member')).status, 200)
    assert.equal((await f.request(`/business/vehicles/${car.id}/configuration-revisions/preview`, 'POST', {}, 'member')).data.error, 'CONFIRM_RESUME')
  } finally { await f.close() }
})

test('revision previews reject intervening source changes and workspace selection epochs', async () => {
  const f = await fixture()
  try {
    const first = await f.team(), car = await f.car(); await f.enable()
    const old = f.publication(await f.preview(car.id))
    await f.request('/business/records', 'POST', { kind: 'part', vehicleId: car.id, data: { name: 'Rear motor', category: 'motor', position: 'Rear' }, reason: 'Change the reviewed component graph' })
    const stale = await f.request(`/business/vehicles/${car.id}/configuration-revisions`, 'POST', old)
    assert.equal(stale.status, 409); assert.equal(stale.data.error, 'REVISION_PREVIEW_CHANGED')
    const selected = f.publication(await f.preview(car.id)), oldToken = f.sessions.get('owner')!.token
    await f.team('Team B')
    assert.equal((await f.request(`/business/vehicles/${car.id}/configuration-revisions`, 'POST', selected, 'owner', oldToken)).data.error, 'WORKSPACE_CHANGED')
    assert.equal((await f.request('/business/working-view')).data.catalog.enabled, false)
    assert.equal((await f.request('/workspaces/select', 'POST', { teamId: first.id, retainPending: true })).status, 200)
    assert.equal((await f.request(`/business/vehicles/${car.id}/configuration-revisions`, 'POST', selected)).data.error, 'REVISION_PREVIEW_CHANGED')
  } finally { await f.close() }
})

test('revision receipts survive vehicle deletion and VIN reuse starts a new revision identity', async () => {
  const f = await fixture()
  try {
    await f.team(); const car = await f.car(); await f.enable()
    const command = f.publication(await f.preview(car.id)), published = await f.request(`/business/vehicles/${car.id}/configuration-revisions`, 'POST', command)
    assert.equal(published.status, 201)
    assert.equal((await f.request(`/business/records/${car.id}/archive`, 'POST', { version: car.version, archived: true, reason: 'Archive fictional vehicle before deletion' })).status, 200)
    const preview = await f.request(`/business/vehicles/${car.id}/delete-preview`)
    assert.equal(preview.data.counts.configurationRevision, 1)
    const deleted = await f.request(`/business/vehicles/${car.id}`, 'DELETE', { previewToken: preview.data.token, version: preview.data.version, vin: car.data.vin, confirmation: 'DELETE', reason: 'Delete fictional vehicle', requestId: randomUUID() })
    assert.equal(deleted.status, 200, JSON.stringify(deleted.data))
    const retry = await f.request(`/business/vehicles/${car.id}/configuration-revisions`, 'POST', command)
    assert.equal(retry.status, 201, JSON.stringify(retry.data)); assert.equal(retry.data.revisionId, published.data.revisionId)
    const replacement = await f.car(String(car.data.vin)); assert.notEqual(replacement.id, car.id)
    const fresh = await f.request(`/business/vehicles/${replacement.id}/configuration-revisions`, 'POST', f.publication(await f.preview(replacement.id)))
    assert.equal(fresh.data.label, 'R01')
  } finally { await f.close() }
})
