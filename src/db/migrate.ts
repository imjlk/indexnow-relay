import type { Database } from 'bun:sqlite'

import { MIGRATION_0001 } from './migrations/0001-init.ts'
import { MIGRATION_0002 } from './migrations/0002-delivery-cycles.ts'
import { MIGRATION_0003 } from './migrations/0003-site-retry-wait.ts'

interface Migration {
  version: number
  name: string
  statements: string
}

const MIGRATIONS: readonly Migration[] = [
  { version: 1, name: 'init', statements: MIGRATION_0001 },
  { version: 2, name: 'delivery_cycles', statements: MIGRATION_0002 },
  { version: 3, name: 'site_retry_wait', statements: MIGRATION_0003 },
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
