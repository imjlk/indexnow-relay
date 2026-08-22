import type { Database } from 'bun:sqlite'

export interface PendingUrlRow {
  site_host: string
  url: string
  event_type: string | null
  first_seen_at: number
  last_seen_at: number
  due_at: number
  attempts: number
  lease_id: string | null
  lease_until: number | null
  last_receipt_id: string | null
  last_error: string | null
  status: 'pending' | 'dead'
}

export interface ClaimedUrl {
  url: string
  event_type: string | null
  attempts: number
}

export interface QueueDepth {
  site_host: string
  status: 'pending' | 'dead'
  count: number
  min_due_at: number | null
  max_attempts: number | null
}

/**
 * All queue state lives in `pending_urls`, keyed by `(site_host, url)`.
 * `status = 'dead'` rows are dead letters kept for inspection and retry.
 */
export class PendingUrlsRepository {
  readonly #db: Database

  constructor(db: Database) {
    this.#db = db
  }

  get(siteHost: string, url: string): PendingUrlRow | null {
    return this.#db
      .query<PendingUrlRow, [string, string]>('SELECT * FROM pending_urls WHERE site_host = ? AND url = ?')
      .get(siteHost, url)
  }

  /** Inserts a brand-new pending URL. Returns false if one already exists. */
  insertNew(
    siteHost: string,
    url: string,
    eventType: string | undefined,
    now: number,
    dueAt: number,
    receiptId: string,
  ): boolean {
    const result = this.#db
      .query(
        `INSERT INTO pending_urls
           (site_host, url, event_type, first_seen_at, last_seen_at, due_at, attempts, last_receipt_id, status)
         VALUES (?, ?, ?, ?, ?, ?, 0, ?, 'pending')
         ON CONFLICT (site_host, url) DO NOTHING`,
      )
      .run(siteHost, url, eventType ?? null, now, now, dueAt, receiptId)
    return result.changes > 0
  }

  /** A resubmission arrived while the URL is still pending: coalesce it. */
  coalesceTouch(
    siteHost: string,
    url: string,
    now: number,
    batchWindowMs: number,
    maxCoalesceDelayMs: number,
    receiptId: string,
  ): void {
    this.#db
      .query(
        `UPDATE pending_urls
         SET last_seen_at = ?,
             last_receipt_id = ?,
             due_at = MIN(due_at, ? + ?, first_seen_at + ?)
         WHERE site_host = ? AND url = ? AND status = 'pending'`,
      )
      .run(now, receiptId, now, batchWindowMs, maxCoalesceDelayMs, siteHost, url)
  }

  /** A dead URL was resubmitted: revive it as pending with fresh attempts. */
  reviveDead(siteHost: string, url: string, now: number, dueAt: number, receiptId: string): void {
    this.#db
      .query(
        `UPDATE pending_urls
         SET status = 'pending', attempts = 0, last_error = NULL,
             first_seen_at = ?, last_seen_at = ?, due_at = ?, last_receipt_id = ?,
             lease_id = NULL, lease_until = NULL
         WHERE site_host = ? AND url = ? AND status = 'dead'`,
      )
      .run(now, now, dueAt, receiptId, siteHost, url)
  }

  hasDueWork(siteHost: string, now: number): boolean {
    const row = this.#db
      .query<{ n: number }, [string, number]>(
        `SELECT COUNT(*) AS n FROM pending_urls
         WHERE site_host = ? AND due_at <= ? AND status = 'pending' AND lease_id IS NULL`,
      )
      .get(siteHost, now)
    return (row?.n ?? 0) > 0
  }

  nextDueAt(siteHost: string): number | null {
    const row = this.#db
      .query<{ d: number | null }, [string]>(
        `SELECT MIN(due_at) AS d FROM pending_urls
         WHERE site_host = ? AND status = 'pending' AND lease_id IS NULL`,
      )
      .get(siteHost)
    return row?.d ?? null
  }

