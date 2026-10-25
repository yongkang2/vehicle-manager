import { test } from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { deflateSync } from 'node:zlib'
import { Business, checksum, normalizeFields } from '../server/business.js'
import { VehiclePhotos } from '../server/vehicle-photos.js'
import { LocalStore } from '../server/store.js'
import { AppError } from '../server/team.js'
import { vehicleFields } from '../shared/business.js'
import type { Actor, BusinessRecord, VehicleDeletion } from '../shared/business.js'
import { inspectVehiclePhoto, parsePhotoAttachmentId, PHOTO_MAX_BYTES, PHOTO_MAX_DIMENSION, PHOTO_MAX_PIXELS } from '../shared/vehicle-photo.js'

function pngChunk(type: string, data: Buffer): Buffer {
  const bytes = Buffer.concat([Buffer.from(type), data]), header = Buffer.alloc(4), trailer = Buffer.alloc(4)
  let crc = 0xffffffff
  for (const byte of bytes) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1 }
  header.writeUInt32BE(data.length); trailer.writeUInt32BE((crc ^ 0xffffffff) >>> 0)
  return Buffer.concat([header, bytes, trailer])
}
function png(width = 1, height = 1): Buffer {
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 6
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), pngChunk('IHDR', header), pngChunk('IDAT', deflateSync(Buffer.from([0, 255, 0, 0, 255]))), pngChunk('IEND', Buffer.alloc(0))])
}
function jpeg(width = 1, height = 1): Buffer {
  const segment = (marker: number, data: Buffer) => { const prefix = Buffer.from([255, marker, 0, 0]); prefix.writeUInt16BE(data.length + 2, 2); return Buffer.concat([prefix, data]) }
  const frame = Buffer.from([8, 0, 0, 0, 0, 1, 1, 17, 0]); frame.writeUInt16BE(height, 1); frame.writeUInt16BE(width, 3)
  const codeLengths = Buffer.from([1, ...Array<number>(15).fill(0)])
  const huffman = Buffer.concat([Buffer.from([0]), codeLengths, Buffer.from([0, 16]), codeLengths, Buffer.from([0])])
  return Buffer.concat([Buffer.from([255, 216]), segment(219, Buffer.from([0, ...Array<number>(64).fill(1)])), segment(192, frame), segment(196, huffman), segment(218, Buffer.from([1, 1, 0, 0, 63, 0])), Buffer.from([63, 255, 217])])
}
const vin = 'TEST0000000000001'
async function fixture() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'vehicle-photos-')), store = new LocalStore(directory), business = new Business(store)
  const actor: Actor = { id: 'member', name: 'Photo tester', role: 'member', deviceId: store.deviceId }, admin: Actor = { ...actor, id: 'admin', role: 'admin' }
  const photos = new VehiclePhotos(business)
  const create = (registration = vin) => business.write({ kind: 'vehicle', data: { vin: registration, status: 'available' }, actor, reason: 'Register vehicle' })
  const edit = (vehicle: BusinessRecord, data = vehicle.data) => business.write({ id: vehicle.id, kind: 'vehicle', data, version: vehicle.version, actor, reason: 'Ordinary vehicle edit' })
  const count = (table: 'changes' | 'outbox') => Number(store.db.prepare(`SELECT COUNT(*) AS total FROM ${table}`).get()!.total)
  const close = async () => { store.db.close(); await fs.rm(directory, { recursive: true, force: true }) }
  return { directory, store, business, photos, actor, admin, create, edit, count, close }
}

test('photo IDs are bounded record identifiers, never paths, URLs or arbitrary values', () => {
  assert.equal(parsePhotoAttachmentId(undefined), '')
  assert.equal(parsePhotoAttachmentId(''), '')
  for (const value of [randomUUID(), 'photo-record_123', 'a'.repeat(120)]) assert.equal(parsePhotoAttachmentId(value), value)
  for (const value of [null, 1, [], {}, ' ', ' a', 'a ', 'a'.repeat(121), '../photo', '/etc/photo', 'C:\\photo', 'https://example.com/p.png', 'photo.png', 'photo\0id']) assert.equal(parsePhotoAttachmentId(value), null)
})

