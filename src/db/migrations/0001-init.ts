/**
 * Initial schema.
 *
 * Site configuration, keys, and bearer tokens intentionally do NOT live here:
 * they come from relay.config.ts + environment only, so a leaked database
 * file never leaks IndexNow keys or API tokens.
 */

export const MIGRATION_0001 = /* sql */ `
CREATE TABLE receipts (
  id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  received INTEGER NOT NULL,
  enqueued INTEGER NOT NULL,
  coalesced INTEGER NOT NULL,
  sites TEXT NOT NULL
);

CREATE TABLE pending_urls (
  site_host TEXT NOT NULL,
  url TEXT NOT NULL,
  event_type TEXT,
  first_seen_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  due_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  lease_id TEXT,
  lease_until INTEGER,
  last_receipt_id TEXT,
  last_error TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'dead')),
  PRIMARY KEY (site_host, url)
) WITHOUT ROWID;

CREATE INDEX idx_pending_urls_due
  ON pending_urls (due_at)
  WHERE status = 'pending' AND lease_id IS NULL;

CREATE TABLE submission_state (
  site_host TEXT NOT NULL,
  url TEXT NOT NULL,
  sent_at INTEGER NOT NULL,
  PRIMARY KEY (site_host, url)
) WITHOUT ROWID;

CREATE TABLE submission_batches (
  id TEXT PRIMARY KEY,
  site_host TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('in_flight', 'succeeded', 'retry_scheduled', 'dead')),
  url_count INTEGER NOT NULL,
  attempt INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  completed_at INTEGER,
  retry_at INTEGER,
  http_status INTEGER,
  error_code TEXT,
  error_message TEXT
);

CREATE INDEX idx_submission_batches_site
  ON submission_batches (site_host, created_at DESC);

CREATE TABLE site_state (
  site_host TEXT PRIMARY KEY,
  paused INTEGER NOT NULL DEFAULT 0,
  paused_at INTEGER,
  paused_reason TEXT,
  updated_at INTEGER NOT NULL
);
`
