import assert from 'node:assert/strict'
import { once } from 'node:events'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createApp } from '../server/app.js'
import type { Actor, BusinessRecord } from '../shared/business.js'

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vehicle-manager-usage-audit-'))
const shared = path.join(root, 'shared')
await fs.mkdir(shared)
const clients = ['admin', 'engineer', 'reviewer'].map(name => {
  const client = createApp({ dataDir: path.join(root, name) })
  return { ...client, name, server: client.app.listen(0, '127.0.0.1'), cookie: '', token: '' }
})
const metrics: { scenario: string; ms: number; bytes?: number; records?: number; timings?: unknown }[] = []
const revisions = new Map<string, string>()
async function request(client: typeof clients[number], route: string, method = 'GET', body?: unknown) {
  const start = performance.now()
  const response = await fetch(`http://127.0.0.1:${(client.server.address() as { port: number }).port}/api${route}`, {
    method,
    headers: { Connection: 'close', Cookie: client.cookie, 'X-Workspace-Token': client.token, 'X-App-Request': 'vehicle-manager', ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(120000),
  }).catch(cause => { throw new Error(`${client.name} ${method} ${route} failed after ${Math.round(performance.now() - start)} ms`, { cause }) })
  client.cookie = response.headers.get('set-cookie')?.split(';')[0] || client.cookie
  client.token = response.headers.get('x-workspace-token') || client.token
  const text = await response.text()
  assert.equal(response.ok, true, `${client.name} ${route}: ${response.status} ${text.slice(0, 500)}`)
  return { data: JSON.parse(text), ms: Math.round(performance.now() - start), bytes: Buffer.byteLength(text) }
}
try {
  for (const client of clients) {
    if (!client.server.listening) await once(client.server, 'listening')
    await request(client, '/register', 'POST', { username: client.name, displayName: client.name, password: 'Synthetic-audit-2026!' })
  }
  const [admin, engineer, reviewer] = clients
  const teamId = (await request(admin, '/setup/configure', 'POST', { path: shared, mode: 'create', teamName: 'Synthetic load audit', confirmed: true })).data.teamId as string
  for (const client of [engineer, reviewer]) await request(client, '/setup/configure', 'POST', { path: shared, mode: 'join', teamId })
  const team = (await request(admin, '/team')).data
  for (const pending of team.requests) await request(admin, `/team/requests/${pending.id}/approve`, 'POST', { role: 'member', memberId: null, reason: 'Synthetic multi-device audit' })
  const workspace = admin.workspaces.get(teamId)
  const actor: Actor = { id: team.bindings.find((binding: { deviceId: string }) => binding.deviceId === admin.store.deviceId).memberId, name: 'admin', deviceId: admin.store.deviceId, role: 'admin' }
  const start = performance.now()
  let firstVehicle: BusinessRecord | undefined
  for (let vehicleIndex = 0; vehicleIndex < 1000; vehicleIndex++) {
    const vehicle = workspace.business.write({ kind: 'vehicle', data: { vin: `TEST${String(vehicleIndex).padStart(13, '0')}`, name: `Audit vehicle ${vehicleIndex}`, model: `Model ${vehicleIndex % 10}`, status: 'available', complianceLevel: 'Eu7' }, actor, reason: 'Synthetic fleet seed' })
    firstVehicle ||= vehicle
    for (let equipmentIndex = 0; equipmentIndex < 5; equipmentIndex++) workspace.business.write({ kind: 'equipment', vehicleId: vehicle.id, data: { name: `Logger ${equipmentIndex}`, equipmentType: 'ETAS tools', description: 'Synthetic measurement equipment' }, actor, reason: 'Synthetic equipment seed' })
  }
  metrics.push({ scenario: 'seed-domain-writes', ms: Math.round(performance.now() - start), records: 6000 })
  console.log(JSON.stringify(metrics.at(-1)))
  for (const client of clients) {
    const result = await request(client, '/business/sync', 'POST')
    assert.equal(result.data.phase, 'ready', JSON.stringify(result.data))
    assert.equal(result.data.pending, 0)
    metrics.push({ scenario: `${client.name}-initial-sync`, ms: result.ms, timings: result.data.timings })
    console.log(JSON.stringify(metrics.at(-1)))
  }
  for (const client of clients) {
    const snapshot = await request(client, '/business/workspace?local=1')
    assert.equal(snapshot.data.data.records.length, 6000)
    revisions.set(client.name, snapshot.data.revision)
    metrics.push({ scenario: `${client.name}-workspace`, ms: snapshot.ms, bytes: snapshot.bytes, records: 6000 })
    const unchanged = await request(client, `/business/workspace?local=1&known=${snapshot.data.revision}`)
    assert.equal(unchanged.data.data, undefined)
    metrics.push({ scenario: `${client.name}-unchanged`, ms: unchanged.ms, bytes: unchanged.bytes })
    const query = { search: '', archived: false, page: 1, pageSize: 10, filters: {} }
    const page = await request(client, `/business/vehicle-list?local=1&query=${encodeURIComponent(JSON.stringify(query))}`)
    assert.equal(page.data.data.vehicleList.total, 1000)
    assert.equal(page.data.data.vehicleList.counts.total, 1000)
    assert.equal(page.data.data.records.length, 10, 'equipment is not part of the vehicle list payload')
    assert(page.bytes < snapshot.bytes / 4, 'summary page must be substantially smaller than the full working view')
    const last = await request(client, `/business/vehicle-list?local=1&query=${encodeURIComponent(JSON.stringify({ ...query, page: 100 }))}`)
    assert.equal(last.data.data.records.length, 10)
    assert.equal(last.data.data.vehicleList.page, 100)
    const selected = await request(client, `/business/vehicle-list?local=1&query=${encodeURIComponent(JSON.stringify({ ...query, search: String(firstVehicle!.data.vin), detailId: firstVehicle!.id }))}`)
    assert.equal(selected.data.data.vehicleList.total, 1)
    assert.equal(selected.data.data.records.filter((record: BusinessRecord) => record.kind === 'equipment').length, 5)
    metrics.push({ scenario: `${client.name}-vehicle-page`, ms: page.ms, bytes: page.bytes, records: 10 })
  }
  const target = firstVehicle!
  await request(engineer, `/business/records/${target.id}`, 'PUT', { version: target.version, data: { ...target.data, owner: 'Engineer update under load' }, reason: 'Synthetic propagation check' })
  await engineer.synchronization.settle()
  for (const client of [admin, reviewer]) {
    const result = await request(client, '/business/sync', 'POST')
    assert.equal(result.data.phase, 'ready')
    assert.equal(result.data.conflicts.length, 0)
    const updated = await request(client, `/business/workspace?local=1&delta=1&known=${revisions.get(client.name)}`)
    assert.equal(updated.data.data, undefined)
    assert.equal(updated.data.patch.baseRevision, revisions.get(client.name))
    assert.equal(updated.data.patch.upsert.length, 1)
    const found = updated.data.patch.upsert.find((record: BusinessRecord) => record.id === target.id)
    assert.equal(found.data.owner, 'Engineer update under load')
    assert.equal(client.workspaces.get(teamId).business.list().length, 6000)
    metrics.push({ scenario: `${client.name}-single-change-sync`, ms: result.ms, bytes: updated.bytes })
  }
  const history = await request(reviewer, '/business/history/query?summary=1')
  assert.equal(history.data.total, 6001)
  assert.equal(history.data.items.length, 50)
  metrics.push({ scenario: 'history-summary', ms: history.ms, bytes: history.bytes, records: history.data.total })
  console.log(JSON.stringify({ clients: 3, vehicles: 1000, equipment: 5000, metrics, assertions: 'passed', environment: 'One Windows host, separate local databases, local shared directory; not SMB acceptance' }, null, 2))
} finally {
  for (const client of clients) {
    client.server.closeAllConnections()
    await new Promise<void>(resolve => client.server.close(() => resolve()))
    await client.close()
  }
  await fs.rm(root, { recursive: true, force: true })
}
