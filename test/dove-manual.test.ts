import { test } from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import ExcelJS from 'exceljs'
import { parseDove } from '../server/dove-parser.js'
import { DoveService, compareReports } from '../server/dove.js'
import { Business } from '../server/business.js'
import { LocalStore } from '../server/store.js'
import { AppError } from '../server/team.js'
import { keyControllerNames, reportAssociationVin, reportMatchesVehicle, validReportAssociation } from '../shared/business.js'
import type { Actor, BusinessRecord, DoveImportConfirmation, DovePreview, ReportData, VehicleDeletion } from '../shared/business.js'

const vin = 'TEST0000000000001', otherVin = 'TEST0000000000002'
async function workbook(value: ExcelJS.CellValue = '', change?: (book: ExcelJS.Workbook) => void, software = '2.0'): Promise<Buffer> {
  const book = new ExcelJS.Workbook()
  book.addWorksheet('DOVE').addRows([['Vin :', value], ['Date of record', '2026-10-21 18h34'], ['Vehicle milage', '1234 km']])
  const identification = book.addWorksheet('Identification')
  identification.addRow(['Vin :'])
  identification.addRow(['ECU', 'Description', 'Network', 'Supplier'])
  identification.addRow(['EVCU', 'Controller', 'CAN UDS', 'Demo supplier', 'FN', 'PN', software, '', 'CAL', '2', '', '', '', '000123'])
  book.addWorksheet('Defauts').addRows([['Vin :'], ['EVCU', '', 'CAN UDS', 'P123456 (2Fh - Permanent) Demonstration fault']])
  change?.(book)
  return Buffer.from(await book.xlsx.writeBuffer())
}
async function fixture() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'dove-manual-')), store = new LocalStore(directory), business = new Business(store), service = new DoveService(business)
  const actor: Actor = { id: 'member', name: 'DOVE member', deviceId: store.deviceId, role: 'member' }, admin: Actor = { ...actor, id: 'admin', role: 'admin' }
  const create = (registration = vin) => business.write({ kind: 'vehicle', data: { vin: registration, status: 'available' }, actor, reason: 'Register test vehicle' })
  const count = () => [business.list().length, business.history().length, Number(store.db.prepare('SELECT COUNT(*) AS count FROM outbox').get()!.count)]
  const confirmation = (preview: DovePreview, extra: Partial<DoveImportConfirmation> = {}): DoveImportConfirmation => ({ confirmed: true, bindingToken: preview.manualBinding!.token, manualVehicleConfirmed: true, ...extra })
  const versions = (preview: DovePreview) => Object.fromEntries(keyControllerNames.map(name => [name, preview.currentControllers.find(record => record.data.name === name)?.version ?? null]))
  const close = async () => { store.db.close(); await fs.rm(directory, { recursive: true, force: true }) }
  return { directory, store, business, service, actor, admin, create, count, confirmation, versions, close }
}

test('missing VIN is a supported preview condition but other DOVE structure validation remains mandatory', async () => {
  for (const value of ['', null, '   ']) {
    const parsed = await parseDove(await workbook(value))
    assert.equal(parsed.vin, ''); assert.equal(parsed.rawVin, '')
    assert.ok(parsed.warnings.includes('VIN_MISSING'))
    assert.equal(parsed.controllers[0].name, 'EVCU')
    assert.equal(parsed.controllers[0].serial, '000123')
    assert.equal(parsed.faults.length, 1)
  }
  await assert.rejects(parseDove(await workbook('', book => { book.removeWorksheet('Defauts') })), /UNSUPPORTED_REPORT/)
  await assert.rejects(parseDove(await workbook('', book => { book.getWorksheet('Identification')!.getCell('A2').value = 'unsupported header' })), /UNSUPPORTED_REPORT/)
})