  /**
   * Atomically leases up to `limit` due URLs for `siteHost`.
   * Returns the leased rows.
   */
  claimDue(
    siteHost: string,
    now: number,
    limit: number,
    leaseId: string,
    leaseUntil: number,
  ): ClaimedUrl[] {
    return this.#db.transaction(() => {
      this.#db
        .query(
          `UPDATE pending_urls
           SET lease_id = ?, lease_until = ?
           WHERE site_host = ? AND status = 'pending' AND due_at <= ? AND lease_id IS NULL
             AND url IN (
               SELECT url FROM pending_urls
               WHERE site_host = ? AND status = 'pending' AND due_at <= ? AND lease_id IS NULL
               ORDER BY first_seen_at ASC, url ASC
               LIMIT ?
             )`,
        )
        .run(leaseId, leaseUntil, siteHost, now, siteHost, now, limit)

      return this.#db
        .query<ClaimedUrl, [string, string]>(
          'SELECT url, event_type, attempts FROM pending_urls WHERE site_host = ? AND lease_id = ?',
        )
        .all(siteHost, leaseId)
    })()
  }

  /** Removes successfully submitted rows leased by this lease. */
  deleteLeased(siteHost: string, leaseId: string): number {
    const result = this.#db
      .query('DELETE FROM pending_urls WHERE site_host = ? AND lease_id = ?')
      .run(siteHost, leaseId)
    return result.changes
  }

  /**
   * Releases a failed lease. Rows that exhausted `maxAttempts` become dead
   * letters; the rest stay pending with a new `due_at` and bumped attempts.
   */
  failLeased(
    siteHost: string,
    leaseId: string,
    now: number,
    retryAt: number,
    errorMessage: string,
    maxAttempts: number,
  ): { retried: number; dead: number } {
    return this.#db.transaction(() => {
      const retried = this.#db
        .query(
          `UPDATE pending_urls
           SET lease_id = NULL, lease_until = NULL, attempts = attempts + 1,
               due_at = ?, last_error = ?
           WHERE site_host = ? AND lease_id = ? AND attempts + 1 < ?`,
        )
        .run(retryAt, errorMessage, siteHost, leaseId, maxAttempts).changes

      const dead = this.#db
        .query(
          `UPDATE pending_urls
           SET lease_id = NULL, lease_until = NULL, attempts = attempts + 1,
               due_at = ?, last_error = ?, status = 'dead'
           WHERE site_host = ? AND lease_id = ?`,
        )
        .run(0, errorMessage, siteHost, leaseId).changes

      return { retried, dead }
    })()
  }

  /** Permanent failure: every leased row becomes a dead letter. */
  deadLeased(siteHost: string, leaseId: string, now: number, errorMessage: string): number {
    const result = this.#db
      .query(
        `UPDATE pending_urls
         SET lease_id = NULL, lease_until = NULL, attempts = attempts + 1,
             last_error = ?, status = 'dead', last_seen_at = ?
         WHERE site_host = ? AND lease_id = ?`,
      )
      .run(errorMessage, now, siteHost, leaseId)
    return result.changes
  }

  clearExpiredLeases(now: number): number {
    const result = this.#db
      .query(
        `UPDATE pending_urls SET lease_id = NULL, lease_until = NULL
         WHERE lease_id IS NOT NULL AND lease_until IS NOT NULL AND lease_until <= ?`,
      )
      .run(now)
    return result.changes
  }

  /** On boot: any lease belongs to a previous process and is stale. */
  clearAllLeases(): number {
    const result = this.#db
      .query('UPDATE pending_urls SET lease_id = NULL, lease_until = NULL WHERE lease_id IS NOT NULL')
      .run()
    return result.changes
  }

  queueDepths(): QueueDepth[] {
    return this.#db
      .query<QueueDepth, []>(
        `SELECT site_host, status, COUNT(*) AS count, MIN(due_at) AS min_due_at, MAX(attempts) AS max_attempts
         FROM pending_urls GROUP BY site_host, status`,
      )
      .all()
  }

  countPendingByReceipt(receiptId: string): number {
    const row = this.#db
      .query<{ n: number }, [string]>(
        "SELECT COUNT(*) AS n FROM pending_urls WHERE last_receipt_id = ? AND status = 'pending'",
      )
      .get(receiptId)
    return row?.n ?? 0
  }

  listDead(siteHost: string | undefined, limit: number): PendingUrlRow[] {
    if (siteHost === undefined) {
      return this.#db
        .query<PendingUrlRow, [number]>(
          "SELECT * FROM pending_urls WHERE status = 'dead' ORDER BY last_seen_at DESC LIMIT ?",
        )
        .all(limit)
    }
    return this.#db
      .query<PendingUrlRow, [string, number]>(
        "SELECT * FROM pending_urls WHERE status = 'dead' AND site_host = ? ORDER BY last_seen_at DESC LIMIT ?",
      )
      .all(siteHost, limit)
  }

  requeueDead(
    now: number,
    dueAt: number,
    siteHost: string | undefined,
    urls: string[] | undefined,
  ): number {
    if (urls !== undefined && urls.length > 0) {
      const placeholders = urls.map(() => '?').join(', ')
      return this.#db
        .query(
          `UPDATE pending_urls
           SET status = 'pending', attempts = 0, last_error = NULL, due_at = ?,
               lease_id = NULL, lease_until = NULL, last_seen_at = ?
           WHERE status = 'dead' ${siteHost === undefined ? '' : 'AND site_host = ?'} AND url IN (${placeholders})`,
        )
        .run(dueAt, now, ...(siteHost === undefined ? [] : [siteHost]), ...urls).changes
    }

    if (siteHost === undefined) {
      return this.#db
        .query(
          `UPDATE pending_urls
           SET status = 'pending', attempts = 0, last_error = NULL, due_at = ?,
               lease_id = NULL, lease_until = NULL, last_seen_at = ?
           WHERE status = 'dead'`,
        )
        .run(dueAt, now).changes
    }

    return this.#db
      .query(
        `UPDATE pending_urls
         SET status = 'pending', attempts = 0, last_error = NULL, due_at = ?,
             lease_id = NULL, lease_until = NULL, last_seen_at = ?
         WHERE status = 'dead' AND site_host = ?`,
      )
      .run(dueAt, now, siteHost).changes
  }

  purgeOlderThan(cutoff: number): number {
    const result = this.#db
      .query(
        "DELETE FROM pending_urls WHERE status = 'dead' AND last_seen_at < ?",
      )
      .run(cutoff)
    return result.changes
  }
}
