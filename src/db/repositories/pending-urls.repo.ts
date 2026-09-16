import type { Database } from 'bun:sqlite'

export interface PendingUrlRow {
  site_host: string
  url: string
  event_type: string | null
  first_seen_at: number
  last_seen_at: number
  due_at: number
  not_before_at: number
  attempts: number
  revision: number
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
  /** Revision at claim time; a higher value later means the row changed mid-flight. */
  revision: number
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

  /**
   * Inserts a brand-new pending URL due after `batchWindowMs`. Returns false
   * if one already exists.
   */
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

  /**
   * Reserves one more delivery for a recently-sent URL: a pending row that
   * cannot go out before `notBeforeAt` (last success + the site's minimum
   * resubmit interval). Unlike dropping the resubmission, the change is
   * guaranteed to reach IndexNow once the interval passes.
   */
  scheduleDeferred(
    siteHost: string,
    url: string,
    eventType: string | undefined,
    now: number,
    notBeforeAt: number,
    batchWindowMs: number,
    receiptId: string,
  ): boolean {
    const result = this.#db
      .query(
        `INSERT INTO pending_urls
           (site_host, url, event_type, first_seen_at, last_seen_at, due_at, not_before_at, attempts, last_receipt_id, status)
         VALUES (?, ?, ?, ?, ?, MAX(?, ?), ?, 0, ?, 'pending')
         ON CONFLICT (site_host, url) DO NOTHING`,
      )
      .run(siteHost, url, eventType ?? null, now, now, notBeforeAt, now + batchWindowMs, notBeforeAt, receiptId)
    return result.changes > 0
  }

  /**
   * A resubmission arrived while the URL is still pending (leased or not):
   * coalesce it. Bumps `revision` so an in-flight worker can detect the newer
   * change, and never pulls `due_at` below the `not_before_at` floor.
   */
  coalesceTouch(
    siteHost: string,
    url: string,
    now: number,
    batchWindowMs: number,
    maxCoalesceDelayMs: number,
    receiptId: string,
    eventType: string | undefined,
  ): void {
    this.#db
      .query(
        `UPDATE pending_urls
         SET last_seen_at = ?,
             last_receipt_id = ?,
             event_type = COALESCE(?, event_type),
             revision = revision + 1,
             due_at = MAX(not_before_at, MIN(due_at, ? + ?, first_seen_at + ?))
         WHERE site_host = ? AND url = ? AND status = 'pending'`,
      )
      .run(now, receiptId, eventType ?? null, now, batchWindowMs, maxCoalesceDelayMs, siteHost, url)
  }

