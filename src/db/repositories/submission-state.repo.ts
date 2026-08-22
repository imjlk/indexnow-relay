import type { Database } from 'bun:sqlite'

/**
 * Per-URL "last successfully sent" timestamps. Backs the
 * `minResubmitIntervalMs` gate so clients that resubmit a recently-sent URL
 * get a coalesced receipt instead of a redundant IndexNow request.
 */
export class SubmissionStateRepository {
  readonly #db: Database

  constructor(db: Database) {
    this.#db = db
  }

  getSentAt(siteHost: string, urls: string[]): Map<string, number> {
    const result = new Map<string, number>()
    if (urls.length === 0) return result

    const placeholders = urls.map(() => '?').join(', ')
    const rows = this.#db
      .query<{ url: string; sent_at: number }, [string, ...string[]]>(
        `SELECT url, sent_at FROM submission_state WHERE site_host = ? AND url IN (${placeholders})`,
      )
      .all(siteHost, ...urls)
    for (const row of rows) {
      result.set(row.url, row.sent_at)
    }
    return result
  }

  recordSent(siteHost: string, urls: string[], sentAt: number): void {
    if (urls.length === 0) return
    const statement = this.#db.query(
      `INSERT INTO submission_state (site_host, url, sent_at) VALUES (?, ?, ?)
       ON CONFLICT (site_host, url) DO UPDATE SET sent_at = excluded.sent_at`,
    )
    this.#db.transaction(() => {
      for (const url of urls) {
        statement.run(siteHost, url, sentAt)
      }
    })()
  }

  /** Only the resubmit-interval window matters; older rows are noise. */
  purgeOlderThan(cutoff: number): number {
    return this.#db.query('DELETE FROM submission_state WHERE sent_at < ?').run(cutoff).changes
  }
}
