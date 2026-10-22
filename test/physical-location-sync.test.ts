import { test } from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Business, normalizeFields } from '../server/business.js'
import { LocalStore } from '../server/store.js'
import { BusinessSync } from '../server/sync.js'
import { TeamDirectory } from '../server/team.js'
import type { Actor, Fields } from '../shared/business.js'

async function fixture() {
  const directory = await fs.mkdtemp(path.join(tmpdir(), 'vehicle-location-sync-'))
  const shared = path.join(directory, 'shared')
  await fs.mkdir(shared)
  const clients = ['alpha', 'beta'].map(name => {
    const store = new LocalStore(path.join(directory, name)), business = new Business(store), teams = new TeamDirectory()
    return { store, business, teams, sync: new BusinessSync(business, teams), identity: { deviceId: store.deviceId, deviceName: name, localUserId: name, displayName: name }, actor: null as Actor | null }
  })
  const [alpha, beta] = clients
  const team = await alpha.teams.create(shared, 'Location test', alpha.identity)
  const requested = await beta.teams.join(shared, team.id, beta.identity)
  const approved = await alpha.teams.approve(shared, team.id, alpha.identity, requested.requests[0].id, 'admin', null, 'Test device approved')
  for (const client of clients) client.actor = { id: approved.bindings.find(binding => binding.deviceId === client.identity.deviceId)!.memberId, name: client.identity.displayName, deviceId: client.store.deviceId, role: 'admin' }
  const sync = (index: number) => clients[index].sync.synchronize(shared, team.id, clients[index].identity)
  const seed = async (legacy = true, missingOwner = false) => {
    const data = normalizeFields('vehicle', { name: 'Vehicle', vin: 'TEST0000000000001', status: 'available' })
    if (legacy) delete data.physicalLocation
    if (missingOwner) delete data.owner
    // Model a record created before physicalLocation existed, without rewriting live data.
    const car = alpha.business.write({ kind: 'vehicle', data, actor: alpha.actor!, reason: 'Seed vehicle', internal: true })
    assert.equal((await sync(0)).phase, 'ready')
    assert.equal((await sync(1)).phase, 'ready')
    return car.id
  }
  const edit = (index: number, id: string, fields: Fields, archived?: boolean) => {
    const client = clients[index], current = client.business.get(id)
    return client.business.write({ id, kind: 'vehicle', data: { ...current.data, ...fields }, version: current.version, actor: client.actor!, reason: 'Update vehicle', ...(archived === undefined ? {} : { archived }) })
  }
  const converge = async () => {
    for (const index of [0, 1, 0]) {
      const state = await sync(index)
      assert.equal(state.phase, 'ready')
      assert.equal(state.pending, 0)
      assert.deepEqual(state.conflicts, [])
    }
  }
  const close = async () => {
    for (const client of clients) client.store.db.close()
    await fs.rm(directory, { recursive: true, force: true })
  }
  return { clients, shared, teamId: team.id, seed, edit, sync, converge, close }
}

for (const order of [[0, 1], [1, 0]]) {
  test(`legacy missing location merges with an unrelated edit in sync order ${order.join(',')}`, async () => {
    const context = await fixture()
    try {
      const id = await context.seed()
      for (const client of context.clients) assert.equal(Object.hasOwn(client.business.get(id).data, 'physicalLocation'), false)
      context.edit(0, id, { physicalLocation: 'Building 2 / Bay 3' })
      context.edit(1, id, { owner: 'Test driver' })
      for (const index of order) assert.equal((await context.sync(index)).phase, 'ready')
      await context.converge()
      for (const client of context.clients) {
        assert.equal(client.business.get(id).data.physicalLocation, 'Building 2 / Bay 3')
        assert.equal(client.business.get(id).data.owner, 'Test driver')
      }
    } finally { await context.close() }
  })
}

