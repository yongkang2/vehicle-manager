import { test } from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import unzipper from 'unzipper'
import { LocalStore } from '../server/store.js'
import { Business } from '../server/business.js'
import { BusinessSync } from '../server/sync.js'
import { TeamDirectory } from '../server/team.js'
import { createBackup, previewBackup, restoreBackup } from '../server/backup.js'
import { SharedBusinessSnapshot } from '../server/deletions.js'
import { applyRestore, restoreReceipts } from '../server/restore-operations.js'
import type { Actor, Fields } from '../shared/business.js'

async function fixture() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'restore-sync-integrity-')), shared = path.join(directory, 'shared')
  await fs.mkdir(shared)
  const teams = new TeamDirectory()
  const clients = ['source', 'target', 'observer'].map(name => {
    const store = new LocalStore(path.join(directory, name)), business = new Business(store)
    return { store, business, sync: new BusinessSync(business, teams), identity: { deviceId: store.deviceId, deviceName: name, localUserId: name, displayName: name }, actor: null as Actor | null }
  })
  const team = await teams.create(shared, 'Fictional recovery team', clients[0].identity)
  for (const client of clients.slice(1)) {
    const pending = await teams.join(shared, team.id, client.identity)
    await teams.approve(shared, team.id, clients[0].identity, pending.requests.find(request => request.status === 'pending')!.id, 'admin', null, 'Approve synthetic recovery test')
  }
  const roster = await teams.read(shared, team.id)
  for (const client of clients) client.actor = { id: roster.bindings.find(binding => binding.deviceId === client.store.deviceId)!.memberId, name: client.identity.displayName, deviceId: client.store.deviceId, role: 'admin' }
  const sync = (index: number) => clients[index].sync.synchronize(shared, team.id, clients[index].identity)
  const vehicle = clients[0].business.write({ kind: 'vehicle', data: { vin: 'TEST0000000000001', status: 'available', notes: '' }, actor: clients[0].actor!, photoAttachmentId: '', reason: 'Register fictional recovery vehicle' })
  for (let index = 0; index < clients.length; index++) assert.equal((await sync(index)).phase, 'ready')
  const edit = (index: number, fields: Fields) => {
    const client = clients[index], current = client.business.get(vehicle.id)
    return client.business.write({ ...current, data: { ...current.data, ...fields }, actor: client.actor!, reason: 'Synthetic recovery edit', maintenance: 'restore' })
  }
  const close = async () => { for (const client of clients) client.store.db.close(); await fs.rm(directory, { recursive: true, force: true }) }
  return { clients, teams, team, shared, vehicle, sync, edit, close }
}

test('restored legacy field removal survives synchronization to another client', async () => {
  const f = await fixture()
  try {
    const backup = await createBackup(f.clients[0].business, f.team.id)
    f.edit(0, { coolingArchitecture: 'LEGACY VALUE' }); await f.sync(0); await f.sync(1)
    await restoreBackup(f.clients[0].business, backup, f.team.id, f.clients[0].actor!, 'Restore original field set')
    assert.equal(f.clients[0].business.get(f.vehicle.id).data.coolingArchitecture, undefined)
    assert.equal((await f.sync(0)).phase, 'ready'); await f.sync(1)
    for (const client of f.clients.slice(0, 2)) assert.equal(client.business.get(f.vehicle.id).data.coolingArchitecture, undefined)
  } finally { await f.close() }
})

for (const choice of ['local', 'shared']) test(`restored field removal conflicts with concurrent edits and respects ${choice} resolution`, async () => {
  const f = await fixture()
  try {
    const backup = await createBackup(f.clients[0].business, f.team.id)
    f.edit(0, { coolingArchitecture: 'LEGACY VALUE' }); await f.sync(0); await f.sync(1)
    await restoreBackup(f.clients[0].business, backup, f.team.id, f.clients[0].actor!, 'Remove legacy value')
    f.edit(1, { coolingArchitecture: 'REMOTE VALUE' }); await f.sync(1)
    const result = await f.sync(0), conflict = result.conflicts[0]
    assert.deepEqual(conflict?.fields, ['coolingArchitecture'])
    const resolved = await f.clients[0].sync.resolve(f.shared, f.team.id, f.clients[0].identity, f.clients[0].actor!, f.vehicle.id, conflict.token, { coolingArchitecture: choice }, 'Choose recovered or shared value')
    assert.equal(resolved.phase, 'ready'); await f.sync(2)
    assert.equal(f.clients[2].business.get(f.vehicle.id).data.coolingArchitecture, choice === 'local' ? undefined : 'REMOTE VALUE')
  } finally { await f.close() }
})

