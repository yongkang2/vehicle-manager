import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { promises as fs } from 'node:fs'
import { tmpdir, hostname } from 'node:os'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { LocalStore } from '../server/store.js'

type Variant = 'empty0' | 'legacy1' | 'legacy2' | 'workspace3' | 'deletion3' | 'combined3' | 'combined2' | 'complete4' | 'complete5'
const core = `CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);
  CREATE TABLE accounts(id TEXT PRIMARY KEY,username TEXT NOT NULL UNIQUE,display_name TEXT NOT NULL,salt TEXT NOT NULL,hash TEXT NOT NULL,created TEXT NOT NULL);
  CREATE TABLE sessions(token TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES accounts(id),expires INTEGER NOT NULL);
  CREATE TABLE local_events(id TEXT PRIMARY KEY,actor_id TEXT NOT NULL,action TEXT NOT NULL,detail TEXT NOT NULL,created TEXT NOT NULL);`
const business = `CREATE TABLE records(id TEXT PRIMARY KEY,kind TEXT NOT NULL,vehicle_id TEXT REFERENCES records(id),vin TEXT UNIQUE,data TEXT NOT NULL,archived INTEGER NOT NULL DEFAULT 0,version INTEGER NOT NULL,updated TEXT NOT NULL);
  CREATE INDEX records_vehicle ON records(vehicle_id,kind);
  CREATE TABLE changes(id TEXT PRIMARY KEY,record_id TEXT NOT NULL,vehicle_id TEXT NOT NULL,payload TEXT NOT NULL,created TEXT NOT NULL);
  CREATE TABLE outbox(seq INTEGER PRIMARY KEY,id TEXT UNIQUE NOT NULL,record_id TEXT NOT NULL,payload TEXT NOT NULL,state TEXT NOT NULL DEFAULT 'pending');
  CREATE TABLE conflicts(record_id TEXT PRIMARY KEY,payload TEXT NOT NULL);`
const workspaces = `CREATE TABLE workspaces(id TEXT PRIMARY KEY,name TEXT NOT NULL,shared_path TEXT NOT NULL,directory TEXT NOT NULL);
  CREATE TABLE account_workspaces(user_id TEXT NOT NULL REFERENCES accounts(id),workspace_id TEXT NOT NULL REFERENCES workspaces(id),PRIMARY KEY(user_id,workspace_id));
  ALTER TABLE sessions ADD COLUMN workspace_id TEXT;
  ALTER TABLE sessions ADD COLUMN workspace_epoch INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE sessions ADD COLUMN sync_enabled INTEGER NOT NULL DEFAULT 0;`
const deletions = `CREATE TABLE vehicle_deletions(vehicle_id TEXT PRIMARY KEY,request_id TEXT UNIQUE NOT NULL,payload TEXT NOT NULL);
  CREATE TABLE quarantined_operations(id TEXT PRIMARY KEY,payload TEXT NOT NULL);`
const versions: Record<Variant, number> = { empty0: 0, legacy1: 1, legacy2: 2, workspace3: 3, deletion3: 3, combined3: 3, combined2: 2, complete4: 4, complete5: 5 }
const quote = (name: string) => `"${name.replaceAll('"', '""')}"`