test('photo inspection recognizes PNG and JPEG dimensions within byte, dimension and pixel limits', () => {
  assert.equal(PHOTO_MAX_BYTES, 10 * 1024 * 1024)
  assert.equal(PHOTO_MAX_DIMENSION, 8192)
  assert.equal(PHOTO_MAX_PIXELS, 24_000_000)
  assert.deepEqual(inspectVehiclePhoto(png()), { mime: 'image/png', width: 1, height: 1 })
  assert.deepEqual(inspectVehiclePhoto(jpeg()), { mime: 'image/jpeg', width: 1, height: 1 })
  for (const make of [png, jpeg]) {
    assert.deepEqual(inspectVehiclePhoto(make(8192, 1))?.width, 8192)
    assert.deepEqual(inspectVehiclePhoto(make(6000, 4000))?.height, 4000)
    for (const [width, height] of [[0, 1], [1, 0], [8193, 1], [1, 8193], [6000, 4001]]) assert.equal(inspectVehiclePhoto(make(width, height)), null)
    const offset = Buffer.concat([Buffer.from('padding'), make(), Buffer.from('padding')]).subarray(7, -7)
    assert.equal(inspectVehiclePhoto(offset)?.width, 1)
  }
  assert.equal(inspectVehiclePhoto(Buffer.alloc(PHOTO_MAX_BYTES + 1)), null)
})

test('photo inspection rejects truncated, corrupt, animated or unsupported image structures without throwing', () => {
  for (const bytes of [Buffer.alloc(0), Buffer.from('<svg/>'), Buffer.from('GIF89a'), Buffer.from('RIFFWEBP'), png().subarray(0, 20), jpeg().subarray(0, 20), png().subarray(0, -1), jpeg().subarray(0, -1), Buffer.concat([png(), Buffer.from([0])]), Buffer.concat([jpeg(), Buffer.from([0])])]) assert.equal(inspectVehiclePhoto(bytes), null)
  const corruptCrc = Buffer.from(png()); corruptCrc[20] ^= 1
  assert.equal(inspectVehiclePhoto(corruptCrc), null)
  const truncatedSegment = Buffer.from(jpeg()); truncatedSegment.writeUInt16BE(65535, 4)
  assert.equal(inspectVehiclePhoto(truncatedSegment), null)
  const source = png(), animated = Buffer.concat([source.subarray(0, 33), pngChunk('acTL', Buffer.alloc(8)), source.subarray(33)])
  assert.equal(inspectVehiclePhoto(animated), null)
  const noImageData = Buffer.concat([source.subarray(0, 33), pngChunk('IEND', Buffer.alloc(0))])
  assert.equal(inspectVehiclePhoto(noImageData), null)
  // Every proper prefix is incomplete, including partial chunk/marker lengths.
  for (const bytes of [png(), jpeg()]) for (let length = 0; length < bytes.length; length++) assert.equal(inspectVehiclePhoto(bytes.subarray(0, length)), null)
})

