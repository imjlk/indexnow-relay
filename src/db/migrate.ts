import type { Database } from 'bun:sqlite'

import { MIGRATION_0001 } from './migrations/0001-init.ts'

interface Migration {
  version: number
  name: string
  statements: string
}

const MIGRATIONS: readonly Migration[] = [
  { version: 1, name: 'init', statements: MIGRATION_0001 },
]

/**
 * Applies pending migrations in order. Each migration runs in its own
 * transaction; the applied version is tracked in `schema_migrations`.
 */
export function migrate(db: Database): void {
  db.exec(/* sql */ `
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at INTEGER NOT NULL
    )
  `)

  const appliedRows = db.query<{ version: number }, []>('SELECT version FROM schema_migrations').all()
  const applied = new Set(appliedRows.map((row) => row.version))

  for (const migration of MIGRATIONS) {
    if (applied.has(migration.version)) continue
    db.transaction(() => {
      db.exec(migration.statements)
      db
        .query('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)')
        .run(migration.version, migration.name, Date.now())
    })()
  }
}