function fingerprint(db: DatabaseSync) {
  const objects = db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT GLOB 'sqlite_*' ORDER BY type,name").all()
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT GLOB 'sqlite_*' ORDER BY name").all().map(row => String(row.name))
  return { version: db.prepare('PRAGMA user_version').get()!.user_version, objects, data: Object.fromEntries(tables.map(name => [name, db.prepare(`SELECT * FROM ${quote(name)}`).all().map(row => JSON.stringify(row)).sort()])) }
}
async function backupNames(directory: string) { return fs.readdir(path.join(directory, 'migration-backups')).catch(error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error }) }
async function fixture(variant: Variant, options: { configured?: boolean; directory?: string; deviceId?: string } = {}) {
  const directory = options.directory || await fs.mkdtemp(path.join(tmpdir(), 'vehicle-schema5-'))
  await fs.mkdir(directory, { recursive: true })
  const file = path.join(directory, 'local.sqlite'), db = new DatabaseSync(file)
  const workspace = ['workspace3', 'combined3', 'combined2', 'complete4', 'complete5'].includes(variant)
  const deletion = ['deletion3', 'combined3', 'combined2', 'complete4', 'complete5'].includes(variant)
  const deviceId = options.deviceId || randomUUID(), userId = randomUUID(), secondUser = randomUUID(), teamId = randomUUID(), secondTeam = randomUUID(), carId = randomUUID()
  const bytes = Buffer.from('Preserved legacy original'), blob = createHash('sha256').update(bytes).digest('hex')
  try {
    db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;')
    if (variant !== 'empty0') {
      db.exec(core)
      if (variant !== 'legacy1') db.exec(business)
      if (workspace) db.exec(workspaces)
      if (deletion) db.exec(deletions)
      const set = (key: string, value: unknown) => db.prepare('INSERT INTO settings VALUES(?,?)').run(key, JSON.stringify(value))
      set('deviceId', deviceId); set('machine', hostname())
      if (options.configured !== false) { set('configuration', { teamId, sharedPath: path.join(directory, 'share') }); set('cachedTeam', { id: teamId, name: 'Legacy team', members: [], bindings: [] }) }
      set('language', 'zh'); set('businessRevision', randomUUID()); set('businessSequence', 7); set('businessLastSync', '2026-10-22T10:20:30.000Z')
      set('businessProtocol', deletion ? 2 : 1)
      for (const [id, name] of [[userId, 'first'], [secondUser, 'second']]) db.prepare('INSERT INTO accounts VALUES(?,?,?,?,?,?)').run(id, name, `${name} user`, 'fixture-salt', 'fixture-hash', '2026-10-21T00:00:00.000Z')
      if (workspace) {
        db.prepare('INSERT INTO workspaces VALUES(?,?,?,?)').run(teamId, 'Legacy team', path.join(directory, 'share'), '.')
        db.prepare('INSERT INTO workspaces VALUES(?,?,?,?)').run(secondTeam, 'Second team', path.join(directory, 'second-share'), path.join('workspaces', 'second'))
        for (const [user, team] of [[userId, teamId], [userId, secondTeam], [secondUser, teamId]]) db.prepare('INSERT INTO account_workspaces VALUES(?,?)').run(user, team)
        db.prepare('INSERT INTO sessions VALUES(?,?,?,?,?,?)').run('a'.repeat(64), userId, 9999999999999, secondTeam, 9, 1)
        db.prepare('INSERT INTO sessions VALUES(?,?,?,?,?,?)').run('b'.repeat(64), secondUser, 9999999999999, teamId, 4, 0)
        set(`preferredWorkspace:${userId}`, secondTeam)
      } else {
        db.prepare('INSERT INTO sessions VALUES(?,?,?)').run('a'.repeat(64), userId, 9999999999999)
        db.prepare('INSERT INTO sessions VALUES(?,?,?)').run('b'.repeat(64), secondUser, 9999999999999)
      }
      db.prepare('INSERT INTO local_events VALUES(?,?,?,?,?)').run(randomUUID(), userId, 'fixture.event', JSON.stringify({ retained: true }), '2026-10-21T00:00:00.000Z')
      if (variant !== 'legacy1') {
        const data = { vin: 'TEST0000000000001', status: 'available', physicalLocation: 'Original test bay', notes: 'Keep exact JSON' }
        db.prepare('INSERT INTO records VALUES(?,?,?,?,?,?,?,?)').run(carId, 'vehicle', null, data.vin, JSON.stringify(data), 0, 12, '2026-10-21T00:00:00.000Z')
        db.prepare('INSERT INTO records VALUES(?,?,?,?,?,?,?,?)').run(randomUUID(), 'report', carId, null, JSON.stringify({ name: 'original.xlsx', checksum: blob, size: bytes.length }), 1, 3, '2026-10-21T00:00:00.000Z')
        db.prepare('INSERT INTO changes VALUES(?,?,?,?,?)').run(randomUUID(), carId, carId, JSON.stringify({ action: 'fixture.history', after: data }), '2026-10-21T00:00:00.000Z')
        const operation = { id: randomUUID(), recordId: carId, vehicleId: null, kind: 'vehicle', base: null, desired: { data, archived: false }, actor: { id: userId, name: 'Fixture', role: 'admin', deviceId }, changes: [], files: [], created: '2026-10-21T00:00:00.000Z' }
        db.prepare('INSERT INTO outbox VALUES(?,?,?,?,?)').run(42, operation.id, carId, JSON.stringify(operation), 'pending')
        db.prepare('INSERT INTO conflicts VALUES(?,?)').run(carId, JSON.stringify({ recordId: carId, fields: ['owner'], token: 'keep-exact-token' }))
        if (deletion) {
          const deletedVehicle = randomUUID(), deletedRecord = randomUUID()
          const marker = { id: randomUUID(), requestId: randomUUID(), vehicleId: deletedVehicle, vin: 'TEST0000000000009', recordIds: [deletedVehicle, deletedRecord], fileKeys: [blob], actor: operation.actor, reason: 'Preserve deletion', deletedAt: '2026-10-21T00:00:00.000Z', revision: randomUUID(), sequence: 7 }
          const blocked = { ...operation, id: randomUUID(), recordId: deletedRecord, vehicleId: deletedVehicle, kind: 'attachment', files: [blob] }
          db.prepare('INSERT INTO vehicle_deletions VALUES(?,?,?)').run(deletedVehicle, marker.requestId, JSON.stringify(marker))
          db.prepare('INSERT INTO quarantined_operations VALUES(?,?)').run(blocked.id, JSON.stringify({ id: blocked.id, vehicleId: deletedVehicle, reason: 'VEHICLE_DELETED', quarantinedAt: '2026-10-21T00:00:00.000Z', operation: blocked }))
          db.prepare('INSERT INTO outbox VALUES(?,?,?,?,?)').run(43, blocked.id, deletedRecord, JSON.stringify(blocked), 'quarantined')
          set('pendingDeletionImports', [{ deletion: marker, actor: operation.actor }])
        }
      }
    }
    db.exec(`PRAGMA user_version=${versions[variant]}`)
  } finally { db.close() }
  await fs.mkdir(path.join(directory, 'blobs'), { recursive: true }); await fs.writeFile(path.join(directory, 'blobs', blob), bytes)
  return { directory, file, workspace, deletion, deviceId, userId, teamId, secondTeam, carId, blob, bytes, close: () => fs.rm(directory, { recursive: true, force: true }) }
}