test('members upload, replace and clear one cover while preserving immutable attachments, files, history and queues', async () => {
  const context = await fixture()
  try {
    const car = context.create()
    assert.equal(Object.hasOwn(car.data, 'photoAttachmentId'), false)
    assert.equal(vehicleFields.some(field => String(field) === 'photoAttachmentId'), false)
    const firstBytes = png(), first = await context.photos.upload(car.id, { name: '../演示照片.PNG', bytes: firstBytes }, car.version, '  Add vehicle photo  ', context.actor)
    assert.equal(first.vehicle.data.photoAttachmentId, first.attachment.id)
    assert.equal(first.attachment.data.name, '演示照片.PNG')
    assert.equal(first.attachment.data.purpose, 'vehiclePhoto')
    assert.equal(first.attachment.data.mime, 'image/png')
    assert.equal(first.attachment.data.width, 1)
    assert.equal(first.attachment.data.height, 1)
    assert.equal(first.attachment.data.checksum, checksum(firstBytes))
    assert.deepEqual(await context.photos.read(car.id), { bytes: firstBytes, mime: 'image/png', attachmentId: first.attachment.id })
    assert.equal(context.count('changes'), 3); assert.equal(context.count('outbox'), 3)
    const uploadChanges = context.business.history(car.id).filter(change => change.reason === 'Add vehicle photo')
    assert.equal(uploadChanges.length, 2)
    assert.equal(uploadChanges.find(change => change.kind === 'vehicle')!.after.photoAttachmentId, first.attachment.id)
    const queued = context.store.db.prepare('SELECT payload FROM outbox ORDER BY seq').all().map(row => JSON.parse(String(row.payload)))
    assert.deepEqual(queued.find(operation => operation.recordId === first.attachment.id).files, [checksum(firstBytes)])
    const next = await context.photos.upload(car.id, { name: 'replacement.jpeg', bytes: jpeg() }, first.vehicle.version, 'Replace cover', context.actor)
    assert.notEqual(next.attachment.id, first.attachment.id)
    assert.equal(context.business.list('attachment', car.id).length, 2)
    assert.equal(context.business.get(first.attachment.id).archived, false)
    assert.deepEqual(await context.business.readBlob(String(first.attachment.data.checksum)), firstBytes)
    const cleared = context.photos.remove(car.id, next.vehicle.version, 'Clear displayed cover', context.actor)
    assert.equal(cleared.data.photoAttachmentId, '')
    await assert.rejects(context.photos.read(car.id), { code: 'PHOTO_NOT_FOUND', status: 404 })
    assert.equal(context.business.list('attachment', car.id).length, 2)
    assert.deepEqual(await context.business.readBlob(String(next.attachment.data.checksum)), jpeg())
    assert.equal(context.business.get(next.attachment.id).archived, false)
    assert.equal(context.store.db.prepare('PRAGMA integrity_check').get()!.integrity_check, 'ok')
  } finally { await context.close() }
})

test('ordinary edits cannot forge or erase a managed photo; trusted restore explicitly restores or clears it', async () => {
  const context = await fixture()
  try {
    let car = context.business.write({ kind: 'vehicle', data: { vin, status: 'available', photoAttachmentId: 'forged-id' }, actor: context.actor, reason: 'Ignore raw create pointer' })
    assert.equal(Object.hasOwn(car.data, 'photoAttachmentId'), false)
    car = context.edit(car, { ...car.data, owner: 'Driver' })
    assert.equal(Object.hasOwn(car.data, 'photoAttachmentId'), false)
    const uploaded = await context.photos.upload(car.id, { name: 'cover.png', bytes: png() }, car.version, 'Choose cover', context.actor)
    car = context.edit(uploaded.vehicle, { ...uploaded.vehicle.data, owner: 'Updated driver', photoAttachmentId: { url: '/forged' } })
    assert.equal(car.data.photoAttachmentId, uploaded.attachment.id)
    const withoutPointer = { ...car.data }; delete withoutPointer.photoAttachmentId
    car = context.edit(car, withoutPointer)
    assert.equal(car.data.photoAttachmentId, uploaded.attachment.id)
    assert.equal(normalizeFields('vehicle', { ...withoutPointer, photoAttachmentId: uploaded.attachment.id }).photoAttachmentId, uploaded.attachment.id)
    assert.throws(() => normalizeFields('vehicle', { ...withoutPointer, photoAttachmentId: '/invalid' }), { code: 'INVALID_INPUT' })
    car = context.business.write({ id: car.id, kind: 'vehicle', data: withoutPointer, version: car.version, actor: context.admin, reason: 'Restore old backup with no photo', maintenance: 'restore' })
    assert.equal(car.data.photoAttachmentId, '')
    car = context.business.write({ id: car.id, kind: 'vehicle', data: { ...car.data, photoAttachmentId: uploaded.attachment.id }, version: car.version, actor: context.admin, reason: 'Restore selected cover', maintenance: 'restore' })
    assert.equal(car.data.photoAttachmentId, uploaded.attachment.id)
    for (const data of [null, [], 123]) assert.throws(() => context.business.write({ kind: 'vehicle', data: data as never, actor: context.actor, reason: 'Invalid vehicle payload' }), { code: 'INVALID_INPUT' })
  } finally { await context.close() }
})

