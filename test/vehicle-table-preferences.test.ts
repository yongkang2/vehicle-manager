import { test } from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { defaultVehicleTablePreferences, parseVehicleTablePreferences, vehicleColumnIds } from '../shared/vehicle-table.js'
import type { VehicleTablePreferences } from '../shared/vehicle-table.js'
import { LocalStore } from '../server/store.js'
import { VehicleTablePreferencesStore } from '../server/vehicle-table-preferences.js'
import { VehicleTablePreferenceSession } from '../src/vehicle-table-preference-session.js'
import type { VehicleTablePreferenceState } from '../src/vehicle-table-preference-session.js'

const layout = (columns: VehicleTablePreferences['columns'], widths: VehicleTablePreferences['widths'] = {}): VehicleTablePreferences => ({ version: 1, columns, widths })
const tick = () => new Promise<void>(resolve => setImmediate(resolve))
type Options = { method?: string; body?: unknown; signal?: AbortSignal }
class FakeScope {
  calls: { url: string; options: Options; resolve: (value: unknown) => void; reject: (cause: unknown) => void }[] = []
  request<T>(url: string, options: Options = {}): Promise<T> {
    return new Promise<T>((resolve, reject) => { this.calls.push({ url, options, resolve: value => resolve(value as T), reject }) })
  }
}

test('vehicle table catalog preserves ten defaults, permits all sixteen columns and returns detached layouts', () => {
  assert.equal(vehicleColumnIds.length, 16); assert.equal(new Set(vehicleColumnIds).size, 16)
  const first = defaultVehicleTablePreferences(), second = defaultVehicleTablePreferences()
  assert.deepEqual(first.columns, ['vehicle', 'project', 'plate', 'status', 'physicalLocation', 'hvBatteryMaturityLevel', 'owner', 'latestDove', 'updated', 'actions'])
  first.columns.pop(); first.widths.notes = 300; assert.equal(second.columns.length, 10); assert.deepEqual(second.widths, {})
  const all = layout(['vehicle', ...vehicleColumnIds.filter(id => !['vehicle', 'actions'].includes(id)), 'actions'], { notes: 80, actions: 1000 })
  const parsed = parseVehicleTablePreferences(all); assert.deepEqual(parsed, all)
  parsed!.columns.pop(); parsed!.widths.notes = 500; assert.equal(all.columns.length, 16); assert.equal(all.widths.notes, 80)
  assert.deepEqual(parseVehicleTablePreferences(layout(['vehicle', 'actions'], { notes: 250 })), layout(['vehicle', 'actions'], { notes: 250 }), 'Hidden columns retain saved widths')
})

test('vehicle table validation rejects missing/duplicate/unknown columns, invalid bounds and unrecognized fields', () => {
  for (const input of [null, [], {}, { ...defaultVehicleTablePreferences(), version: 2 }, { ...defaultVehicleTablePreferences(), extra: true },
    layout(['actions', 'vehicle']), layout(['vehicle']), layout(['actions']), layout(['vehicle', 'owner', 'owner', 'actions']),
    { version: 1, columns: ['vehicle', 'unknown', 'actions'], widths: {} }, { version: 1, columns: ['vehicle', 'actions'], widths: { unknown: 200 } },
    { ...defaultVehicleTablePreferences(), widths: [] }, { ...defaultVehicleTablePreferences(), widths: null },
    ...[79, 1001, 80.5, NaN, Infinity, -Infinity, '200', null].map(width => ({ ...defaultVehicleTablePreferences(), widths: { vehicle: width } }))]) assert.equal(parseVehicleTablePreferences(input), null, JSON.stringify(input))
})

test('personal vehicle layouts persist by local account/workspace without records, queues or schema changes', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vm-column-preferences-'))
  let first = new LocalStore(path.join(root, 'first'))
  const second = new LocalStore(path.join(root, 'second'))
  try {
    let preferences = new VehicleTablePreferencesStore(first)
    const chosen = layout(['vehicle', 'hvBatterySerialNumber', 'model', 'actions'], { model: 185, notes: 420 })
    const beforeSettings = first.db.prepare('SELECT * FROM settings ORDER BY key').all()
    assert.deepEqual(preferences.get('account-a'), defaultVehicleTablePreferences())
    assert.deepEqual(preferences.put('account-a', chosen), chosen)
    assert.deepEqual(preferences.get('account-a'), chosen)
    assert.deepEqual(preferences.get('account-b'), defaultVehicleTablePreferences())
    assert.deepEqual(new VehicleTablePreferencesStore(second).get('account-a'), defaultVehicleTablePreferences())
    for (const table of ['records', 'outbox', 'changes', 'conflicts']) assert.equal(first.db.prepare(`SELECT COUNT(*) AS total FROM ${table}`).get()!.total, 0)
    assert.equal(first.db.prepare('PRAGMA user_version').get()!.user_version, 4)
    assert.deepEqual(first.db.prepare("SELECT * FROM settings WHERE key NOT LIKE 'vehicleTablePreferences:%' ORDER BY key").all(), beforeSettings)
    assert.throws(() => preferences.put('account-a', { ...chosen, columns: ['actions'] }), { code: 'INVALID_INPUT' })
    assert.deepEqual(preferences.get('account-a'), chosen)
    first.db.close(); first = new LocalStore(path.join(root, 'first')); preferences = new VehicleTablePreferencesStore(first)
    assert.deepEqual(preferences.get('account-a'), chosen)
    assert.equal(first.db.prepare('PRAGMA integrity_check').get()!.integrity_check, 'ok')
    first.set('vehicleTablePreferences:corrupt', { version: 42 })
    assert.throws(() => preferences.get('corrupt'), { code: 'INVALID_INPUT' })
  } finally { first.db.close(); second.db.close(); await fs.rm(root, { recursive: true, force: true }) }
})

