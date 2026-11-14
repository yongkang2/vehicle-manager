import type { LocalStore } from './store.js'

export type HistoryStore = Pick<LocalStore, 'db' | 'get' | 'deletionRows'>
const indexes = new WeakMap<HistoryStore, { revision: number; count: number; rowid: number }>()

export function prepareHistorySearch(store: HistoryStore): void {
  const revision = store.get<number>('historyRevision') || 0
  const previous = indexes.get(store)
  if (previous?.revision === revision) return
  const state = store.db.prepare('SELECT count(*) AS total,COALESCE(max(rowid),0) AS last FROM changes').get()!
  const count = Number(state.total), rowid = Number(state.last)
  store.db.exec('CREATE TEMP TABLE IF NOT EXISTS history_search(rowid INTEGER PRIMARY KEY,keys TEXT,contents TEXT)')
  const append = previous && revision - previous.revision === count - previous.count && count >= previous.count && rowid >= previous.rowid
  if (!append) store.db.exec('DELETE FROM temp.history_search')
  store.db.prepare(`INSERT INTO temp.history_search(rowid,keys,contents)
    SELECT changes.rowid,
      (SELECT group_concat(substr(CAST(key AS TEXT),1,length(CAST(key AS TEXT))),char(10)) FROM json_tree(changes.payload)),
      (SELECT group_concat(substr(CAST(value AS TEXT),1,length(CAST(value AS TEXT))),char(10)) FROM json_tree(changes.payload) WHERE type IN ('text','integer','real','true','false'))
    FROM changes WHERE rowid>?`).run(append ? previous.rowid : 0)
  indexes.set(store, { revision, count, rowid })
}
export const resetHistorySearch = (store: HistoryStore) => { indexes.delete(store) }
