import { test } from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import unzipper from 'unzipper'
import { ZipArchive } from 'archiver'
import { LocalStore } from '../server/store.js'
import { Business } from '../server/business.js'
import { createBackup, previewBackup } from '../server/backup.js'
import { applyRestore, restoreReceipts } from '../server/restore-operations.js'
import type { Actor } from '../shared/business.js'

async function fixture() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'vehicle-recovery-'))
  const store = new LocalStore(directory), business = new Business(store)
  const actor: Actor = { id: 'admin', name: 'Administrator', role: 'admin', deviceId: store.deviceId }
  const vehicle = business.write({ kind: 'vehicle', data: { vin: 'TEST0000000000001', status: 'available', owner: 'Before' }, actor, reason: 'Create vehicle' })
  store.db.exec("UPDATE outbox SET state='sent'")
  return { directory, store, business, actor, vehicle, close: async () => { store.db.close(); await fs.rm(directory, { recursive: true, force: true }) } }
}

test('preview rejects an attachment whose original is absent, without changing data', async () => {
  const f = await fixture()
  try {
    const manifest = { application: 'stellantis-vehicle-manager', format: 1, teamId: 'team', created: new Date().toISOString(), changes: [], records: [f.vehicle, { id: randomUUID(), kind: 'attachment', vehicleId: f.vehicle.id, archived: false, data: { checksum: 'a'.repeat(64), size: 4 } }] }
    const archive = new ZipArchive(), chunks: Buffer[] = []
    const done = new Promise<Buffer>((resolve, reject) => { archive.on('data', chunk => chunks.push(Buffer.from(chunk))); archive.on('end', () => resolve(Buffer.concat(chunks))); archive.on('error', reject) })
    archive.append(JSON.stringify(manifest), { name: 'manifest.json' }); void archive.finalize()
    await assert.rejects(previewBackup(f.business, await done, 'team'), { code: 'INVALID_BACKUP' })
    assert.equal(f.business.list().length, 1)
  } finally { await f.close() }
})

test('preview exposes metadata and field effects without applying them', async () => {
  const f = await fixture()
  try {
    const bytes = await createBackup(f.business, 'team')
    f.business.write({ ...f.vehicle, data: { ...f.vehicle.data, owner: 'After' }, actor: f.actor, reason: 'Update owner' })
    f.store.db.exec("UPDATE outbox SET state='sent'")
    const preview = await previewBackup(f.business, bytes, 'team')
    assert.equal(preview.teamId, 'team')
    assert.ok(preview.created)
    assert.equal(preview.effects.find(effect => effect.id === f.vehicle.id)?.fields.find(field => field.key === 'owner')?.before, 'After')
    assert.equal(f.business.get(f.vehicle.id).data.owner, 'After')
  } finally { await f.close() }
})

test('restore saves a verified safety copy and durable receipt; retry never reapplies business changes', async () => {
  const f = await fixture()
  try {
    const bytes = await createBackup(f.business, 'team')
    f.business.write({ ...f.vehicle, data: { ...f.vehicle.data, owner: 'After' }, actor: f.actor, reason: 'Update owner' })
    f.store.db.exec("UPDATE outbox SET state='sent'")
    const preview = await previewBackup(f.business, bytes, 'team'), requestId = randomUUID()
    const request = { requestId, bytes, teamId: 'team', actor: f.actor, reason: 'Recover owner', archiveRecordIds: [], previewFingerprint: preview.fingerprint, confirmDroppedFields: false }
    const receipt = await applyRestore(f.business, request)
    assert.equal(receipt.state, 'applied')
    assert.equal(f.business.get(f.vehicle.id).data.owner, 'Before')
    const safety = await fs.readFile(path.join(f.directory, 'restore-backups', receipt.safetyFile!))
    assert.ok((await previewBackup(f.business, safety, 'team', false)).effects.some(effect => effect.fields.some(field => field.after === 'After')))
    const count = f.business.history().length
    assert.deepEqual(await applyRestore(f.business, request), receipt)
    assert.equal(f.business.history().length, count)
    assert.equal(restoreReceipts(f.business)[0].requestId, requestId)
    await assert.rejects(applyRestore(f.business, { ...request, reason: 'Different request' }), { code: 'RESTORE_REQUEST_CHANGED' })
  } finally { await f.close() }
})

for (const failure of ['permissions', 'safety-write', 'stale-preview']) test(`restore prevents business writes after ${failure}`, async () => {
  const f = await fixture()
  try {
    const bytes = await createBackup(f.business, 'team'), preview = await previewBackup(f.business, bytes, 'team')
    if (failure === 'safety-write') await fs.writeFile(path.join(f.directory, 'restore-backups'), 'Block directory creation')
    if (failure === 'stale-preview') {
      f.business.write({ ...f.vehicle, data: { ...f.vehicle.data, owner: 'Newer' }, actor: f.actor, reason: 'Invalidate preview' })
      f.store.db.exec("UPDATE outbox SET state='sent'")
    }
    const before = JSON.stringify(f.business.list()), history = f.business.history().length
    await assert.rejects(applyRestore(f.business, { requestId: randomUUID(), bytes, teamId: 'team', actor: { ...f.actor, role: failure === 'permissions' ? 'member' : 'admin' }, reason: 'Recovery safety test', archiveRecordIds: [], previewFingerprint: preview.fingerprint, confirmDroppedFields: false }))
    assert.equal(JSON.stringify(f.business.list()), before)
    assert.equal(f.business.history().length, history)
    if (failure === 'safety-write') assert.equal(restoreReceipts(f.business)[0].state, 'failed')
  } finally { await f.close() }
})

for (const field of ['created', 'source']) test(`preview rejects malformed ${field} metadata without exposing unsafe UI values`, async () => {
  const f = await fixture()
  try {
    const input = await unzipper.Open.buffer(await createBackup(f.business, 'team'))
    const manifest = JSON.parse((await input.files.find(file => file.path === 'manifest.json')!.buffer()).toString())
    manifest[field] = field === 'created' ? { invalid: true } : { revision: { invalid: true }, pending: 0, conflicts: 0 }
    const archive = new ZipArchive(), chunks: Buffer[] = []
    const done = new Promise<Buffer>((resolve, reject) => { archive.on('data', chunk => chunks.push(Buffer.from(chunk))); archive.on('end', () => resolve(Buffer.concat(chunks))); archive.on('error', reject) })
    archive.append(JSON.stringify(manifest), { name: 'manifest.json' }); void archive.finalize()
    await assert.rejects(previewBackup(f.business, await done, 'team'), { code: 'INVALID_BACKUP' })
  } finally { await f.close() }
})
