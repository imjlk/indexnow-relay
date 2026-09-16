import type { Database } from 'bun:sqlite'

export interface SiteStateRow {
  site_host: string
  paused: 0 | 1
  paused_at: number | null
  paused_reason: string | null
  /** Epoch ms before which the site must not receive another batch (0 = none). */
  retry_not_before_at: number
  updated_at: number
}

/**
 * Runtime per-site state: operator pause toggles and the delivery cooldown
 * set by retryable failures. Site definitions (keys, endpoints) live in the
 * config file; this table only tracks state that should survive restarts
 * without touching the config.
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

  /** When the site may next be delivered; 0 when no cooldown is active. */
  retryNotBefore(siteHost: string): number {
    return this.get(siteHost)?.retry_not_before_at ?? 0
  }

  /**
   * Extends the site's delivery cooldown to `notBeforeAt`, never shortening
   * an existing longer wait. Does not touch the pause columns.
   */
  extendRetryNotBefore(siteHost: string, notBeforeAt: number, now: number): void {
    this.#db
      .query(
        `INSERT INTO site_state (site_host, retry_not_before_at, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT (site_host) DO UPDATE SET
           retry_not_before_at = MAX(retry_not_before_at, excluded.retry_not_before_at),
           updated_at = excluded.updated_at`,
      )
      .run(siteHost, notBeforeAt, now)
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
