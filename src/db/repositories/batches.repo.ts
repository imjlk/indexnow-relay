import type { Database } from 'bun:sqlite'

export type BatchStatus = 'in_flight' | 'succeeded' | 'retry_scheduled' | 'dead'

export interface BatchRow {
  id: string
  site_host: string
  status: BatchStatus
  url_count: number
  attempt: number
  created_at: number
  completed_at: number | null
  retry_at: number | null
  http_status: number | null
  error_code: string | null
  error_message: string | null
}

/** Audit log of every IndexNow submission attempt, one row per attempt. */
export class SubmissionBatchesRepository {
  readonly #db: Database

  constructor(db: Database) {
    this.#db = db
  }

  insertInFlight(id: string, siteHost: string, urlCount: number, attempt: number, createdAt: number): void {
    this.#db
      .query(
        `INSERT INTO submission_batches
           (id, site_host, status, url_count, attempt, created_at)
         VALUES (?, ?, 'in_flight', ?, ?, ?)`,
      )
      .run(id, siteHost, urlCount, attempt, createdAt)
  }

  private markTerminal(
    id: string,
    status: BatchStatus,
    completedAt: number,
    fields: { httpStatus?: number; retryAt?: number; errorCode?: string; errorMessage?: string },
  ): void {
    this.#db
      .query(
        `UPDATE submission_batches
         SET status = ?, completed_at = ?, http_status = ?, retry_at = ?, error_code = ?, error_message = ?
         WHERE id = ?`,
      )
      .run(
        status,
        completedAt,
        fields.httpStatus ?? null,
        fields.retryAt ?? null,
        fields.errorCode ?? null,
        fields.errorMessage ?? null,
        id,
      )
  }

  markSucceeded(id: string, httpStatus: number, completedAt: number): void {
    this.markTerminal(id, 'succeeded', completedAt, { httpStatus })
  }

  markRetry(id: string, retryAt: number, httpStatus: number | undefined, errorMessage: string, completedAt: number): void {
    this.markTerminal(id, 'retry_scheduled', completedAt, { httpStatus, retryAt, errorMessage })
  }

  markDead(id: string, httpStatus: number | undefined, errorMessage: string, completedAt: number): void {
    this.markTerminal(id, 'dead', completedAt, { httpStatus, errorMessage })
  }

  /** Crash safety: any batch left in_flight belongs to a dead process. */
  closeDanglingInFlight(now: number): number {
    return this.#db
      .query(
        `UPDATE submission_batches
         SET status = 'retry_scheduled', completed_at = ?, error_code = 'process_restart',
             retry_at = ?
         WHERE status = 'in_flight'`,
      )
      .run(now, now).changes
  }

  list(siteHost: string | undefined, limit: number): BatchRow[] {
    if (siteHost === undefined) {
      return this.#db
        .query<BatchRow, [number]>(
          'SELECT * FROM submission_batches ORDER BY created_at DESC, id DESC LIMIT ?',
        )
        .all(limit)
    }
    return this.#db
      .query<BatchRow, [string, number]>(
        'SELECT * FROM submission_batches WHERE site_host = ? ORDER BY created_at DESC, id DESC LIMIT ?',
      )
      .all(siteHost, limit)
  }

  countsByStatus(): Array<{ site_host: string; status: BatchStatus; count: number }> {
    return this.#db
      .query<{ site_host: string; status: BatchStatus; count: number }, []>(
        'SELECT site_host, status, COUNT(*) AS count FROM submission_batches GROUP BY site_host, status',
      )
      .all()
  }

  purgeOlderThan(cutoff: number): number {
    return this.#db.query('DELETE FROM submission_batches WHERE created_at < ?').run(cutoff).changes
  }
}