test('photo validation, reasons and versions reject before changing working records', async () => {
  const context = await fixture()
  try {
    const car = context.create(), file = { name: 'cover.png', bytes: png() }
    for (const reason of ['', ' ', 'x'.repeat(501), 123]) await assert.rejects(context.photos.upload(car.id, file, car.version, reason, context.actor), { code: 'REASON_REQUIRED' })
    for (const version of [0, -1, NaN, Infinity, 1.5]) await assert.rejects(context.photos.upload(car.id, file, version, 'Invalid version', context.actor), { code: 'INVALID_INPUT' })
    await assert.rejects(context.photos.upload(car.id, file, car.version + 1, 'Stale version', context.actor), { code: 'VERSION_CONFLICT' })
    for (const file of [{ name: 'cover.jpg', bytes: png() }, { name: 'cover.svg', bytes: Buffer.from('<svg/>') }, { name: 'cover.png', bytes: png().subarray(0, -1) }, { name: 'cover.png', bytes: png(8193, 1) }]) await assert.rejects(context.photos.upload(car.id, file, car.version, 'Bad photo', context.actor), { code: 'FILE_TYPE_NOT_ALLOWED' })
    await assert.rejects(context.photos.upload(car.id, { name: 'huge.png', bytes: Buffer.alloc(PHOTO_MAX_BYTES + 1) }, car.version, 'Oversized photo', context.actor), { code: 'FILE_TOO_LARGE', status: 413 })
    assert.throws(() => context.photos.remove(car.id, car.version + 1, 'Stale removal', context.actor), { code: 'VERSION_CONFLICT' })
    assert.throws(() => context.photos.remove(car.id, car.version, ' ', context.actor), { code: 'REASON_REQUIRED' })
    assert.equal(context.business.list().length, 1)
    assert.equal(context.count('changes'), 1); assert.equal(context.count('outbox'), 1)
  } finally { await context.close() }
})

test('trusted photo selection rejects foreign, archived and non-photo attachments', async () => {
  const context = await fixture()
  try {
    const car = context.create(), other = context.create('TEST0000000000002')
    const foreign = await context.photos.upload(other.id, { name: 'other.png', bytes: png() }, other.version, 'Other vehicle cover', context.actor)
    assert.throws(() => context.business.write({ id: car.id, kind: 'vehicle', data: car.data, version: car.version, actor: context.actor, reason: 'Invalid foreign cover', photoAttachmentId: foreign.attachment.id }), { code: 'INVALID_INPUT' })
    const ordinary = context.business.write({ kind: 'attachment', vehicleId: car.id, data: { name: 'normal.png', checksum: checksum(png()), size: png().length }, actor: context.actor, reason: 'Ordinary attachment', internal: true })
    assert.throws(() => context.business.write({ id: car.id, kind: 'vehicle', data: car.data, version: car.version, actor: context.actor, reason: 'Non-photo attachment', photoAttachmentId: ordinary.id }), { code: 'INVALID_INPUT' })
    const own = await context.photos.upload(car.id, { name: 'cover.png', bytes: png() }, car.version, 'Own photo', context.actor)
    context.business.write({ id: own.attachment.id, kind: 'attachment', vehicleId: car.id, data: own.attachment.data, version: own.attachment.version, archived: true, actor: context.admin, reason: 'Archive original photo', internal: true })
    await assert.rejects(context.photos.read(car.id), { code: 'PHOTO_NOT_FOUND' })
    assert.throws(() => context.business.write({ id: car.id, kind: 'vehicle', data: own.vehicle.data, version: own.vehicle.version, actor: context.actor, reason: 'Cannot reselect archived original', photoAttachmentId: own.attachment.id }), { code: 'INVALID_INPUT' })
    assert.equal(context.photos.remove(car.id, own.vehicle.version, 'Clear unavailable reference', context.actor).data.photoAttachmentId, '')
  } finally { await context.close() }
})

test('upload rolls back attachment, vehicle history and queues when its final vehicle write fails', async () => {
  const context = await fixture()
  try {
    const car = context.create(), write = context.business.write.bind(context.business)
    context.business.write = input => { if (input.kind === 'vehicle' && input.photoAttachmentId) throw new Error('Injected final-write failure'); return write(input) }
    await assert.rejects(context.photos.upload(car.id, { name: 'cover.png', bytes: png() }, car.version, 'Atomic upload', context.actor), /Injected final-write failure/)
    assert.equal(context.business.list('attachment', car.id).length, 0)
    assert.equal(context.business.get(car.id).version, car.version)
    assert.equal(context.count('changes'), 1); assert.equal(context.count('outbox'), 1)
    assert.deepEqual(await context.business.readBlob(checksum(png())), png())
  } finally { await context.close() }
})

