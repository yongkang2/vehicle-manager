import { DatabaseSync } from 'node:sqlite'
import path from 'node:path'
import { History } from './history.js'
import { resetHistorySearch } from './history-search.js'
import type { HistoryStore } from './history-search.js'
import type { VehicleDeletion } from '../shared/business.js'
import { AppError } from './team.js'

const db = new DatabaseSync(':memory:')
db.exec('PRAGMA busy_timeout=5000')
const store: HistoryStore = {
  db,
  get<T>(key: string): T | null { const row = db.prepare('SELECT value FROM settings WHERE key=?').get(key); return row ? JSON.parse(String(row.value)) as T : null },
  deletionRows: () => db.prepare('SELECT payload FROM vehicle_deletions ORDER BY vehicle_id').all().map(row => JSON.parse(String(row.payload)) as VehicleDeletion),
}
const history = new History(store)
process.on('message', (message: { id: number; input: Parameters<History['query']>[0] }) => {
  let response: { id: number; result?: ReturnType<History['query']>; error?: string }
  let attached = false, transaction = false
  try {
    db.prepare('ATTACH DATABASE ? AS business').run(path.join(process.argv[2], 'local.sqlite')); attached = true
    db.exec('BEGIN'); transaction = true
    const result = history.query(message.input)
    db.exec('COMMIT'); transaction = false
    response = { id: message.id, result }
  } catch (error) {
    if (transaction) db.exec('ROLLBACK')
    resetHistorySearch(store)
    response = { id: message.id, error: error instanceof AppError ? error.code : 'SERVER_ERROR' }
  } finally { if (attached) db.exec('DETACH DATABASE business') }
  if (process.connected) process.send?.(response)
})
process.once('disconnect', () => { db.close(); process.exit(0) })