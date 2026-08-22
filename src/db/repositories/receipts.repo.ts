import type { Database } from 'bun:sqlite'

export interface ReceiptRow {
  id: string
  created_at: number
  received: number
  enqueued: number
  coalesced: number
  /** JSON-encoded Array<{ host, enqueued, coalesced }> */
  sites: string
}

export class ReceiptsRepository {
  readonly #db: Database

  constructor(db: Database) {
    this.#db = db
  }

  insert(row: ReceiptRow): void {
    this.#db
      .query(
        'INSERT INTO receipts (id, created_at, received, enqueued, coalesced, sites) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(row.id, row.created_at, row.received, row.enqueued, row.coalesced, row.sites)
  }

  get(id: string): ReceiptRow | null {
    return this.#db.query<ReceiptRow, [string]>('SELECT * FROM receipts WHERE id = ?').get(id)
  }

  purgeOlderThan(cutoff: number): number {
    return this.#db.query('DELETE FROM receipts WHERE created_at < ?').run(cutoff).changes
  }
}
