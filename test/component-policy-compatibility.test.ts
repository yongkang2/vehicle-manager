import { test } from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { ZipArchive } from 'archiver'
import unzipper from 'unzipper'
import { Business, checksum } from '../server/business.js'
import { LocalStore } from '../server/store.js'
import { BusinessSync, atomicFile } from '../server/sync.js'
import { TeamDirectory } from '../server/team.js'
import { ConfigurationRevisions } from '../server/configuration-revisions.js'
import { SharedBusinessSnapshot } from '../server/deletions.js'
import { createBackup, previewBackup, restoreBackup } from '../server/backup.js'
import type { PendingConfigurationImport } from '../server/backup.js'
import type { Actor, BusinessRecord } from '../shared/business.js'
import { configurationDecisionKey, configurationRevisionSummaries } from '../shared/configuration-revisions.js'
import type { ConfigurationDecisions, ConfigurationPreview } from '../shared/configuration-revisions.js'

type Manifest = { format: number; fieldVersion: number; schemaVersion: number; records: BusinessRecord[] }
async function manifest(bytes: Buffer): Promise<Manifest> {
  const zip = await unzipper.Open.buffer(bytes)
  return JSON.parse((await zip.files.find(file => file.path === 'manifest.json')!.buffer()).toString()) as Manifest
}
async function rewrite(bytes: Buffer, mutate: (value: Manifest) => void): Promise<Buffer> {
  const zip = await unzipper.Open.buffer(bytes), archive = new ZipArchive(), chunks: Buffer[] = []
  const done = new Promise<Buffer>((resolve, reject) => { archive.on('data', chunk => chunks.push(Buffer.from(chunk))); archive.once('error', reject); archive.once('end', () => resolve(Buffer.concat(chunks))) })
  for (const file of zip.files) {
    const content = await file.buffer()
    if (file.path === 'manifest.json') { const value = JSON.parse(content.toString()) as Manifest; mutate(value); archive.append(JSON.stringify(value), { name: file.path }) }
    else archive.append(content, { name: file.path })
  }
  void archive.finalize(); return done
}
function decisions(preview: ConfigurationPreview): ConfigurationDecisions {
  const result: ConfigurationDecisions = { fields: {}, sections: {} }
  for (const section of preview.sections) {
    if (!section.components.length) result.sections[section.typeId] = { state: 'notInstalled', reason: 'Not installed on fictional sample' }
    for (const component of section.components) for (const field of component.fields) if (field.required && !field.value.trim()) result.fields[configurationDecisionKey(component.id, field.id)] = { state: 'unknown', reason: 'Fictional supplier identifier unavailable' }
  }
  return result
}
async function fixture() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'vm-policy-compatibility-')), shared = path.join(directory, 'shared')
  await fs.mkdir(shared)
  const clients = ['admin', 'member'].map(name => {
    const store = new LocalStore(path.join(directory, name)), business = new Business(store), teams = new TeamDirectory(), sync = new BusinessSync(business, teams)
    const identity = { deviceId: store.deviceId, deviceName: name, localUserId: name, displayName: name }
    return { store, business, teams, sync, identity, revisions: new ConfigurationRevisions(business, sync), actor: null as Actor | null }
  })
  const [admin, member] = clients, team = await admin.teams.create(shared, 'Fictional policy compatibility team', admin.identity)
  const request = await member.teams.join(shared, team.id, member.identity)
  const approved = await admin.teams.approve(shared, team.id, admin.identity, request.requests[0].id, 'member', null, 'Approve fictional tester')
  for (const client of clients) {
    const found = approved.members.find(row => row.id === approved.bindings.find(binding => binding.deviceId === client.identity.deviceId)!.memberId)!
    client.actor = { id: found.id, name: found.name, role: found.role, deviceId: client.identity.deviceId }
  }
  const context = (index = 0) => ({ directory: shared, teamId: team.id, identity: clients[index].identity, actor: clients[index].actor!, syncEnabled: true })
  const synchronize = async (index = 0) => { const state = await clients[index].sync.synchronize(shared, team.id, clients[index].identity); assert.equal(state.phase, 'ready', state.error || 'sync failed'); return state }
  await admin.revisions.enable(context()); await synchronize(1)
  const car = admin.business.write({ kind: 'vehicle', data: { vin: 'TEST0000000000001', name: 'Fictional policy sample', status: 'available' }, actor: admin.actor!, reason: 'Register fictional sample' })
  await synchronize(); await synchronize(1)
  const policy = async (id: string, reviewState: 'active' | 'disabled' | 'removed') => {
    const type = admin.revisions.catalog().types.find(row => row.id === id)!
    return admin.revisions.updateType(context(), id, { version: type.version, name: type.name, description: type.description, reviewState, requestId: randomUUID(), reason: `Set fictional review policy to ${reviewState}` })
  }
  const publish = async () => {
    const preview = await admin.revisions.preview(context(), car.id)
    return admin.revisions.publish(context(), car.id, { previewToken: preview.token, requestId: randomUUID(), title: '', summary: 'Publish fictional policy scope', decisions: decisions(preview) })
  }
  const headPath = path.join(shared, 'business', 'HEAD.json'), head = async () => JSON.parse(await fs.readFile(headPath, 'utf8')) as { protocol: number; revision: string; sequence: number; checksum: string }
  return { directory, shared, clients, admin, member, team, car, context, synchronize, policy, publish, headPath, head, close: async () => { for (const client of clients) { await client.sync.settle(); client.store.db.close() }; await fs.rm(directory, { recursive: true, force: true }) } }
}

