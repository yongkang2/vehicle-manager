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

const specs = [
  { field: 'controllerType', category: 'controller', name: 'VCU', first: 'Open ECU', second: 'Close ECU' },
  { field: 'lifeStatus', category: 'battery', name: 'HV Battery', first: 'BOL', second: 'EOL' },
] as const
async function fixture() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'vehicle-part-metadata-sync-')), shared = path.join(directory, 'shared'); await fs.mkdir(shared)
  const clients = ['alpha', 'beta'].map(name => {
    const store = new LocalStore(path.join(directory, name)), business = new Business(store), teams = new TeamDirectory()
    return { store, business, teams, sync: new BusinessSync(business, teams), actor: null as Actor | null, identity: { deviceId: store.deviceId, deviceName: name, localUserId: name, displayName: name } }
  })
  const [alpha, beta] = clients, team = await alpha.teams.create(shared, 'Part metadata test', alpha.identity)
  const joined = await beta.teams.join(shared, team.id, beta.identity), approved = await alpha.teams.approve(shared, team.id, alpha.identity, joined.requests[0].id, 'admin', null, 'Approve synthetic client')
  for (const client of clients) client.actor = { id: approved.bindings.find(binding => binding.deviceId === client.store.deviceId)!.memberId, name: client.identity.displayName, deviceId: client.store.deviceId, role: 'admin' }
  const sync = (index: number) => clients[index].sync.synchronize(shared, team.id, clients[index].identity)
  const converge = async () => { for (const index of [0, 1, 0]) { const state = await sync(index); assert.equal(state.phase, 'ready', JSON.stringify(state)); assert.equal(state.pending, 0); assert.deepEqual(state.conflicts, []) } }
  const seed = async (spec: typeof specs[number]) => {
    const car = alpha.business.write({ kind: 'vehicle', data: { vin: 'TEST0000000000001', status: 'available' }, actor: alpha.actor!, reason: 'Register synthetic vehicle' })
    const data = normalizeFields('part', { name: spec.name, category: spec.category, type: 'ETK', batteryStatus: 'healthy', serial: '000123' })
    delete data.controllerType; delete data.lifeStatus
    const part = alpha.business.write({ kind: 'part', vehicleId: car.id, data, actor: alpha.actor!, reason: 'Legacy part without new optional keys', internal: true })
    await converge(); return part
  }
  const edit = (index: number, id: string, changes: Fields = {}, archived?: boolean) => {
    const client = clients[index], current = client.business.get(id)
    return client.business.write({ id, kind: current.kind, vehicleId: current.vehicleId, data: { ...current.data, ...changes }, version: current.version, actor: client.actor!, reason: 'Update synthetic part metadata', ...(archived === undefined ? {} : { archived }) })
  }
  return { clients, shared, teamId: team.id, sync, converge, seed, edit, async close() { for (const client of clients) client.store.db.close(); await fs.rm(directory, { recursive: true, force: true }) } }
}

for (const spec of specs) {
  for (const order of [[0, 1], [1, 0]]) test(`${spec.field} merges with unrelated legacy edits and missing/blank keys in order ${order}`, async () => {
    const f = await fixture()
    try {
      const part = await f.seed(spec)
      for (const client of f.clients) assert.equal(Object.hasOwn(client.business.get(part.id).data, spec.field), false)
      f.edit(0, part.id, { [spec.field]: spec.first })
      const unrelated = f.edit(1, part.id, { supplier: 'Independent supplier edit' })
      assert.equal(unrelated.data[spec.field], '')
      for (const index of order) assert.equal((await f.sync(index)).phase, 'ready')
      await f.converge()
      for (const client of f.clients) {
        const current = client.business.get(part.id)
        assert.equal(current.data[spec.field], spec.first)
        assert.equal(current.data.supplier, 'Independent supplier edit')
        assert.equal(current.data.type, 'ETK'); assert.equal(current.data.batteryStatus, 'healthy')
      }
    } finally { await f.close() }
  })
  for (const choice of ['local', 'shared'] as const) test(`competing ${spec.field} values conflict and resolve to ${choice}`, async () => {
    const f = await fixture()
    try {
      const part = await f.seed(spec)
      f.edit(0, part.id, { [spec.field]: spec.first }); f.edit(1, part.id, { [spec.field]: spec.second })
      await f.sync(0)
      const state = await f.sync(1), conflict = state.conflicts[0], beta = f.clients[1]
      assert.equal(state.phase, 'conflict'); assert.equal(state.conflicts.length, 1); assert.deepEqual(conflict.fields, [spec.field])
      const resolved = await beta.sync.resolve(f.shared, f.teamId, beta.identity, beta.actor!, part.id, conflict.token, { [spec.field]: choice }, 'Resolve competing classification')
      assert.equal(resolved.phase, 'ready'); await f.converge()
      for (const client of f.clients) assert.equal(client.business.get(part.id).data[spec.field], choice === 'local' ? spec.second : spec.first)
    } finally { await f.close() }
  })
  for (const order of [[0, 1], [1, 0]]) test(`matching archives ignore materialized blank ${spec.field} in order ${order}`, async () => {
    const f = await fixture()
    try {
      const part = await f.seed(spec)
      f.edit(0, part.id, {}, true)
      f.edit(1, part.id, {}, true)
      for (const index of order) assert.equal((await f.sync(index)).phase, 'ready')
      await f.converge()
      for (const client of f.clients) { const current = client.business.get(part.id); assert.equal(current.archived, true); assert.equal(String(current.data[spec.field] ?? ''), '') }
    } finally { await f.close() }
  })
  test(`blank ${spec.field} normalization retains the conservative remote archive conflict`, async () => {
    const f = await fixture()
    try {
      const part = await f.seed(spec)
      f.edit(0, part.id); f.edit(1, part.id, {}, true)
      await f.sync(1)
      const state = await f.sync(0)
      assert.equal(state.phase, 'conflict'); assert.equal(state.conflicts.length, 1); assert.deepEqual(state.conflicts[0].fields, ['_archived'])
    } finally { await f.close() }
  })
  test(`a genuine ${spec.field} change still conflicts with concurrent archive`, async () => {
    const f = await fixture()
    try {
      const part = await f.seed(spec)
      f.edit(0, part.id, { [spec.field]: spec.first }); f.edit(1, part.id, {}, true)
      await f.sync(0)
      const state = await f.sync(1)
      assert.equal(state.phase, 'conflict'); assert.equal(state.conflicts.length, 1); assert(state.conflicts[0].fields.includes('_archived'))
    } finally { await f.close() }
  })
}
