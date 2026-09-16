import { beforeEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'

import { migrate } from '../src/db/migrate.ts'
import { MIGRATION_0001 } from '../src/db/migrations/0001-init.ts'

/** A database as it existed after schema v1, before `migrate()` runs. */
function createV1Database(path: string): Database {
  const db = new Database(path)
  db.exec(MIGRATION_0001)
  db.exec(/* sql */ `
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at INTEGER NOT NULL
    )
  `)
  db.query('INSERT INTO schema_migrations (version, name, applied_at) VALUES (1, \'init\', 0)').run()
  return db
}

describe('migrations', () => {
  let path: string

  beforeEach(() => {
    path = `${process.env.TMPDIR ?? '/tmp'}/indexnow-relay-migration-${crypto.randomUUID()}.db`
  })

  test('upgrades a v1 database and preserves retry floors', () => {
    const db = createV1Database(path)
    const retryDueAt = Date.now() + 3_600_000
    db.query(
      `INSERT INTO pending_urls
         (site_host, url, first_seen_at, last_seen_at, due_at, attempts, status)
       VALUES
         ('www.example.com', 'https://www.example.com/retry', ?, ?, ?, 2, 'pending'),
         ('www.example.com', 'https://www.example.com/fresh', ?, ?, ?, 0, 'pending'),
         ('www.example.com', 'https://www.example.com/dead', ?, ?, 0, 5, 'dead')`,
    ).run(
      Date.now() - 1000, Date.now() - 500, retryDueAt,
      Date.now() - 1000, Date.now(), Date.now() + 1000,
      Date.now() - 1000, Date.now() - 500,
    )

    migrate(db)

    const retry = db.query('SELECT revision, not_before_at FROM pending_urls WHERE url = ?')
      .get('https://www.example.com/retry') as { revision: number; not_before_at: number }
    expect(retry.revision).toBe(1)
    expect(retry.not_before_at).toBe(retryDueAt)

    const fresh = db.query('SELECT not_before_at FROM pending_urls WHERE url = ?')
      .get('https://www.example.com/fresh') as { not_before_at: number }
    expect(fresh.not_before_at).toBe(0)

    const dead = db.query('SELECT not_before_at FROM pending_urls WHERE url = ?')
      .get('https://www.example.com/dead') as { not_before_at: number }
    expect(dead.not_before_at).toBe(0)

    const versions = db.query('SELECT version FROM schema_migrations ORDER BY version').all() as Array<{ version: number }>
    expect(versions.map((v) => v.version)).toEqual([1, 2, 3])
    db.close()
  })

  test('re-running migrate is a no-op', () => {
    const db = createV1Database(path)
    migrate(db)
    const rowsBefore = db.query('SELECT COUNT(*) AS n FROM schema_migrations').get() as { n: number }
    migrate(db)
    const rowsAfter = db.query('SELECT COUNT(*) AS n FROM schema_migrations').get() as { n: number }
    expect(rowsBefore.n).toBe(3)
    expect(rowsAfter.n).toBe(3)
    db.close()
  })

  test('a fresh database applies all migrations at once', () => {
    const db = new Database(path)
    migrate(db)
    const columns = db.query('PRAGMA table_info(pending_urls)').all() as Array<{ name: string }>
    expect(columns.map((c) => c.name)).toContain('revision')
    expect(columns.map((c) => c.name)).toContain('not_before_at')
    const siteColumns = db.query('PRAGMA table_info(site_state)').all() as Array<{ name: string }>
    expect(siteColumns.map((c) => c.name)).toContain('retry_not_before_at')
    db.close()
  })
})