for (const variant of ['empty0', 'legacy1', 'legacy2', 'workspace3', 'deletion3', 'combined3', 'combined2', 'complete4', 'complete5'] as const) {
  test(`schema5 upgrades ${variant} by capability and preserves existing data, files and identities`, async () => {
    const value = await fixture(variant)
    try {
      const source = new DatabaseSync(value.file), before = fingerprint(source); source.close()
      const upgraded = new LocalStore(value.directory)
      try {
        assert.equal(upgraded.db.prepare('PRAGMA user_version').get()!.user_version, 5)
        if (variant !== 'empty0') assert.equal(upgraded.deviceId, value.deviceId)
        for (const [table, rows] of Object.entries(before.data)) {
          const beforeRows = rows.map(row => JSON.parse(row) as Record<string, unknown>)
          const columnNames = beforeRows.length ? Object.keys(beforeRows[0]) : []
          const actual = upgraded.db.prepare(`SELECT * FROM ${quote(table)}`).all().map(row => JSON.stringify(Object.fromEntries(columnNames.map(name => [name, row[name]])))).sort()
          assert.deepEqual(actual, rows, `${table} changed during ${variant} migration`)
        }
        assert.equal(upgraded.db.prepare('PRAGMA integrity_check').get()!.integrity_check, 'ok')
        assert.deepEqual(upgraded.db.prepare('PRAGMA foreign_key_check').all(), [])
        assert.equal(upgraded.db.prepare("SELECT COUNT(*) AS total FROM sqlite_master WHERE type='table' AND name IN ('workspaces','account_workspaces','vehicle_deletions','quarantined_operations')").get()!.total, 4)
        if (variant !== 'empty0' && !value.workspace) {
          assert.equal(upgraded.db.prepare('SELECT directory FROM workspaces WHERE id=?').get(value.teamId)!.directory, '.')
          assert.equal(upgraded.db.prepare('SELECT COUNT(*) AS total FROM account_workspaces WHERE workspace_id=?').get(value.teamId)!.total, 2)
          assert.deepEqual(upgraded.db.prepare('SELECT workspace_id,workspace_epoch,sync_enabled FROM sessions').all().map(row => ({ ...row })), [{ workspace_id: value.teamId, workspace_epoch: 0, sync_enabled: 0 }, { workspace_id: value.teamId, workspace_epoch: 0, sync_enabled: 0 }])
        }
        assert.deepEqual(await fs.readFile(path.join(value.directory, 'blobs', value.blob)), value.bytes)
      } finally { upgraded.db.close() }
      const backups = await backupNames(value.directory)
      assert.equal(backups.length, ['empty0', 'complete5'].includes(variant) ? 0 : 1)
      if (backups.length) {
        assert.match(backups[0], /^before-schema5-[a-f0-9-]+\.sqlite$/)
        const snapshot = new DatabaseSync(path.join(value.directory, 'migration-backups', backups[0]), { readOnly: true })
        try { assert.deepEqual(fingerprint(snapshot), before); assert.equal(snapshot.prepare('PRAGMA integrity_check').get()!.integrity_check, 'ok') } finally { snapshot.close() }
      }
      const reopened = new LocalStore(value.directory)
      try { assert.equal(reopened.db.prepare('PRAGMA user_version').get()!.user_version, 5) } finally { reopened.db.close() }
      assert.deepEqual(await backupNames(value.directory), backups)
    } finally { await value.close() }
  })
}

