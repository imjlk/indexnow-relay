---
npm/indexnow-relay: minor (Added)
---

Receipts now expose `pendingLastReferenced` — how many distinct URLs are
currently pending (delivery-leased rows included) with this receipt as their
latest reference. It replaces `stillPending` (kept as a deprecated alias
returning the same value) with a name that says what the number actually is:
the count is not a delivery verdict, and zero can mean delivered,
dead-lettered, or superseded by a newer receipt — documentation now points to
the operations API for outcomes. The admin overview also gains per-site
`retryNotBefore` (ISO instant of an active Retry-After/backoff cooldown, null
when none), distinct from `nextDueAt`, which remains the queue's stored due
time.
