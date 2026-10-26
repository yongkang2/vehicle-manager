import { test } from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Business, normalizeFields } from '../server/business.js'
import { LocalStore } from '../server/store.js'
import { BusinessSync } from '../server/sync.js'
import { TeamDirectory } from '../server/team.js'
import type { Actor, Fields } from '../shared/business.js'

async function fixture() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'vehicle-compliance-sync-')), shared = path.join(directory, 'shared'); await fs.mkdir(shared)
  const clients = ['alpha', 'beta'].map(name => {
    const store = new LocalStore(path.join(directory, name)), business = new Business(store), teams = new TeamDirectory()
    return { store, business, teams, sync: new BusinessSync(business, teams), actor: null as Actor | null, identity: { deviceId: store.deviceId, deviceName: name, localUserId: name, displayName: name } }
  })
  const [alpha, beta] = clients, team = await alpha.teams.create(shared, 'Compliance test', alpha.identity), joined = await beta.teams.join(shared, team.id, beta.identity)
  const approved = await alpha.teams.approve(shared, team.id, alpha.identity, joined.requests[0].id, 'admin', null, 'Approve synthetic compliance client')
  for (const client of clients) client.actor = { id: approved.bindings.find(binding => binding.deviceId === client.store.deviceId)!.memberId, name: client.identity.displayName, deviceId: client.store.deviceId, role: 'admin' }
  const sync = (index: number) => clients[index].sync.synchronize(shared, team.id, clients[index].identity)
  const converge = async () => { for (const index of [0, 1, 0]) { const state = await sync(index); assert.equal(state.phase, 'ready', JSON.stringify(state)); assert.equal(state.pending, 0); assert.deepEqual(state.conflicts, []) } }
  const seed = async () => {
    const data = normalizeFields('vehicle', { vin: 'TEST0000000000001', status: 'available', owner: 'Original owner' }); delete data.complianceLevel
    const car = alpha.business.write({ kind: 'vehicle', data, actor: alpha.actor!, reason: 'Synthetic pre-compliance vehicle', internal: true })
    await converge(); return car.id
  }
  const edit = (index: number, id: string, fields: Fields = {}, archived?: boolean) => {
    const client = clients[index], current = client.business.get(id)
    return client.business.write({ id, kind: 'vehicle', data: { ...current.data, ...fields }, version: current.version, actor: client.actor!, reason: 'Update synthetic compliance vehicle', ...(archived === undefined ? {} : { archived }) })
  }
  return { clients, shared, teamId: team.id, seed, edit, sync, converge, async close() { for (const client of clients) client.store.db.close(); await fs.rm(directory, { recursive: true, force: true }) } }
}

for (const order of [[0, 1], [1, 0]]) test(`legacy missing/blank compliance merges with an unrelated edit in order ${order}`, async () => {
  const f = await fixture()
  try {
    const id = await f.seed()
    for (const client of f.clients) assert.equal(Object.hasOwn(client.business.get(id).data, 'complianceLevel'), false)
    f.edit(0, id, { complianceLevel: 'Eu7' })
    assert.equal(f.edit(1, id, { owner: 'Independent owner' }).data.complianceLevel, '')
    for (const index of order) assert.equal((await f.sync(index)).phase, 'ready')
    await f.converge()
    for (const client of f.clients) { const car = client.business.get(id); assert.equal(car.data.complianceLevel, 'Eu7'); assert.equal(car.data.owner, 'Independent owner') }
  } finally { await f.close() }
})

for (const choice of ['local', 'shared'] as const) test(`competing compliance classifications conflict and resolve to ${choice}`, async () => {
  const f = await fixture()
  try {
    const id = await f.seed()
    f.edit(0, id, { complianceLevel: 'Eu7' }); f.edit(1, id, { complianceLevel: 'CN6' }); await f.sync(0)
    const state = await f.sync(1), conflict = state.conflicts[0], beta = f.clients[1]
    assert.equal(state.phase, 'conflict'); assert.equal(state.conflicts.length, 1); assert.deepEqual(conflict.fields, ['complianceLevel'])
    assert.equal((await beta.sync.resolve(f.shared, f.teamId, beta.identity, beta.actor!, id, conflict.token, { complianceLevel: choice }, 'Resolve actual compliance')).phase, 'ready')
    await f.converge()
    for (const client of f.clients) assert.equal(client.business.get(id).data.complianceLevel, choice === 'local' ? 'CN6' : 'Eu7')
  } finally { await f.close() }
})

for (const order of [[0, 1], [1, 0]]) test(`matching archives ignore missing versus blank compliance in order ${order}`, async () => {
  const f = await fixture()
  try {
    const id = await f.seed(); f.edit(0, id, {}, true); f.edit(1, id, {}, true)
    for (const index of order) assert.equal((await f.sync(index)).phase, 'ready')
    await f.converge()
    for (const client of f.clients) { const car = client.business.get(id); assert.equal(car.archived, true); assert.equal(String(car.data.complianceLevel ?? ''), '') }
  } finally { await f.close() }
})

test('blank compliance normalization cannot silently undo a concurrent shared archive', async () => {
  const f = await fixture()
  try {
    const id = await f.seed(); f.edit(0, id); f.edit(1, id, {}, true); await f.sync(1)
    const state = await f.sync(0)
    assert.equal(state.phase, 'conflict'); assert.equal(state.conflicts.length, 1); assert.deepEqual(state.conflicts[0].fields, ['_archived'])
  } finally { await f.close() }
})

test('genuine compliance changes still conflict with concurrent archive at whole-record comparison', async () => {
  const f = await fixture()
  try {
    const id = await f.seed(); f.edit(0, id, { complianceLevel: 'PL8' }); f.edit(1, id, {}, true); await f.sync(0)
    const state = await f.sync(1)
    assert.equal(state.phase, 'conflict'); assert.equal(state.conflicts.length, 1); assert(state.conflicts[0].fields.includes('_archived'))
  } finally { await f.close() }
})