test('unconfigured legacy accounts and sessions migrate without inventing workspace membership', async () => {
  const value = await fixture('legacy2', { configured: false })
  try {
    const store = new LocalStore(value.directory)
    try {
      assert.equal(store.db.prepare('SELECT COUNT(*) AS total FROM workspaces').get()!.total, 0)
      assert.equal(store.db.prepare('SELECT COUNT(*) AS total FROM account_workspaces').get()!.total, 0)
      assert.deepEqual(store.db.prepare('SELECT DISTINCT workspace_id,sync_enabled FROM sessions').all().map(row => ({ ...row })), [{ workspace_id: null, sync_enabled: 0 }])
    } finally { store.db.close() }
  } finally { await value.close() }
})

test('nested legacy workspace databases upgrade independently and retain the root device identity override without moving files', async () => {
  const root = await fixture('workspace3')
  try {
    const parent = new LocalStore(root.directory)
    try {
      const child = await fixture('workspace3', { directory: path.join(root.directory, 'workspaces', 'second'), deviceId: parent.deviceId })
      const nested = new LocalStore(child.directory, parent.deviceId)
      try {
        assert.equal(nested.deviceId, parent.deviceId)
        assert.equal(nested.get('deviceId'), parent.deviceId)
        assert.equal(nested.db.prepare('PRAGMA user_version').get()!.user_version, 5)
        assert.deepEqual(await fs.readFile(path.join(child.directory, 'blobs', child.blob)), child.bytes)
        assert.equal((await backupNames(child.directory)).length, 1)
        assert.equal(parent.db.prepare('SELECT directory FROM workspaces WHERE id=?').get(root.secondTeam)!.directory, path.join('workspaces', 'second'))
      } finally { nested.db.close() }
      const fresh = new LocalStore(path.join(root.directory, 'workspaces', 'fresh'), parent.deviceId)
      try { assert.equal(fresh.deviceId, parent.deviceId); assert.equal((await backupNames(fresh.directory)).length, 0) } finally { fresh.db.close() }
    } finally { parent.db.close() }
  } finally { await root.close() }
})