test('every recognized VIN row and header contributes evidence; duplicates cannot hide earlier values', async () => {
  const formatted = vin.toLowerCase().slice(0, 4) + '-' + vin.slice(4)
  const consistent = await parseDove(await workbook(formatted, book => {
    book.getWorksheet('DOVE')!.addRow(['VIN:', ''])
    book.getWorksheet('Identification')!.getCell('A1').value = `Vin : ${vin}`
    book.getWorksheet('Defauts')!.getCell('B1').value = `Vin : ${formatted}`
  }))
  assert.equal(consistent.vin, vin)
  assert.equal(consistent.rawVin, formatted)
  assert.equal(consistent.warnings.includes('VIN_MISSING'), false)
  const onlyHeader = await parseDove(await workbook('', book => { book.getWorksheet('Identification')!.getCell('A1').value = `Vin : ${vin}` }))
  assert.equal(onlyHeader.vin, vin)
  assert.equal(onlyHeader.rawVin, vin)
  await assert.rejects(parseDove(await workbook(vin, book => { book.getWorksheet('DOVE')!.addRow(['vin', otherVin]); book.getWorksheet('DOVE')!.addRow(['vin', '']) })), /VIN_MISMATCH/)
  await assert.rejects(parseDove(await workbook('', book => { book.getWorksheet('Identification')!.getCell('A1').value = `Vin : ${vin}`; book.getWorksheet('Defauts')!.getCell('A1').value = `Vin : ${otherVin}` })), /VIN_MISMATCH/)
  await assert.rejects(parseDove(await workbook('invalid', book => { book.getWorksheet('DOVE')!.addRow(['vin', '']); book.getWorksheet('Identification')!.getCell('A1').value = `Vin : ${vin}` })), /INVALID_VIN/)
})

test('nonblank malformed VINs remain errors rather than becoming manually assignable', async () => {
  for (const value of ['invalid', 'N/A', '----', 'I'.repeat(17), 'Q'.repeat(17), vin + '\u200b', 123]) await assert.rejects(parseDove(await workbook(value)), /INVALID_VIN/)
  await assert.rejects(parseDove(await workbook('', book => { book.getWorksheet('Defauts')!.getCell('A1').value = 'Vin : invalid' })), /INVALID_VIN/)
  const scoped = await parseDove(await workbook('', book => {
    book.getWorksheet('Identification')!.getCell('C1').value = vin
    book.getWorksheet('Defauts')!.getCell('A11').value = `Vin : ${otherVin}`
  }))
  assert.equal(scoped.vin, '')
})

test('missing previews require explicit owned binding; selecting a vehicle writes no records, history or queue', async () => {
  const context = await fixture()
  try {
    const car = context.create(), bytes = await workbook(), draft = await context.service.preview(bytes, `${vin}.xlsx`, context.actor.id), before = context.count()
    assert.equal(draft.match, 'manual-required'); assert.equal(draft.vehicle, null); assert.equal(draft.manualBinding, undefined)
    assert.equal(draft.parsed.vin, '')
    await assert.rejects(context.service.save(draft.id, context.actor.id, context.actor, { confirmed: true }), { code: 'MANUAL_VEHICLE_REQUIRED' })
    assert.throws(() => context.service.bind(draft.id, 'another-account', car.id, vin), { code: 'DRAFT_EXPIRED' })
    assert.throws(() => context.service.bind(draft.id, context.actor.id, car.id, otherVin), { code: 'VEHICLE_SELECTION_CHANGED' })
    assert.throws(() => context.service.bind(draft.id, context.actor.id, 'missing-vehicle', vin), { code: 'VEHICLE_SELECTION_CHANGED' })
    const bound = context.service.bind(draft.id, context.actor.id, car.id, vin)
    assert.equal(bound.match, 'matched'); assert.equal(bound.vehicle!.id, car.id)
    assert.deepEqual({ vehicleId: bound.manualBinding!.vehicleId, vin: bound.manualBinding!.vin }, { vehicleId: car.id, vin })
    assert.ok(bound.manualBinding!.token)
    assert.deepEqual(context.count(), before)
  } finally { await context.close() }
})

test('valid source VINs retain normal matching and cannot be manually reassigned', async () => {
  const context = await fixture()
  try {
    const car = context.create(), draft = await context.service.preview(await workbook(vin), 'normal.xlsx', context.actor.id)
    assert.equal(draft.match, 'matched'); assert.equal(draft.manualBinding, undefined)
    assert.throws(() => context.service.bind(draft.id, context.actor.id, car.id, vin), { code: 'INVALID_INPUT' })
    const report = await context.service.save(draft.id, context.actor.id, context.actor, { confirmed: true })
    assert.equal(report.data.association, undefined)
    assert.equal(reportAssociationVin(report), vin)
    assert.equal(context.business.list('part', car.id)[0].data.software, '2.0')
    assert.equal(report.data.parserVersion, 'dove-current-2')
  } finally { await context.close() }
})

