import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { Database } from 'bun:sqlite'

export type RelayDatabase = Database

/**
 * Opens (and creates) the SQLite database with durable-by-default pragmas.
 * WAL keeps readers cheap while the worker writes; busy_timeout absorbs the
 * rare writer contention during migrations.
 */
export function openDatabase(path: string): RelayDatabase {
  if (!path.startsWith(':memory:') && !path.startsWith('file:')) {
    mkdirSync(dirname(path), { recursive: true })
  }

  const db = new Database(path, { create: true })
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA synchronous = NORMAL')
  db.exec('PRAGMA busy_timeout = 5000')
  return db
}