test('history-only restore publishes original changes without changing current data or duplicating history', async () => {
  const f = await fixture()
  try {
    f.edit(0, { notes: 'Temporary offline note' }); f.edit(0, { notes: '' })
    const source = f.clients[0].business.history(f.vehicle.id), backup = await createBackup(f.clients[0].business, f.team.id)
    assert.deepEqual(f.clients[0].business.get(f.vehicle.id).data, f.clients[1].business.get(f.vehicle.id).data)
    const result = await restoreBackup(f.clients[1].business, backup, f.team.id, f.clients[1].actor!, 'Recover offline edit trail')
    assert.equal(result.changed, 0)
    assert.ok(f.clients[1].sync.status().pending > 0)
    assert.equal((await f.sync(1)).pending, 0); await f.sync(2)
    for (const change of source) assert.deepEqual(f.clients[2].business.history(f.vehicle.id).find(entry => entry.id === change.id), change)
    await f.sync(1); await f.sync(2)
    assert.equal(f.clients[2].business.history(f.vehicle.id).length, source.length)
    assert.equal(f.clients[2].business.get(f.vehicle.id).data.notes, '')
  } finally { await f.close() }
})

for (const failure of ['before-publication', 'after-publication']) test(`recovered history remains durable across ${failure} failure and restart`, async context => {
  const f = await fixture()
  try {
    f.edit(0, { notes: 'Offline work' }); f.edit(0, { notes: '' })
    const source = f.clients[0].business.history(f.vehicle.id), target = f.clients[1], bytes = await createBackup(f.clients[0].business, f.team.id)
    const preview = await previewBackup(target.business, bytes, f.team.id)
    const request = { requestId: randomUUID(), bytes, teamId: f.team.id, actor: target.actor!, reason: 'Recover offline audit history', archiveRecordIds: [], previewFingerprint: preview.fingerprint, confirmDroppedFields: false }
    const receipt = await applyRestore(target.business, request)
    assert.equal(receipt.state, 'applied'); assert.equal(receipt.result?.changed, 0)
    assert.deepEqual(await applyRestore(target.business, request), receipt)
    await assert.rejects(restoreBackup(target.business, bytes, f.team.id, target.actor!, 'Do not replace a pending recovery'), { code: 'PENDING_BEFORE_RESTORE' })
    const archive = await unzipper.Open.buffer(await createBackup(target.business, f.team.id))
    assert.equal(JSON.parse((await archive.files.find(file => file.path === 'manifest.json')!.buffer()).toString()).source.pending, 1)
    const original = SharedBusinessSnapshot.prototype.publish
    const publication = context.mock.method(SharedBusinessSnapshot.prototype, 'publish', async function (this: SharedBusinessSnapshot, ...args: Parameters<typeof original>) {
      if (failure === 'after-publication') await original.apply(this, args)
      throw new Error('Simulated shared storage interruption')
    })
    assert.equal((await f.sync(1)).phase, 'offline')
    assert.equal(target.sync.status().pending, 1)
    assert.equal(restoreReceipts(target.business)[0].state, 'applied')
    publication.mock.restore()
    const directory = target.store.directory
    target.store.db.close(); target.store = new LocalStore(directory); target.business = new Business(target.store); target.sync = new BusinessSync(target.business, f.teams)
    assert.equal(target.sync.status().pending, 1)
    assert.equal((await f.sync(1)).pending, 0); await f.sync(2)
    for (const change of source) assert.deepEqual(f.clients[2].business.history(f.vehicle.id).find(entry => entry.id === change.id), change)
    assert.equal(f.clients[2].business.history(f.vehicle.id).length, source.length)
    assert.deepEqual(target.store.get('pendingHistoryImports'), [])
  } finally { context.mock.restoreAll(); await f.close() }
})

test('restored history publication requires the restoring administrator to retain administrator permission', async () => {
  const f = await fixture()
  try {
    f.edit(0, { notes: 'Unpublished note' }); f.edit(0, { notes: '' })
    const bytes = await createBackup(f.clients[0].business, f.team.id), target = f.clients[1]
    await restoreBackup(target.business, bytes, f.team.id, target.actor!, 'Recover administrator history')
    await f.teams.changeMember(f.shared, f.team.id, f.clients[0].identity, target.actor!.id, 'member', true, 'Downgrade before publication')
    const state = await f.sync(1)
    assert.equal(state.error, 'ADMIN_REQUIRED'); assert.equal(state.pending, 1)
    await f.sync(2)
    assert.equal(f.clients[2].business.history(f.vehicle.id).length, 1)
    await f.teams.changeMember(f.shared, f.team.id, f.clients[0].identity, target.actor!.id, 'admin', true, 'Restore publication permission')
    assert.equal((await f.sync(1)).pending, 0); await f.sync(2)
    assert.equal(f.clients[2].business.history(f.vehicle.id).length, 3)
  } finally { await f.close() }
})
