import { test } from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { pathToFileURL } from 'node:url'
import { LocalStore } from '../server/store.js'
import { Business } from '../server/business.js'
import { BusinessSync } from '../server/sync.js'
import { TeamDirectory } from '../server/team.js'
import type { Actor } from '../shared/business.js'

test('approved clients sync records, parts and history, merge fields and retain offline changes', async () => {
  const root = await fs.mkdtemp(path.join(import.meta.dirname, 'test-data-')), shared = path.join(root, 'shared')
  await fs.mkdir(shared)
  const teams = new TeamDirectory()
  const clients = ['alpha', 'beta'].map(name => {
    const store = new LocalStore(path.join(root, name)), business = new Business(store)
    return { store, business, sync: new BusinessSync(business, teams), identity: { deviceId: store.deviceId, deviceName: name, localUserId: name, displayName: name } }
  })
  try {
    const [alpha, beta] = clients
    const team = await teams.create(shared, 'Test', alpha.identity)
    const pending = await teams.join(shared, team.id, beta.identity)
    const approved = await teams.approve(shared, team.id, alpha.identity, pending.requests[0].id, 'member', null, 'Verified')
    const actors = clients.map(client => ({ id: approved.bindings.find(binding => binding.deviceId === client.identity.deviceId)!.memberId, deviceId: client.store.deviceId, name: client.identity.displayName, role: client === alpha ? 'admin' : 'member' } as Actor))
    const car = alpha.business.write({ kind: 'vehicle', data: { name: 'Vehicle', vin: 'TEST0000000000001', status: 'available' }, actor: actors[0], reason: 'Register' })
    assert.equal((await alpha.sync.synchronize(shared, team.id, alpha.identity)).pending, 0)
    await beta.sync.synchronize(shared, team.id, beta.identity)
    assert.equal(beta.business.get(car.id).data.vin, car.data.vin)
    const part = beta.business.write({ kind: 'part', vehicleId: car.id, data: { name: 'EVCU', category: 'controller', serial: '0000123', software: '1.0' }, actor: actors[1], reason: 'Install' })
    await beta.sync.synchronize(shared, team.id, beta.identity); await alpha.sync.synchronize(shared, team.id, alpha.identity)
    assert.equal(alpha.business.get(part.id).data.serial, '0000123')
    const edit = (index: number, fields: Record<string, string>) => {
      const current = clients[index].business.get(car.id)
      clients[index].business.write({ id: car.id, kind: 'vehicle', data: { ...current.data, ...fields }, version: current.version, actor: actors[index], reason: 'Edit' })
    }
    edit(0, { owner: 'Alpha' }); edit(1, { notes: 'Beta' })
    await Promise.all(clients.map(client => client.sync.synchronize(shared, team.id, client.identity)))
    for (let round = 0; round < 2; round++) for (const client of clients) await client.sync.synchronize(shared, team.id, client.identity)
    for (const client of clients) { assert.equal(client.business.get(car.id).data.owner, 'Alpha'); assert.equal(client.business.get(car.id).data.notes, 'Beta') }
    edit(0, { owner: 'Shared' }); edit(1, { owner: 'Local' })
    await alpha.sync.synchronize(shared, team.id, alpha.identity)
    const result = await beta.sync.synchronize(shared, team.id, beta.identity)
    assert.deepEqual(result.conflicts[0].fields, ['owner'])
    await beta.sync.resolve(shared, team.id, beta.identity, actors[1], car.id, result.conflicts[0].token, { owner: 'shared' }, 'Confirmed shared value')
    assert.equal(beta.business.get(car.id).data.owner, 'Shared')
    await fs.rename(shared, `${shared}-offline`)
    edit(1, { notes: 'Offline' })
    assert.equal((await beta.sync.synchronize(shared, team.id, beta.identity)).phase, 'offline')
    assert.equal(beta.sync.status().pending, 1)
    await fs.rename(`${shared}-offline`, shared)
    assert.equal((await beta.sync.synchronize(shared, team.id, beta.identity)).pending, 0)
    await alpha.sync.synchronize(shared, team.id, alpha.identity)
    assert.equal(alpha.business.get(car.id).data.notes, 'Offline')
    const count = alpha.business.history(car.id).length
    await alpha.sync.synchronize(shared, team.id, alpha.identity)
    assert.equal(alpha.business.history(car.id).length, count)
    const duplicateData = { name: 'Concurrent new car', vin: 'TEST0000000000003', status: 'available' }
    alpha.business.write({ kind: 'vehicle', data: duplicateData, actor: actors[0], reason: 'Offline registration A' })
    const duplicate = beta.business.write({ kind: 'vehicle', data: duplicateData, actor: actors[1], reason: 'Offline registration B' })
    await alpha.sync.synchronize(shared, team.id, alpha.identity)
    const duplicateState = await beta.sync.synchronize(shared, team.id, beta.identity)
    assert.ok(duplicateState.conflicts[0].fields.includes('_vin'))
    await beta.sync.resolve(shared, team.id, beta.identity, actors[1], duplicate.id, duplicateState.conflicts[0].token, { _vin: 'shared' }, 'Keep canonical shared vehicle')
    assert.equal(beta.business.get(duplicate.id).archived, true)
    assert.equal(beta.sync.status().pending, 0)
    edit(0, { color: 'Independent process A' }); edit(1, { notes: 'Independent process B' })
    const moduleUrl = (name: string) => JSON.stringify(pathToFileURL(path.join(import.meta.dirname, '..', 'server', `${name}.ts`)).href)
    const script = `import{LocalStore}from${moduleUrl('store')};import{Business}from${moduleUrl('business')};import{BusinessSync}from${moduleUrl('sync')};import{TeamDirectory}from${moduleUrl('team')};const store=new LocalStore(process.argv[1]);const sync=new BusinessSync(new Business(store),new TeamDirectory());console.log(JSON.stringify(await sync.synchronize(process.argv[2],process.argv[3],JSON.parse(process.argv[4]))));store.db.close();`
    const processes = await Promise.all(clients.map(client => promisify(execFile)(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script, client.store.directory, shared, team.id, JSON.stringify(client.identity)], { timeout: 20000 })))
    for (const result of processes) assert.ok(['ready', 'busy'].includes(JSON.parse(result.stdout).phase))
    for (let round = 0; round < 2; round++) for (const client of clients) await client.sync.synchronize(shared, team.id, client.identity)
    for (const client of clients) { assert.equal(client.business.get(car.id).data.color, 'Independent process A'); assert.equal(client.business.get(car.id).data.notes, 'Independent process B') }
    const oldHead = await fs.readFile(path.join(shared, 'business', 'HEAD.json'))
    edit(1, { color: 'Blue' }); await beta.sync.synchronize(shared, team.id, beta.identity)
    await fs.writeFile(path.join(shared, 'business', 'HEAD.json'), oldHead)
    assert.equal((await beta.sync.synchronize(shared, team.id, beta.identity)).error, 'BUSINESS_ROLLBACK')
  } finally { for (const client of clients) client.store.db.close(); await fs.rm(root, { recursive: true, force: true }) }
})