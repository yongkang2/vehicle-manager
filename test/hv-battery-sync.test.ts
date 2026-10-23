import { test } from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Business } from '../server/business.js'
import { LocalStore } from '../server/store.js'
import { BusinessSync } from '../server/sync.js'
import { TeamDirectory } from '../server/team.js'
import { activeHvBatteries } from '../shared/business.js'
import type { Actor, Fields } from '../shared/business.js'

async function fixture() {
  const directory = await fs.mkdtemp(path.join(tmpdir(), 'vehicle-hv-battery-sync-'))
  const shared = path.join(directory, 'shared')
  await fs.mkdir(shared)
  const clients = ['alpha', 'beta'].map(name => {
    const store = new LocalStore(path.join(directory, name)), business = new Business(store), teams = new TeamDirectory()
    return { store, business, teams, sync: new BusinessSync(business, teams), identity: { deviceId: store.deviceId, deviceName: name, localUserId: name, displayName: name }, actor: null as Actor | null }
  })
  const [alpha, beta] = clients
  const team = await alpha.teams.create(shared, 'HV battery test', alpha.identity)
  const requested = await beta.teams.join(shared, team.id, beta.identity)
  const approved = await alpha.teams.approve(shared, team.id, alpha.identity, requested.requests[0].id, 'admin', null, 'Test device approved')
  for (const client of clients) client.actor = { id: approved.bindings.find(binding => binding.deviceId === client.identity.deviceId)!.memberId, name: client.identity.displayName, deviceId: client.store.deviceId, role: 'admin' }
  const sync = (index: number) => clients[index].sync.synchronize(shared, team.id, clients[index].identity)
  const converge = async () => {
    for (const index of [0, 1, 0]) {
      const state = await sync(index)
      assert.equal(state.phase, 'ready')
      assert.equal(state.pending, 0)
      assert.deepEqual(state.conflicts, [])
    }
  }
  const seed = async () => {
    const vehicle = alpha.business.write({ kind: 'vehicle', data: { name: 'Battery test vehicle', vin: 'TEST0000000000001', status: 'available' }, actor: alpha.actor!, reason: 'Register test vehicle' })
    const battery = alpha.business.write({ kind: 'part', vehicleId: vehicle.id, data: { name: 'HV Battery', category: 'battery', productPart: '00001234', serial: '00005678', maturity: 'Prototype' }, actor: alpha.actor!, reason: 'Install test HV battery' })
    const controller = alpha.business.write({ kind: 'part', vehicleId: vehicle.id, data: { name: 'BMS', category: 'controller', productPart: 'BMS-0001', serial: 'BMS-0002', maturity: 'Controller-only value' }, actor: alpha.actor!, reason: 'Install separate BMS controller' })
    await converge()
    return { vehicle, battery, controller }
  }
  const edit = (index: number, id: string, fields: Fields, archived?: boolean) => {
    const client = clients[index], current = client.business.get(id)
    return client.business.write({ id, kind: current.kind, vehicleId: current.vehicleId, data: { ...current.data, ...fields }, version: current.version, actor: client.actor!, reason: 'Update test HV battery', ...(archived === undefined ? {} : { archived }) })
  }
  const close = async () => {
    for (const client of clients) client.store.db.close()
    await fs.rm(directory, { recursive: true, force: true })
  }
  return { clients, shared, teamId: team.id, sync, converge, seed, edit, close }
}

test('HV battery identifiers and maturity synchronize separately from the BMS controller and vehicle data', async () => {
  const context = await fixture()
  try {
    const { vehicle, battery, controller } = await context.seed()
    for (const client of context.clients) {
      const batteries = activeHvBatteries(client.business.list(), vehicle.id)
      assert.deepEqual(batteries.map(record => record.id), [battery.id])
      assert.equal(batteries[0].data.productPart, '00001234')
      assert.equal(batteries[0].data.serial, '00005678')
      assert.equal(batteries[0].data.maturity, 'Prototype')
      assert.equal(client.business.get(controller.id).data.name, 'BMS/MSB')
    }
    context.edit(1, battery.id, { maturity: '  Design validation  ' })
    await context.converge()
    for (const client of context.clients) {
      assert.equal(activeHvBatteries(client.business.list(), vehicle.id)[0].data.maturity, 'Design validation')
      assert.deepEqual(client.business.get(vehicle.id).data, vehicle.data)
      assert.equal(client.business.get(vehicle.id).version, vehicle.version)
      assert.equal(client.business.get(controller.id).data.maturity, 'Controller-only value')
      assert.equal(client.business.get(controller.id).data.productPart, 'BMS-0001')
      assert.equal(client.business.get(controller.id).data.serial, 'BMS-0002')
      assert.ok(client.business.history(vehicle.id).some(change => change.recordId === battery.id && change.after.maturity === 'Design validation'))
    }
    context.edit(1, battery.id, { maturity: '', serial: '' })
    await context.converge()
    for (const client of context.clients) {
      const active = activeHvBatteries(client.business.list(), vehicle.id)
      assert.equal(active[0].data.maturity, '')
      assert.equal(active[0].data.serial, '')
      assert.equal(active[0].data.productPart, '00001234')
    }
  } finally { await context.close() }
})