test('protocol4 keeps disabled and removed custom components writable and merges offline pending records', async () => {
  const f = await fixture()
  try {
    const type = await f.admin.revisions.createType(f.context(), { name: 'Gearbox' }); await f.synchronize(1)
    const data = { name: 'Front gearbox', category: 'component', componentTypeId: type.id, productPart: 'GB-001', serial: '000123', maturity: 'POC' }
    const queued = f.member.business.write({ kind: 'part', vehicleId: f.car.id, data, actor: f.member.actor!, reason: 'Record offline fictional gearbox' })
    await f.policy(type.id, 'removed'); assert.equal((await f.head()).protocol, 4)
    await f.synchronize(1); assert.equal(f.member.business.get(queued.id).data.serial, '000123')
    const added = f.member.business.write({ kind: 'part', vehicleId: f.car.id, data: { ...data, name: 'Rear gearbox', serial: '000124' }, actor: f.member.actor!, reason: 'Record installed gearbox outside revision scope' })
    await f.synchronize(1); await f.synchronize()
    assert.equal(f.admin.business.get(added.id).data.componentTypeId, type.id)
    assert(!((await f.admin.revisions.preview(f.context(), f.car.id)).sections.some(section => section.typeId === type.id)))
  } finally { await f.close() }
})

test('deletion and ordinary synchronization retain protocol4 and permanent markers', async () => {
  const f = await fixture()
  try {
    await f.policy('emotor', 'disabled'); const revision = await f.publish()
    const current = f.admin.business.get(f.car.id)
    f.admin.business.write({ id: current.id, kind: 'vehicle', data: current.data, version: current.version, archived: true, actor: f.admin.actor!, reason: 'Archive fictional sample' })
    await f.synchronize()
    const preview = await f.admin.sync.deletePreview(f.shared, f.team.id, f.admin.identity, f.admin.actor!, current.id)
    const result = await f.admin.sync.deleteVehicle(f.shared, f.team.id, f.admin.identity, f.admin.actor!, current.id, { previewToken: preview.token, version: preview.version, vin: String(current.data.vin), confirmation: 'DELETE', reason: 'Delete fictional sample', requestId: randomUUID() })
    assert.equal(result.localSynced, true); assert.equal((await f.head()).protocol, 4)
    await f.synchronize(1); assert.equal((await f.head()).protocol, 4)
    assert.throws(() => f.member.business.get(current.id), { code: 'VEHICLE_DELETED' })
    assert(f.member.store.deletionRows()[0].recordIds.includes(revision.revisionId))
  } finally { await f.close() }
})