test('backup destination failure leaves the entire original schema/data intact and permits retry', async () => {
  const value = await fixture('deletion3')
  try {
    const source = new DatabaseSync(value.file), before = fingerprint(source); source.close()
    const blocked = path.join(value.directory, 'migration-backups')
    await fs.writeFile(blocked, 'Prevent migration backup')
    assert.throws(() => new LocalStore(value.directory), { code: 'LOCAL_BACKUP_FAILED' })
    const unchanged = new DatabaseSync(value.file)
    try { assert.deepEqual(fingerprint(unchanged), before) } finally { unchanged.close() }
    await fs.rm(blocked)
    const retry = new LocalStore(value.directory)
    try { assert.equal(retry.db.prepare('PRAGMA user_version').get()!.user_version, 5) } finally { retry.db.close() }
    assert.equal((await backupNames(value.directory)).length, 1)
  } finally { await value.close() }
})

test('schema4 compatibility upgrade backs up first and rolls back a failed schema5 stamp before retry', async t => {
  const value = await fixture('complete4')
  try {
    const source = new DatabaseSync(value.file), before = fingerprint(source); source.close()
    const execute = DatabaseSync.prototype.exec
    t.mock.method(DatabaseSync.prototype, 'exec', function (sql: string) {
      if (sql === 'PRAGMA user_version=5') throw new Error('Injected schema5 stamp failure')
      return execute.call(this, sql)
    })
    assert.throws(() => new LocalStore(value.directory), /Injected schema5 stamp failure/)
    t.mock.restoreAll()
    const unchanged = new DatabaseSync(value.file)
    try { assert.deepEqual(fingerprint(unchanged), before) } finally { unchanged.close() }
    const backup = await backupNames(value.directory)
    assert.equal(backup.length, 1)
    assert.match(backup[0], /^before-schema5-/)
    const preserved = new DatabaseSync(path.join(value.directory, 'migration-backups', backup[0]), { readOnly: true })
    try { assert.deepEqual(fingerprint(preserved), before) } finally { preserved.close() }
    const retry = new LocalStore(value.directory)
    try { assert.equal(retry.db.prepare('PRAGMA user_version').get()!.user_version, 5) } finally { retry.db.close() }
    assert.equal((await backupNames(value.directory)).length, 2)
  } finally { t.mock.restoreAll(); await value.close() }
})

test('backup integrity verification failure prevents every schema edit', async t => {
  const value = await fixture('workspace3')
  try {
    const source = new DatabaseSync(value.file), before = fingerprint(source); source.close()
    const prepare = DatabaseSync.prototype.prepare
    let backedUp = false
    t.mock.method(DatabaseSync.prototype, 'prepare', function (sql: string) {
      const statement = prepare.call(this, sql)
      if (sql === 'VACUUM INTO ?') return { run: (...args: Parameters<typeof statement.run>) => { const result = statement.run(...args); backedUp = true; return result } } as typeof statement
      if (backedUp && sql === 'PRAGMA integrity_check') return { get: () => ({ integrity_check: 'Injected integrity failure' }) } as unknown as typeof statement
      return statement
    })
    assert.throws(() => new LocalStore(value.directory), { code: 'LOCAL_BACKUP_FAILED' })
    t.mock.restoreAll()
    assert.equal(backedUp, true)
    const unchanged = new DatabaseSync(value.file)
    try { assert.deepEqual(fingerprint(unchanged), before) } finally { unchanged.close() }
    const retry = new LocalStore(value.directory)
    try { assert.equal(retry.db.prepare('PRAGMA user_version').get()!.user_version, 5) } finally { retry.db.close() }
  } finally { await value.close() }
})