test('manual retention requires acknowledgement and the current binding token, preserving original VIN and bytes', async () => {
  const context = await fixture()
  try {
    const car = context.create(), bytes = await workbook(), draft = await context.service.preview(bytes, 'missing-vin.xlsx', context.actor.id)
    const bound = context.service.bind(draft.id, context.actor.id, car.id, vin), before = context.count()
    await assert.rejects(context.service.save(draft.id, context.actor.id, context.actor, { confirmed: true, manualVehicleConfirmed: true }), { code: 'MANUAL_BINDING_CHANGED' })
    await assert.rejects(context.service.save(draft.id, context.actor.id, context.actor, { confirmed: true, bindingToken: bound.manualBinding!.token }), { code: 'MANUAL_VEHICLE_CONFIRMATION_REQUIRED' })
    assert.deepEqual(context.count(), before)
    const report = await context.service.save(draft.id, context.actor.id, context.actor, context.confirmation(bound))
    const data = report.data as unknown as ReportData
    assert.equal(data.parsed.vin, ''); assert.equal(data.parsed.rawVin, '')
    assert.equal(data.association!.method, 'manual'); assert.equal(data.association!.vehicleId, car.id)
    assert.equal(data.association!.vin, vin); assert.deepEqual(data.association!.actor, context.actor)
    assert.equal(data.association!.assignedAt, data.savedAt)
    assert.equal(data.parserVersion, 'dove-current-2')
    assert.deepEqual(await context.business.readBlob(data.checksum), bytes)
    assert.equal(context.business.list('part', car.id).length, 0)
    assert.ok(context.business.history(car.id).some(change => change.reason === 'DOVE retained after explicit manual vehicle association'))
    assert.equal(context.business.get(car.id).data.vin, vin)
  } finally { await context.close() }
})

test('each explicit rebind refreshes its token and stale confirmations cannot target a different vehicle', async () => {
  const context = await fixture()
  try {
    const car = context.create(), other = context.create(otherVin), draft = await context.service.preview(await workbook(), 'rebind.xlsx', context.actor.id)
    const first = context.service.bind(draft.id, context.actor.id, car.id, vin), second = context.service.bind(draft.id, context.actor.id, other.id, otherVin)
    assert.notEqual(first.manualBinding!.token, second.manualBinding!.token)
    await assert.rejects(context.service.save(draft.id, context.actor.id, context.actor, context.confirmation(first)), { code: 'MANUAL_BINDING_CHANGED' })
    const report = await context.service.save(draft.id, context.actor.id, context.actor, context.confirmation(second))
    assert.equal(report.vehicleId, other.id); assert.equal(reportAssociationVin(report), otherVin)
    assert.equal(context.business.list('report', car.id).length, 0)
  } finally { await context.close() }
})

test('manual controller import is an explicit opt-in with fresh reviewed versions and rolls back on stale input', async () => {
  const context = await fixture()
  try {
    const car = context.create(), bytes = await workbook(), draft = await context.service.preview(bytes, 'controllers.xlsx', context.actor.id)
    let bound = context.service.bind(draft.id, context.actor.id, car.id, vin)
    await assert.rejects(context.service.save(draft.id, context.actor.id, context.actor, context.confirmation(bound, { reportOnly: false })), { code: 'VERSION_CONFLICT' })
    assert.equal(context.business.list('report', car.id).length, 0)
    const controller = context.business.write({ kind: 'part', vehicleId: car.id, data: { name: 'VCU', category: 'controller', software: '1.0' }, actor: context.actor, reason: 'Concurrent controller creation' })
    await assert.rejects(context.service.save(draft.id, context.actor.id, context.actor, context.confirmation(bound, { reportOnly: false, versions: context.versions(bound) })), { code: 'VERSION_CONFLICT' })
    assert.equal(context.business.list('report', car.id).length, 0)
    assert.equal(context.business.get(controller.id).data.software, '1.0')
    bound = context.service.bind(draft.id, context.actor.id, car.id, vin)
    const report = await context.service.save(draft.id, context.actor.id, context.actor, context.confirmation(bound, { reportOnly: false, versions: context.versions(bound) }))
    assert.equal(context.business.get(controller.id).data.software, '2.0')
    assert.equal(context.business.get(controller.id).data.reportId, report.id)
    assert.ok(context.business.history(car.id).some(change => change.recordId === controller.id && change.sourceId === report.id))
  } finally { await context.close() }
})

