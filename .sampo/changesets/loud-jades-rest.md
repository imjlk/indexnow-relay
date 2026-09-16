---
npm/indexnow-relay: minor (Removed)
---

Remove `POST /v1/sitemap` and all server-side sitemap fetching (remote
downloads, `<loc>` extraction, sitemap-index traversal, the dedicated error
codes, and the sitemap-specific fetch injection).

The relay's job is now exactly: accept authenticated URL lists, keep them
safe, and deliver them to IndexNow. Existing callers must prepare their URL
lists and submit them through `POST /v1/urls` before upgrading - split at
10,000 URLs per request; receipts acknowledge queueing, not indexing. Keep
each origin site's `sitemap.xml` published for crawlers; use change records
(not sitemap diffs) for deleted URLs. Queued URLs, receipts, and the SQLite
database remain compatible. Deployment order for auto-updating
environments: migrate callers first, then roll out this version.
