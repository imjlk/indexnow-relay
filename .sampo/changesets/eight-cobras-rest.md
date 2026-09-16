---
npm/indexnow-relay: minor (Changed)
---

Behavior change: a resubmission arriving inside a site's resubmit interval
after a successful send is no longer silently dropped. The relay now reserves
exactly one deferred redelivery — a pending row whose delivery floor is the
last success plus `minResubmitIntervalMs` — so the change stays queued for
delivery once the interval passes, subject to the usual retry, pause, and
site-cooldown scheduling. Repeated resubmissions merge into
that reservation without postponing it, dead-row revival and mid-flight
follow-ups get the same floor, and no automatic redelivery ever happens
without a new submission. Receipt counters are now exact: creating a deferred
reservation counts as `enqueued` (previously `coalesced`), so
`received = enqueued + coalesced` always holds.