  /**
   * A dead URL was resubmitted: revive it as pending with fresh attempts.
   * `notBeforeAt` (last success + the site's resubmit interval, when a recent
   * success exists) becomes the revived row's delivery floor.
   */
  reviveDead(
    siteHost: string,
    url: string,
    now: number,
    dueAt: number,
    receiptId: string,
    eventType: string | undefined,
    notBeforeAt: number,
  ): void {
    this.#db
      .query(
        `UPDATE pending_urls
         SET status = 'pending', attempts = 0, last_error = NULL,
             first_seen_at = ?, last_seen_at = ?,
             due_at = MAX(?, ?), not_before_at = ?, last_receipt_id = ?,
             event_type = COALESCE(?, event_type),
             revision = 1,
             lease_id = NULL, lease_until = NULL
         WHERE site_host = ? AND url = ? AND status = 'dead'`,
      )
      .run(now, now, dueAt, notBeforeAt, notBeforeAt, receiptId, eventType ?? null, siteHost, url)
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
          'SELECT url, event_type, attempts, revision FROM pending_urls WHERE site_host = ? AND lease_id = ?',
        )
        .all(siteHost, leaseId)
    })()
  }

  /**
   * Removes successfully submitted rows leased by this lease, but only while
   * their `revision` still matches the claim-time snapshot. Rows resubmitted
   * while in flight (higher revision) are left leased for
   * {@link PendingUrlsRepository.releaseFollowUps} instead of being deleted.
   */
  deleteLeased(siteHost: string, leaseId: string, claimed: readonly ClaimedUrl[]): number {
    const statement = this.#db.query(
      'DELETE FROM pending_urls WHERE site_host = ? AND lease_id = ? AND url = ? AND revision = ?',
    )
    return this.#db.transaction(() => {
      let deleted = 0
      for (const row of claimed) {
        deleted += statement.run(siteHost, leaseId, row.url, row.revision).changes
      }
      return deleted
    })()
  }

  /**
   * Releases rows that were resubmitted while in flight (their `revision`
   * passed the claim-time snapshot). The successful send is behind us, so the
   * follow-up change starts a fresh delivery cycle: attempts and last error
   * reset, and the cycle is anchored to the follow-up's receipt time so
   * `first_seen_at <= last_seen_at` keeps holding. `deliveryFloorMs` is the
   * just-finished success plus the site's resubmit interval, so the follow-up
   * delivers no earlier than policy allows. Both SET expressions read the
   * pre-update `not_before_at` (SQLite evaluates them against the original
   * row), so an already-higher floor keeps bounding due_at. Returns the
   * follow-up URLs.
   */
  releaseFollowUps(
    siteHost: string,
    leaseId: string,
    claimed: readonly ClaimedUrl[],
    batchWindowMs: number,
    deliveryFloorMs: number,
  ): string[] {
    const statement = this.#db.query(
      `UPDATE pending_urls
       SET lease_id = NULL, lease_until = NULL, attempts = 0, last_error = NULL,
           first_seen_at = last_seen_at,
           not_before_at = MAX(not_before_at, ?),
           due_at = MAX(not_before_at, ?, last_seen_at + ?)
       WHERE site_host = ? AND lease_id = ? AND url = ? AND revision > ?`,
    )
    return this.#db.transaction(() => {
      const followUps: string[] = []
      for (const row of claimed) {
        if (
          statement.run(
            deliveryFloorMs,
            deliveryFloorMs,
            batchWindowMs,
            siteHost,
            leaseId,
            row.url,
            row.revision,
          ).changes > 0
        ) {
          followUps.push(row.url)
        }
      }
      return followUps
    })()
  }

  /**
   * Releases a failed lease. Rows that exhausted `maxAttempts` become dead
   * letters; the rest stay pending with a new `due_at` and bumped attempts.
   * The retry wait becomes the row's delivery floor: later coalescing may not
   * reschedule it earlier.
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
               due_at = ?, not_before_at = ?, last_error = ?
           WHERE site_host = ? AND lease_id = ? AND attempts + 1 < ?`,
        )
        .run(retryAt, retryAt, errorMessage, siteHost, leaseId, maxAttempts).changes

      const dead = this.#db
        .query(
          `UPDATE pending_urls
           SET lease_id = NULL, lease_until = NULL, attempts = attempts + 1,
               due_at = 0, not_before_at = 0, last_error = ?, status = 'dead'
           WHERE site_host = ? AND lease_id = ?`,
        )
        .run(errorMessage, siteHost, leaseId).changes

      return { retried, dead }
    })()
  }

  /** Permanent failure: every leased row becomes a dead letter. */
  deadLeased(siteHost: string, leaseId: string, now: number, errorMessage: string): number {
    const result = this.#db
      .query(
        `UPDATE pending_urls
         SET lease_id = NULL, lease_until = NULL, attempts = attempts + 1,
             not_before_at = 0, last_error = ?, status = 'dead', last_seen_at = ?
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

  /**
   * Queue listing for the admin API: pending and/or dead rows, optionally
   * filtered by site, oldest due first (pending) / most recent last.
   */
  listQueue(
    siteHost: string | undefined,
    status: 'pending' | 'dead' | undefined,
    limit: number,
  ): PendingUrlRow[] {
    const clauses: string[] = []
    const params: Array<string | number> = []

    if (siteHost !== undefined) {
      clauses.push('site_host = ?')
      params.push(siteHost)
    }
    if (status !== undefined) {
      clauses.push('status = ?')
      params.push(status)
    }

    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : ''
    const order =
      status === 'dead'
        ? 'ORDER BY last_seen_at DESC'
        : status === 'pending'
          ? 'ORDER BY due_at ASC'
          : "ORDER BY CASE status WHEN 'pending' THEN 0 ELSE 1 END, due_at ASC, last_seen_at DESC"

    return this.#db
      .query<PendingUrlRow, Array<string | number>>(
        `SELECT * FROM pending_urls ${where} ${order} LIMIT ?`,
      )
      .all(...params, limit)
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
    const cycle = `status = 'pending', attempts = 0, last_error = NULL, due_at = ?,
               revision = 1, not_before_at = 0,
               lease_id = NULL, lease_until = NULL, last_seen_at = ?`
    if (urls !== undefined && urls.length > 0) {
      const placeholders = urls.map(() => '?').join(', ')
      return this.#db
        .query(
          `UPDATE pending_urls
           SET ${cycle}
           WHERE status = 'dead' ${siteHost === undefined ? '' : 'AND site_host = ?'} AND url IN (${placeholders})`,
        )
        .run(dueAt, now, ...(siteHost === undefined ? [] : [siteHost]), ...urls).changes
    }

    if (siteHost === undefined) {
      return this.#db
        .query(
          `UPDATE pending_urls
           SET ${cycle}
           WHERE status = 'dead'`,
        )
        .run(dueAt, now).changes
    }

    return this.#db
      .query(
        `UPDATE pending_urls
         SET ${cycle}
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