test('repeat manual imports deduplicate by vehicle UUID and checksum without changing the original association', async () => {
  const context = await fixture()
  try {
    const car = context.create(), bytes = await workbook()
    const firstDraft = await context.service.preview(bytes, 'first.xlsx', context.actor.id), firstBound = context.service.bind(firstDraft.id, context.actor.id, car.id, vin)
    const first = await context.service.save(firstDraft.id, context.actor.id, context.actor, context.confirmation(firstBound))
    const repeat = await context.service.preview(bytes, 'renamed.xlsx', context.actor.id), repeatBound = context.service.bind(repeat.id, context.actor.id, car.id, vin)
    assert.equal(repeatBound.existingId, first.id)
    const returned = await context.service.save(repeat.id, context.actor.id, { ...context.actor, name: 'Later operator' }, context.confirmation(repeatBound, { reportOnly: false, versions: context.versions(repeatBound) }))
    assert.deepEqual(returned, first)
    assert.equal(context.business.list('report', car.id).length, 1)
    assert.equal(context.business.list('part', car.id)[0].data.software, '2.0')
    const current = context.business.get(car.id)
    context.business.write({ id: car.id, kind: 'vehicle', data: { ...current.data, vin: otherVin }, version: current.version, actor: context.actor, reason: 'Correct vehicle VIN later' })
    const changed = await context.service.preview(bytes, 'after-vin-change.xlsx', context.actor.id), changedBound = context.service.bind(changed.id, context.actor.id, car.id, otherVin), before = context.count()
    await assert.rejects(context.service.save(changed.id, context.actor.id, context.actor, context.confirmation(changedBound, { reportOnly: false, versions: context.versions(changedBound) })), { code: 'REPORT_VIN_MISMATCH' })
    assert.deepEqual(context.count(), before)
    assert.deepEqual(context.business.get(first.id), first)
  } finally { await context.close() }
})

for (const change of ['vin', 'archive', 'rebind'] as const) {
  test(`manual save rejects ${change} changes during asynchronous file persistence`, async () => {
    const context = await fixture()
    try {
      const car = context.create(), other = context.create(otherVin), draft = await context.service.preview(await workbook(), 'race.xlsx', context.actor.id), bound = context.service.bind(draft.id, context.actor.id, car.id, vin)
      await assert.rejects(context.service.save(draft.id, context.actor.id, context.actor, context.confirmation(bound), async () => {
        if (change === 'rebind') context.service.bind(draft.id, context.actor.id, other.id, otherVin)
        else {
          const current = context.business.get(car.id)
          context.business.write({ id: car.id, kind: 'vehicle', data: { ...current.data, ...(change === 'vin' ? { vin: 'TEST0000000000003' } : {}) }, version: current.version, archived: change === 'archive', actor: context.admin, reason: 'Concurrent target change' })
        }
        return context.actor
      }), { code: change === 'rebind' ? 'MANUAL_BINDING_CHANGED' : 'VEHICLE_SELECTION_CHANGED' })
      assert.equal(context.business.list('report').length, 0)
      assert.equal(context.business.list('part').length, 0)
    } finally { await context.close() }
  })
}

test('final access callback rejects revoked sessions and supplies the actor used in association and changes', async () => {
  const context = await fixture()
  try {
    const car = context.create(), draft = await context.service.preview(await workbook(), 'actor.xlsx', context.actor.id), bound = context.service.bind(draft.id, context.actor.id, car.id, vin)
    await assert.rejects(context.service.save(draft.id, context.actor.id, context.actor, context.confirmation(bound), async () => { throw new AppError('ACCESS_DISABLED', 403) }), { code: 'ACCESS_DISABLED' })
    assert.equal(context.business.list('report').length, 0)
    const currentActor = { ...context.actor, name: 'Refreshed member name' }
    const report = await context.service.save(draft.id, context.actor.id, context.actor, context.confirmation(bound, { reportOnly: false, versions: context.versions(bound) }), async () => currentActor)
    assert.deepEqual((report.data as unknown as ReportData).association!.actor, currentActor)
    for (const change of context.business.history(car.id).filter(change => change.recordId !== car.id)) assert.deepEqual(change.actor, currentActor)
  } finally { await context.close() }
})