for (const order of [[0, 1], [1, 0]]) {
  test(`unrelated HV battery serial and maturity edits merge in sync order ${order.join(',')}`, async () => {
    const context = await fixture()
    try {
      const { vehicle, battery, controller } = await context.seed()
      context.edit(0, battery.id, { serial: '00009999' })
      context.edit(1, battery.id, { maturity: 'Production validation' })
      for (const index of order) assert.equal((await context.sync(index)).phase, 'ready')
      await context.converge()
      for (const client of context.clients) {
        const active = activeHvBatteries(client.business.list(), vehicle.id)
        assert.deepEqual(active.map(record => record.id), [battery.id])
        assert.equal(active[0].data.productPart, '00001234')
        assert.equal(active[0].data.serial, '00009999')
        assert.equal(active[0].data.maturity, 'Production validation')
        assert.deepEqual(client.business.get(vehicle.id).data, vehicle.data)
        assert.equal(client.business.get(vehicle.id).version, vehicle.version)
        assert.equal(client.business.get(controller.id).data.serial, 'BMS-0002')
      }
    } finally { await context.close() }
  })
}

for (const choice of ['local', 'shared']) {
  test(`competing HV battery maturity changes conflict and resolve to ${choice}`, async () => {
    const context = await fixture()
    try {
      const { vehicle, battery, controller } = await context.seed()
      context.edit(0, battery.id, { maturity: 'Shared maturity' })
      context.edit(1, battery.id, { maturity: 'Local maturity' })
      await context.sync(0)
      const state = await context.sync(1), conflict = state.conflicts[0], beta = context.clients[1]
      assert.equal(state.phase, 'conflict')
      assert.equal(state.conflicts.length, 1)
      assert.equal(conflict.recordId, battery.id)
      assert.deepEqual(conflict.fields, ['maturity'])
      assert.equal((await beta.sync.resolve(context.shared, context.teamId, beta.identity, beta.actor!, battery.id, conflict.token, { maturity: choice }, 'Confirm actual battery maturity')).phase, 'ready')
      await context.converge()
      for (const client of context.clients) {
        assert.equal(activeHvBatteries(client.business.list(), vehicle.id)[0].data.maturity, choice === 'local' ? 'Local maturity' : 'Shared maturity')
        assert.deepEqual(client.business.get(vehicle.id).data, vehicle.data)
        assert.equal(client.business.get(vehicle.id).version, vehicle.version)
        assert.equal(client.business.get(controller.id).data.maturity, 'Controller-only value')
      }
    } finally { await context.close() }
  })
}

test('synchronized archived or removed HV batteries do not supply an active vehicle maturity', async () => {
  const context = await fixture()
  try {
    const { vehicle, battery } = await context.seed()
    context.edit(0, battery.id, { removedAt: '2026-10-20' })
    await context.converge()
    for (const client of context.clients) {
      assert.deepEqual(activeHvBatteries(client.business.list(), vehicle.id), [])
      assert.equal(client.business.get(battery.id).data.maturity, 'Prototype')
    }
    context.edit(1, battery.id, { removedAt: '' })
    await context.converge()
    for (const client of context.clients) assert.equal(activeHvBatteries(client.business.list(), vehicle.id)[0].id, battery.id)
    context.edit(0, battery.id, {}, true)
    await context.converge()
    for (const client of context.clients) {
      assert.deepEqual(activeHvBatteries(client.business.list(), vehicle.id), [])
      assert.equal(client.business.get(battery.id).archived, true)
      assert.equal(client.business.get(battery.id).data.maturity, 'Prototype')
    }
  } finally { await context.close() }
})
