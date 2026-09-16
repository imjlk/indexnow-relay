---
npm/indexnow-relay: minor (Changed)
---

Retry handling now actually rests a failing site. A parseable `Retry-After`
(integer seconds or HTTP date) on a `429`/`5xx` answer sets the retry time to
the later of the relay's own backoff and the server's requested wait, and the
whole site — not just the failed URLs — cools down until then. The cooldown is
persisted, so new submissions, scheduler wake-ups, process restarts, and
`resume` cannot bypass it; a pause or cooldown arriving mid-drain stops the
next batch while the in-flight request finishes. Classification now retries
on every `5xx` (previously only 500/502/503/504). A retryable batch whose
every URL exhausted its budget is recorded `dead` instead of
`retry_scheduled`.

Changed defaults: `maxAttempts` `5` → `10` (total attempts including the
first send), `backoffBaseMs` `1_000` → `30_000`, `backoffMaxMs` `300_000` →
`900_000`. Explicit settings are untouched. Existing databases upgrade in
place (migration 0003).
