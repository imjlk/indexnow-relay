---
npm/indexnow-relay: patch
---

Reject invalid batch-size configuration before starting the relay.

Prevent late responses from leases that no longer own queued URLs from
updating per-URL delivery timestamps.

Retain newly exhausted dead letters from their failure transition time,
rather than their original submission time.
