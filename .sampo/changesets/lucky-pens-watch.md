---
npm/indexnow-relay: patch (Fixed)
---

Queue: submissions that arrive while an earlier change for the same URL is
in flight are no longer lost. Successful delivery used to delete the queue
row unconditionally, dropping the newer change; it now deletes only rows
that still match the claim-time revision and keeps newer revisions queued
for a later batch. Retry waits now act as a delivery floor that
resubmissions cannot shorten, pending resubmissions no longer reset attempt
counts, and an explicit `event` on a resubmission updates the stored
metadata. Queue state transitions (claim, success, failure) are single
SQLite transactions with notifications and logging after commit. Also fixes
the scheduler launching deliveries before `start()` when woken by a
submission. Existing databases upgrade in place (migration 0002 preserves
ongoing retry waits).