test('preference session loads once without default autosave and serializes/coalesces changes', async () => {
  const scope = new FakeScope(), events: VehicleTablePreferenceState[] = []
  const session = new VehicleTablePreferenceSession(scope, value => events.push(value))
  const stored = layout(['vehicle', 'owner', 'actions'], { owner: 240 })
  session.start(); session.start(); assert.equal(scope.calls.length, 1)
  session.change(defaultVehicleTablePreferences()); assert.equal(scope.calls.length, 1, 'Do not save defaults before loading')
  scope.calls[0].resolve(stored); await tick(); assert.equal(scope.calls.length, 1); assert.deepEqual(events.at(-1)!.layout, stored)
  const first = layout(['vehicle', 'model', 'actions']), skipped = layout(['vehicle', 'color', 'actions']), latest = layout(['vehicle', 'notes', 'actions'], { notes: 420 })
  session.change(first); session.change(skipped); session.change(latest)
  assert.equal(scope.calls.length, 2); assert.deepEqual(scope.calls[1].options.body, first)
  scope.calls[1].resolve(first); await tick()
  assert.equal(scope.calls.length, 3); assert.deepEqual(scope.calls[2].options.body, latest)
  assert.deepEqual(events.at(-1)!.layout, latest, 'An older response must not replace the latest UI selection')
  scope.calls[2].resolve(latest); await tick(); assert.equal(events.at(-1)!.saveStatus, 'saved')
  session.change(latest); await tick(); assert.equal(scope.calls.length, 3, 'Unchanged layout does not write')
  session.dispose()
})

test('preference failures retain the newest unsaved layout and retry without changing captured scope', async () => {
  const scope = new FakeScope(), events: VehicleTablePreferenceState[] = []
  const session = new VehicleTablePreferenceSession(scope, value => events.push(value))
  session.start(); scope.calls[0].reject(new Error('NETWORK_ERROR')); await tick()
  assert.equal(events.at(-1)!.saveStatus, 'error'); assert.equal(scope.calls.length, 1)
  session.retry(); assert.equal(scope.calls.length, 2); scope.calls[1].resolve(defaultVehicleTablePreferences()); await tick()
  const first = layout(['vehicle', 'color', 'actions']), latest = layout(['vehicle', 'model', 'actions'])
  session.change(first); session.change(latest); scope.calls[2].reject(new Error('NETWORK_ERROR')); await tick()
  assert.equal(events.at(-1)!.saveStatus, 'error'); assert.deepEqual(events.at(-1)!.layout, latest)
  session.retry(); assert.equal(scope.calls.length, 4); assert.deepEqual(scope.calls[3].options.body, latest)
  session.retry(); assert.equal(events.at(-1)!.saveStatus, 'saving'); assert.equal(scope.calls.length, 4, 'Repeated retry does not start another write or report success early')
  scope.calls[3].resolve(latest); await tick(); assert.equal(events.at(-1)!.saveStatus, 'saved')
  assert(scope.calls.every(call => call.url === '/api/business/vehicle-table-preferences'))
  session.dispose()
})

test('disposing during load or save aborts the request, discards pending writes and ignores late responses', async () => {
  for (const phase of ['load', 'save']) {
    const scope = new FakeScope(), events: VehicleTablePreferenceState[] = []
    const session = new VehicleTablePreferenceSession(scope, value => events.push(value))
    session.start()
    if (phase === 'save') { scope.calls[0].resolve(defaultVehicleTablePreferences()); await tick(); session.change(layout(['vehicle', 'owner', 'actions'])); session.change(layout(['vehicle', 'model', 'actions'])) }
    const inFlight = scope.calls.at(-1)!, count = events.length, calls = scope.calls.length
    session.dispose(); assert.equal(inFlight.options.signal!.aborted, true)
    inFlight.resolve(defaultVehicleTablePreferences()); await tick(); session.retry(); session.change(defaultVehicleTablePreferences())
    assert.equal(events.length, count); assert.equal(scope.calls.length, calls)
  }
})