test('upload rechecks stale version, archive and permanent deletion after asynchronous blob I/O', async () => {
  for (const race of ['edit', 'archive', 'delete'] as const) {
    const context = await fixture()
    try {
      const car = context.create(), originalBlob = context.business.blob.bind(context.business)
      context.business.blob = async bytes => {
        const key = await originalBlob(bytes)
        if (race === 'edit') context.edit(car, { ...car.data, owner: 'Concurrent owner' })
        else if (race === 'archive') context.business.write({ id: car.id, kind: 'vehicle', data: car.data, version: car.version, archived: true, actor: context.admin, reason: 'Concurrent archive' })
        else {
          const marker: VehicleDeletion = { id: randomUUID(), requestId: randomUUID(), vehicleId: car.id, vin, recordIds: [car.id], fileKeys: [], actor: context.admin, reason: 'Concurrent deletion', deletedAt: new Date().toISOString(), revision: randomUUID(), sequence: 1 }
          context.store.applyDeletions([marker])
        }
        return key
      }
      await assert.rejects(context.photos.upload(car.id, { name: 'cover.png', bytes: png() }, car.version, 'Guard final upload', context.actor), { code: race === 'edit' ? 'VERSION_CONFLICT' : race === 'archive' ? 'PARENT_ARCHIVED' : 'VEHICLE_DELETED' })
      assert.equal(context.business.list('attachment', car.id).length, 0)
    } finally { await context.close() }
  }
})

test('final access callback can reject upload and its refreshed actor owns both successful changes', async () => {
  const context = await fixture()
  try {
    const car = context.create(), file = { name: 'cover.png', bytes: png() }
    await assert.rejects(context.photos.upload(car.id, file, car.version, 'Revoked while uploading', context.actor, async () => { throw new AppError('ACCESS_DISABLED', 403) }), { code: 'ACCESS_DISABLED' })
    assert.equal(context.business.list('attachment', car.id).length, 0)
    const author: Actor = { ...context.actor, name: 'Current live member' }
    await context.photos.upload(car.id, file, car.version, 'Use refreshed actor', context.actor, async () => author)
    const changes = context.business.history(car.id).filter(change => change.reason === 'Use refreshed actor')
    assert.equal(changes.length, 2)
    for (const change of changes) assert.equal(change.actor.name, author.name)
  } finally { await context.close() }
})

test('photo reads reject malformed references, wrong owners, stale reads and missing originals', async () => {
  const context = await fixture()
  try {
    const car = context.create(), other = context.create('TEST0000000000002')
    const uploaded = await context.photos.upload(car.id, { name: 'cover.png', bytes: png() }, car.version, 'Choose cover', context.actor)
    const setReference = (value: unknown) => context.store.db.prepare('UPDATE records SET data=? WHERE id=?').run(JSON.stringify({ ...uploaded.vehicle.data, photoAttachmentId: value }), car.id)
    for (const value of ['https://example.com/image', 'missing-record', '', null]) { setReference(value); await assert.rejects(context.photos.read(car.id), { code: 'PHOTO_NOT_FOUND' }) }
    const foreign = await context.photos.upload(other.id, { name: 'other.png', bytes: png() }, other.version, 'Foreign cover', context.actor)
    setReference(foreign.attachment.id); await assert.rejects(context.photos.read(car.id), { code: 'PHOTO_NOT_FOUND' })
    setReference(uploaded.attachment.id)
    await assert.rejects(context.photos.read(car.id, async () => { context.photos.remove(car.id, context.business.get(car.id).version, 'Clear during read', context.actor) }), { code: 'PHOTO_NOT_FOUND' })
    setReference(uploaded.attachment.id)
    await assert.rejects(context.photos.read(car.id, async () => { throw new AppError('WORKSPACE_CHANGED', 409) }), { code: 'WORKSPACE_CHANGED' })
    await fs.rm(path.join(context.directory, 'blobs', String(uploaded.attachment.data.checksum)))
    await assert.rejects(context.photos.read(car.id), { code: 'FILE_MISSING' })
  } finally { await context.close() }
})
