/**
 * Per-site delivery cooldown. A retryable failure (429/5xx) makes the site
 * itself wait before its next batch, not just the failed URLs: IndexNow's
 * `Retry-After` names the site, so hammering it with other due URLs would
 * just draw more 429s. The wait survives restarts; `resume` clears manual
 * pauses only, never this cooldown.
 */

export const MIGRATION_0003 = /* sql */ `
ALTER TABLE site_state ADD COLUMN retry_not_before_at INTEGER NOT NULL DEFAULT 0;
`