test('a late backfill failure rolls back all added tables/columns/version and a later retry succeeds', async () => {
  const value = await fixture('legacy1')
  try {
    const source = new DatabaseSync(value.file)
    source.exec("CREATE TRIGGER reject_workspace_session BEFORE UPDATE OF workspace_id ON sessions BEGIN SELECT RAISE(ABORT,'Injected migration failure'); END;")
    const before = fingerprint(source); source.close()
    assert.throws(() => new LocalStore(value.directory), /Injected migration failure/)
    const unchanged = new DatabaseSync(value.file)
    try { assert.deepEqual(fingerprint(unchanged), before); unchanged.exec('DROP TRIGGER reject_workspace_session') } finally { unchanged.close() }
    const retry = new LocalStore(value.directory)
    try { assert.equal(retry.db.prepare('PRAGMA user_version').get()!.user_version, 5); assert.equal(retry.db.prepare('SELECT workspace_id FROM sessions LIMIT 1').get()!.workspace_id, value.teamId) } finally { retry.db.close() }
    assert.equal((await backupNames(value.directory)).length, 2)
  } finally { await value.close() }
})

for (const [name, variant, damage] of [
  ['partial deletion tables', 'deletion3', 'DROP TABLE quarantined_operations;'],
  ['partial workspace tables', 'workspace3', 'DROP TABLE account_workspaces;'],
  ['partial session columns', 'workspace3', 'ALTER TABLE sessions DROP COLUMN workspace_epoch;'],
  ['v3 without either feature', 'legacy2', 'PRAGMA user_version=3;'],
  ['incorrect v1 business shape', 'legacy2', 'PRAGMA user_version=1;'],
  ['malformed v4', 'complete4', 'DROP TABLE quarantined_operations;'],
  ['unknown extra columns', 'legacy2', 'ALTER TABLE records ADD COLUMN unexpected TEXT;'],
  ['missing required index', 'legacy2', 'DROP INDEX records_vehicle;'],
  ['broken foreign-key data', 'legacy2', "PRAGMA foreign_keys=OFF; UPDATE sessions SET user_id='missing-account';"],
  ['populated version zero', 'empty0', 'CREATE TABLE unrelated(value TEXT);'],
] as const) {
  test(`inconsistent shape (${name}) is rejected before backup or mutation`, async () => {
    const value = await fixture(variant)
    try {
      const source = new DatabaseSync(value.file); source.exec(damage); const before = fingerprint(source); source.close()
      assert.throws(() => new LocalStore(value.directory), { code: 'LOCAL_SCHEMA_INVALID' })
      const unchanged = new DatabaseSync(value.file)
      try { assert.deepEqual(fingerprint(unchanged), before) } finally { unchanged.close() }
      assert.equal((await backupNames(value.directory)).length, 0)
    } finally { await value.close() }
  })
}

test('newer schemas and copied-machine identities are rejected without migration or changing identity', async () => {
  for (const rejected of ['newer', 'copied']) {
    const value = await fixture('combined3')
    try {
      const source = new DatabaseSync(value.file)
      if (rejected === 'newer') source.exec('PRAGMA user_version=6')
      else source.prepare('UPDATE settings SET value=? WHERE key=?').run(JSON.stringify('another-host'), 'machine')
      const before = fingerprint(source); source.close()
      assert.throws(() => new LocalStore(value.directory), { code: rejected === 'newer' ? 'LOCAL_VERSION_TOO_NEW' : 'COPIED_LOCAL_DATA' })
      const unchanged = new DatabaseSync(value.file)
      try { assert.deepEqual(fingerprint(unchanged), before) } finally { unchanged.close() }
      assert.equal((await backupNames(value.directory)).length, 0)
    } finally { await value.close() }
  }
})
