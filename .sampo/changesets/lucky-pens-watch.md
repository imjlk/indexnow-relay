---
npm/indexnow-relay: patch (Fixed)
---

Queue: submissions that arrive while an earlier change for the same URL is
in flight are no longer lost. Successful delivery used to delete the queue
row unconditionally, dropping the newer change; it now deletes only rows
that still match the claim-time revision and keeps newer revisions queued
for a later batch. A resubmission arriving while that follow-up delivery is
itself in flight now coalesces into the pending row (the resubmit-interval
gate is only applied when no queue row exists), so it can no longer be
suppressed and then dropped by the follow-up's success. Retry waits now act
as a delivery floor that resubmissions cannot shorten, and pending
resubmissions keep their attempt counts (now pinned by tests). An explicit
`event` on a resubmission updates the stored metadata for pending rows and
dead-row revivals; omission keeps the previous value. Queue state
transitions (claim, success, failure) are single SQLite transactions with
notifications and logging after commit. Also fixes the scheduler launching
deliveries before `start()` when woken by a submission. Existing databases
upgrade in place (migration 0002 preserves ongoing retry waits).