test('backup field3 preserves policies and mixed revision history without restoring old catalog decisions', async () => {
  const f = await fixture()
  try {
    const first = await f.publish(), legacy = await createBackup(f.admin.business, f.team.id)
    assert.equal((await manifest(legacy)).fieldVersion, 2)
    await f.policy('emotor', 'removed'); const second = await f.publish(), modern = await createBackup(f.admin.business, f.team.id)
    const content = await manifest(modern)
    assert.equal(content.format, 4); assert.equal(content.schemaVersion, 5); assert.equal(content.fieldVersion, 3)
    assert.equal(content.records.find(row => row.id === 'emotor')!.data.reviewState, 'removed')
    assert.equal(content.records.find(row => row.id === first.revisionId)!.data.schema, 1)
    assert.equal(content.records.find(row => row.id === second.revisionId)!.data.schema, 2)
    const currentPolicy = structuredClone(f.admin.business.get('emotor').data)
    assert.deepEqual((await previewBackup(f.admin.business, legacy, f.team.id)).conflicts, [])
    await restoreBackup(f.admin.business, legacy, f.team.id, f.admin.actor!, 'Restore old fictional working data')
    assert.deepEqual(f.admin.business.get('emotor').data, currentPolicy)
    assert.equal(configurationRevisionSummaries(f.admin.business.list())[0].label, 'R02')
    const invalid = await rewrite(modern, value => { value.fieldVersion = 2 })
    await assert.rejects(previewBackup(f.admin.business, invalid, f.team.id), { code: 'INVALID_BACKUP' })
    await assert.rejects(restoreBackup(f.admin.business, invalid, f.team.id, f.admin.actor!, 'Reject incompatible field metadata'), { code: 'INVALID_BACKUP' })
  } finally { await f.close() }
})

test('field3 restore queues complete history, respects implicit built-in defaults and requires explicit policy activation', async () => {
  const f = await fixture(), targetDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'vm-policy-restore-')), store = new LocalStore(targetDirectory), business = new Business(store)
  try {
    await f.publish(); await f.policy('emotor', 'removed'); await f.publish()
    const bytes = await createBackup(f.admin.business, f.team.id)
    store.set('businessProtocol', 3)
    const before = JSON.stringify(business.list())
    await assert.rejects(restoreBackup(business, bytes, f.team.id, f.admin.actor!, 'Require explicit administrator policy activation'), { code: 'CONFIGURATION_POLICY_NOT_ENABLED' })
    assert.equal(JSON.stringify(business.list()), before); assert.equal(store.get('pendingConfigurationImports'), null)
    store.set('businessProtocol', 4)
    await restoreBackup(business, bytes, f.team.id, f.admin.actor!, 'Restore fictional history without changing current policy')
    const imports = store.get<PendingConfigurationImport[]>('pendingConfigurationImports')!
    assert.equal(imports[0].records.filter(row => row.kind === 'configurationRevision').length, 2)
    assert(!imports[0].records.some(row => row.id === 'emotor'), 'Implicit current Active must not become Removed from a historical backup')
    const roundtrip = await manifest(await createBackup(business, f.team.id))
    assert.equal(roundtrip.fieldVersion, 3)
    assert.equal(roundtrip.records.filter(row => row.kind === 'configurationRevision').length, 2)
  } finally { store.db.close(); await fs.rm(targetDirectory, { recursive: true, force: true }); await f.close() }
})

test('schema2 cannot be smuggled into a protocol3 snapshot', async () => {
  const f = await fixture()
  try {
    await f.policy('emotor', 'removed')
    const head = await f.head(), snapshotFile = path.join(f.shared, 'business', 'snapshots', `${head.revision}.sqlite`)
    const local = new DatabaseSync(snapshotFile)
    local.prepare("UPDATE metadata SET value='3' WHERE key='protocol'").run(); local.close()
    head.protocol = 3; head.checksum = checksum(await fs.readFile(snapshotFile))
    await fs.writeFile(f.headPath, JSON.stringify(head))
    f.member.store.set('businessProtocol', 3)
    await assert.rejects(SharedBusinessSnapshot.open(f.member.business, f.shared, f.team.id, atomicFile), { code: 'SHARE_CORRUPTED' })
    assert.deepEqual(await f.head(), head)
  } finally { await f.close() }
})

test('pending restore metadata cannot silently upgrade a protocol3 team', async () => {
  const f = await fixture()
  try {
    const head = await f.head(), id = randomUUID()
    f.admin.store.set('pendingConfigurationImports', [{ id, actor: f.admin.actor!, reason: 'Attempt an unactivated policy restore', receipts: [], records: [{ id: 'emotor', kind: 'componentType', vehicleId: null, archived: false, version: 1, updated: new Date().toISOString(), data: { schema: 2, name: 'eMotor', description: '', definitionVersion: 1, reviewState: 'removed' } }] }])
    const result = await f.admin.sync.synchronize(f.shared, f.team.id, f.admin.identity)
    assert.equal(result.error, 'CONFIGURATION_POLICY_NOT_ENABLED'); assert.deepEqual(await f.head(), head)
    assert.equal(f.admin.store.get<PendingConfigurationImport[]>('pendingConfigurationImports')![0].id, id)
    assert.equal(f.admin.business.list().some(row => row.id === 'emotor'), false)
  } finally { await f.close() }
})
