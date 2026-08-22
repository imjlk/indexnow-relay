import type { Database } from 'bun:sqlite'

export interface SiteStateRow {
  site_host: string
  paused: 0 | 1
  paused_at: number | null
  paused_reason: string | null
  updated_at: number
}

/**
 * Runtime pause state per site. Site definitions (keys, endpoints) live in
 * the config file; this table only tracks operator toggles that should
 * survive restarts without touching the config.
 */
export class SiteStateRepository {
  readonly #db: Database

  constructor(db: Database) {
    this.#db = db
  }

  get(siteHost: string): SiteStateRow | null {
    return this.#db.query<SiteStateRow, [string]>('SELECT * FROM site_state WHERE site_host = ?').get(siteHost)
  }

  isPaused(siteHost: string): boolean {
    return this.get(siteHost)?.paused === 1
  }

  setPaused(siteHost: string, paused: boolean, reason: string | undefined, now: number): void {
    this.#db
      .query(
        `INSERT INTO site_state (site_host, paused, paused_at, paused_reason, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (site_host) DO UPDATE SET
           paused = excluded.paused,
           paused_at = excluded.paused_at,
           paused_reason = excluded.paused_reason,
           updated_at = excluded.updated_at`,
      )
      .run(siteHost, paused ? 1 : 0, paused ? now : null, paused ? (reason ?? null) : null, now)
  }

  pausedSites(): SiteStateRow[] {
    return this.#db.query<SiteStateRow, []>("SELECT * FROM site_state WHERE paused = 1").all()
  }
}