test('deleted selected UUIDs never silently retarget a newly registered vehicle with the same VIN', async () => {
  const context = await fixture()
  try {
    const car = context.create(), bytes = await workbook(), draft = await context.service.preview(bytes, 'deleted.xlsx', context.actor.id), bound = context.service.bind(draft.id, context.actor.id, car.id, vin)
    const marker: VehicleDeletion = { id: randomUUID(), requestId: randomUUID(), vehicleId: car.id, vin, recordIds: [car.id], fileKeys: [], actor: context.admin, reason: 'Delete old identity', deletedAt: new Date().toISOString(), revision: randomUUID(), sequence: 1 }
    context.store.applyDeletions([marker])
    const replacement = context.create()
    await assert.rejects(context.service.save(draft.id, context.actor.id, context.actor, context.confirmation(bound)), { code: 'VEHICLE_DELETED' })
    assert.equal(context.business.list('report', replacement.id).length, 0)
    const fresh = await context.service.preview(bytes, 'fresh.xlsx', context.actor.id), freshBound = context.service.bind(fresh.id, context.actor.id, replacement.id, vin)
    const report = await context.service.save(fresh.id, context.actor.id, context.actor, context.confirmation(freshBound))
    assert.equal(report.vehicleId, replacement.id)
    assert.ok(report.id.startsWith(`report-${replacement.id}-`))
  } finally { await context.close() }
})

test('manual and reported reports compare only for the same UUID and effective VIN, preserving source provenance', async () => {
  const context = await fixture()
  try {
    const car = context.create(), manualDraft = await context.service.preview(await workbook(), 'manual.xlsx', context.actor.id), bound = context.service.bind(manualDraft.id, context.actor.id, car.id, vin)
    const manual = await context.service.save(manualDraft.id, context.actor.id, context.actor, context.confirmation(bound))
    const normalDraft = await context.service.preview(await workbook(vin, undefined, '3.0'), 'reported.xlsx', context.actor.id), normal = await context.service.save(normalDraft.id, context.actor.id, context.actor, { confirmed: true, reportOnly: true })
    assert.equal(reportAssociationVin(manual), vin); assert.equal(reportAssociationVin(normal), vin)
    assert.equal(reportMatchesVehicle(manual, car), true); assert.equal(reportMatchesVehicle(normal, car), true)
    assert.equal(compareReports(manual, normal).controllers[0].status, 'changed')
    assert.equal((manual.data as unknown as ReportData).parsed.vin, '')
    assert.throws(() => compareReports(manual, { ...normal, vehicleId: 'different-vehicle' }), { code: 'REPORT_VIN_MISMATCH' })
    const wrongAssociation = { ...manual, data: { ...manual.data, association: { ...(manual.data as unknown as ReportData).association!, vin: otherVin } } }
    assert.equal(reportMatchesVehicle(wrongAssociation, car), false)
    assert.throws(() => compareReports(wrongAssociation, normal), { code: 'REPORT_VIN_MISMATCH' })
  } finally { await context.close() }
})

test('association helpers reject inconsistent manual provenance without relaxing valid legacy report support', async () => {
  const actor: Actor = { id: 'member', name: 'Member', deviceId: 'device', role: 'member' }
  const association = { method: 'manual', vehicleId: 'vehicle', vin, actor, assignedAt: '2026-10-25T10:00:00.000Z' }
  const report: BusinessRecord = { id: 'report', kind: 'report', vehicleId: 'vehicle', data: { parsed: { vin: '', rawVin: '' }, association }, archived: false, version: 1, updated: association.assignedAt }
  assert.equal(validReportAssociation(report), true)
  for (const invalid of [
    { ...association, vehicleId: 'another-vehicle' }, { ...association, vin: 'invalid' }, { ...association, method: 'automatic' },
    { ...association, assignedAt: 'not-a-date' }, { ...association, actor: { ...actor, role: 'unknown' } }, { ...association, actor: { ...actor, role: ['member'] } }, { ...association, actor: { ...actor, id: '' } },
  ]) assert.equal(reportAssociationVin({ ...report, data: { ...report.data, association: invalid } }), null)
  for (const parsed of [{ vin, rawVin: vin }, { vin: '', rawVin: 'invalid' }, { vin: 'invalid', rawVin: '' }, { vin: null, rawVin: '' }]) assert.equal(reportAssociationVin({ ...report, data: { ...report.data, parsed } }), null)
  const legacy = { ...report, data: { parsed: { vin } } }
  assert.equal(validReportAssociation(legacy), true)
  assert.equal(reportAssociationVin(legacy), vin)
  assert.equal(reportAssociationVin({ ...legacy, kind: 'vehicle' }), null)
  assert.equal(reportAssociationVin({ ...legacy, data: { parsed: { vin: '' } } }), null)
})
