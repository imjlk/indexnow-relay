/**
 * Delivery-cycle columns for `pending_urls`.
 *
 * `revision` is a per-URL generation counter: every external resubmission
 * bumps it, so a worker can tell whether the row it leased still describes
 * the change it claimed, even when both receipts landed in the same
 * millisecond. `not_before_at` is a delivery floor: once a retry schedules a
 * wait, no later coalescing may pull `due_at` earlier than that floor.
 *
 * Rows already waiting out a retry at upgrade time keep their `due_at` as
 * the floor so an upgrade cannot shorten an in-progress backoff.
 */

export const MIGRATION_0002 = /* sql */ `
ALTER TABLE pending_urls ADD COLUMN revision INTEGER NOT NULL DEFAULT 1;
ALTER TABLE pending_urls ADD COLUMN not_before_at INTEGER NOT NULL DEFAULT 0;

UPDATE pending_urls SET not_before_at = due_at
WHERE status = 'pending' AND attempts > 0;
`