for (const choice of ['local', 'shared']) {
  test(`different physical locations remain a real conflict resolved with ${choice}`, async () => {
    const context = await fixture()
    try {
      const id = await context.seed()
      context.edit(0, id, { physicalLocation: 'Shared laboratory' })
      context.edit(1, id, { physicalLocation: 'Local workshop' })
      await context.sync(0)
      const state = await context.sync(1), conflict = state.conflicts[0]
      assert.equal(state.phase, 'conflict')
      assert.deepEqual(conflict.fields, ['physicalLocation'])
      const beta = context.clients[1]
      await assert.rejects(beta.sync.resolve(context.shared, context.teamId, beta.identity, beta.actor!, id, 'stale-token', { physicalLocation: choice }, 'Invalid token'), { code: 'CONFLICT_CHANGED' })
      assert.equal((await beta.sync.resolve(context.shared, context.teamId, beta.identity, beta.actor!, id, conflict.token, { physicalLocation: choice }, 'Confirmed physical location')).phase, 'ready')
      await context.converge()
      for (const client of context.clients) assert.equal(client.business.get(id).data.physicalLocation, choice === 'local' ? 'Local workshop' : 'Shared laboratory')
      context.edit(1, id, { physicalLocation: '' })
      await context.converge()
      for (const client of context.clients) assert.equal(client.business.get(id).data.physicalLocation, '')
    } finally { await context.close() }
  })
}

test('resolving an unrelated conflict preserves the shared location absent from the legacy local base', async () => {
  const context = await fixture()
  try {
    const id = await context.seed()
    context.edit(0, id, { physicalLocation: 'Remote laboratory', owner: 'Shared owner' })
    context.edit(1, id, { owner: 'Local owner' })
    await context.sync(0)
    const state = await context.sync(1), conflict = state.conflicts[0], beta = context.clients[1]
    assert.deepEqual(conflict.fields, ['owner'])
    assert.equal((await beta.sync.resolve(context.shared, context.teamId, beta.identity, beta.actor!, id, conflict.token, { owner: 'local' }, 'Keep local owner')).phase, 'ready')
    await context.converge()
    for (const client of context.clients) {
      assert.equal(client.business.get(id).data.owner, 'Local owner')
      assert.equal(client.business.get(id).data.physicalLocation, 'Remote laboratory')
    }
  } finally { await context.close() }
})

for (const concurrentArchive of [false, true]) {
  test(`empty shared location and missing local location do not conflict with archiving (concurrent=${concurrentArchive})`, async () => {
    const context = await fixture()
    try {
      const id = await context.seed(false), beta = context.clients[1]
      const legacy = { ...beta.business.get(id).data }
      delete legacy.physicalLocation
      // Emulate an older client whose local field allowlist omits physicalLocation.
      beta.store.db.prepare('UPDATE records SET data=? WHERE id=?').run(JSON.stringify(legacy), id)
      if (concurrentArchive) context.edit(0, id, {}, true)
      context.edit(1, id, {}, true)
      if (concurrentArchive) assert.equal((await context.sync(0)).phase, 'ready')
      assert.equal((await context.sync(1)).phase, 'ready')
      await context.converge()
      for (const client of context.clients) assert.equal(client.business.get(id).archived, true)
    } finally { await context.close() }
  })
}

test('blank normalization cannot silently undo a concurrent archive', async () => {
  const context = await fixture()
  try {
    const id = await context.seed()
    context.edit(0, id, {}, true)
    context.edit(1, id, {})
    await context.sync(0)
    const state = await context.sync(1), conflict = state.conflicts[0], beta = context.clients[1]
    assert.equal(state.phase, 'conflict')
    assert.deepEqual(conflict.fields, ['_archived'])
    await beta.sync.resolve(context.shared, context.teamId, beta.identity, beta.actor!, id, conflict.token, { _archived: 'shared' }, 'Keep archived vehicle')
    await context.converge()
    for (const client of context.clients) assert.equal(client.business.get(id).archived, true)
  } finally { await context.close() }
})

test('missing-versus-empty equivalence does not extend to other vehicle fields', async () => {
  const context = await fixture()
  try {
    const id = await context.seed(true, true)
    context.edit(0, id, { owner: 'Shared owner' })
    context.edit(1, id, { notes: 'Unrelated edit' })
    await context.sync(0)
    const state = await context.sync(1)
    assert.equal(state.phase, 'conflict')
    assert.deepEqual(state.conflicts[0].fields, ['owner'])
  } finally { await context.close() }
})
