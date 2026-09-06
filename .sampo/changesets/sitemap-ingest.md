---
npm/indexnow-relay: minor (Added)
---

Bulk ingestion via `POST /v1/sitemap`: point the relay at a sitemap or
sitemap index and it fetches server-side (timeouts, byte/document/URL
caps), extracts every `<loc>` (entity + CDATA aware, follows indexes
breadth-first), and submits through the same all-or-nothing pipeline as
`POST /v1/urls` with one receipt. Fetch failures, unusable documents,
and cap overruns map to 502 / 400 / 413.
