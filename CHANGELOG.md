# indexnow-relay

## 0.5.0 — 2026-09-16

### Fixed

- [0ee3a8a](https://github.com/imjlk/indexnow-relay/commit/0ee3a8ae733e33147c9823e7009e6dd5303ef7c2) Queue: submissions that arrive while an earlier change for the same URL is
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
  upgrade in place (migration 0002 preserves ongoing retry waits). — Thanks @imjlk!
- [f050643](https://github.com/imjlk/indexnow-relay/commit/f0506431773b2e5bd62f1e2339cd04ec346c7413) Ops hardening: `@orpc/json-schema` (imported directly by the app) is now
  declared as a direct dependency instead of resolving transitively, and the
  container healthcheck probes the `PORT` the server actually listens on
  (default 3000) instead of hard-coded 3000. CI smoke tests now cover the
  deployment boundaries — environment-variable configuration, a queued URL and
  its Retry-After site cooldown surviving a process restart, an in-place
  upgrade from a schema-v1
  database, config-file-plus-`INDEXNOW_SITES` failing fast, a non-default port,
  and the built image reaching `healthy` on an overridden port. README
  deployment docs split the env-var and config-file options into runnable
  examples and add single-instance, upgrade (stop → back up volume → start →
  verify), and data-volume guidance. — Thanks @imjlk!

### Changed

- [b4a6491](https://github.com/imjlk/indexnow-relay/commit/b4a6491c179b0db80ea852a60059543693fc232b) Behavior change: a resubmission arriving inside a site's resubmit interval
  after a successful send is no longer silently dropped. The relay now reserves
  exactly one deferred redelivery — a pending row whose delivery floor is the
  last success plus `minResubmitIntervalMs` — so the change stays queued for
  delivery once the interval passes, subject to the usual retry, pause, and
  site-cooldown scheduling. Repeated resubmissions merge into
  that reservation without postponing it, dead-row revival and mid-flight
  follow-ups get the same floor, and no automatic redelivery ever happens
  without a new submission. Receipt counters are now exact: creating a deferred
  reservation counts as `enqueued` (previously `coalesced`), so
  `received = enqueued + coalesced` always holds. — Thanks @imjlk!
- [5c1a702](https://github.com/imjlk/indexnow-relay/commit/5c1a70211572f94ee0100f7bfada4cd4de7aacb7) Retry handling now actually rests a failing site. A parseable `Retry-After`
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
  place (migration 0003). — Thanks @imjlk!
- [f87d9e6](https://github.com/imjlk/indexnow-relay/commit/f87d9e65d0baa5621fa174d8904183856b43e5c6) IndexNow keys are now accepted and preserved verbatim: 8–128 characters of
  letters, digits, or hyphens (previously hexadecimal only, silently
  lowercased). Deployments that relied on the lowercasing must confirm their
  origin key file matches the configured value byte for byte. `keyPath` is
  validated as a plain path on the site (one `{key}` placeholder; no query,
  fragment, backslash, control characters, or `..` segments) and scoped-token
  site lists are stored normalized and de-duplicated.
  
  New: a key file below a subdirectory (e.g. `keyPath: '/catalog/{key}.txt'`)
  now restricts that site to submitting URLs under `/catalog`, compared on
  path-segment boundaries per the IndexNow key-location rule; out-of-scope
  URLs are rejected as `INVALID_URL` all-or-nothing. Default examples no
  longer suggest `/.well-known/{key}.txt` (that path would silently restrict a
  site to the `.well-known` directory); the default remains `/{key}.txt`. — Thanks @imjlk!

### Added

- [c853a57](https://github.com/imjlk/indexnow-relay/commit/c853a5717c43e9881e7acc3266bbe5fe8b21514f) Receipts now expose `pendingLastReferenced` — how many distinct URLs are
  currently pending (delivery-leased rows included) with this receipt as their
  latest reference. It replaces `stillPending` (kept as a deprecated alias
  returning the same value) with a name that says what the number actually is:
  the count is not a delivery verdict, and zero can mean delivered,
  dead-lettered, or superseded by a newer receipt — documentation now points to
  the operations API for outcomes. The admin overview also gains per-site
  `retryNotBefore` (ISO instant of an active Retry-After/backoff cooldown, null
  when none), distinct from `nextDueAt`, which remains the queue's stored due
  time. — Thanks @imjlk!

## 0.4.0 — 2026-09-06

### Added

- [3d5d9cb](https://github.com/imjlk/indexnow-relay/commit/3d5d9cb6f33a7cfc179bbab9e8a88b168b6cfa80) Dead-letter webhook notifications: when URLs become dead letters (permanent
  IndexNow failure or exhausted retries) the relay fires one webhook so the
  failure surfaces immediately. Configure via `notifications.webhookUrl` in
  relay.config.ts or the `INDEXNOW_WEBHOOK_URL` environment variable; unset
  disables it. Payloads adapt to Slack, Discord, or generic JSON webhooks
  (auto-detected from the URL host, overridable with `format`), carry no
  secrets, and delivery is fire-and-forget with bounded retries. — Thanks @imjlk!

## 0.3.0 — 2026-09-06

### Added

- [dd84546](https://github.com/imjlk/indexnow-relay/commit/dd845461e8cb1759411047026894b3c19cc29438) Bulk ingestion via `POST /v1/sitemap`: point the relay at a sitemap or
  sitemap index and it fetches server-side (timeouts, byte/document/URL
  caps), extracts every `<loc>` (entity + CDATA aware, follows indexes
  breadth-first), and submits through the same all-or-nothing pipeline as
  `POST /v1/urls` with one receipt. Fetch failures, unusable documents,
  and cap overruns map to 502 / 400 / 413. — Thanks @imjlk!
- [dd84546](https://github.com/imjlk/indexnow-relay/commit/dd845461e8cb1759411047026894b3c19cc29438) Observability and queue inspection:
  
  - `GET /metrics` (unrestricted token): Prometheus text exposition with
    queue gauges per site/status, next-due timestamps, submission batch
    counters, and build info.
  - `GET /v1/admin/queue?site=&status=&limit=`: per-URL queue listing with
    attempts, due times, and last errors.
  - Query strings now coerce to typed inputs (SmartCoercionHandlerPlugin),
    also fixing latent coercion gaps on the batches/dead-letters filters. — Thanks @imjlk!

## 0.2.2 — 2026-09-06

### Changed

- [369d71e](https://github.com/imjlk/indexnow-relay/commit/369d71e1fc24c1748377f69932bb74932c12ebef) Dependency updates: typia 14.0.5, ttsc toolchain (@ttsc/lint,
  @ttsc/evidence, @ttsc/unplugin, ttsc) 0.29.0, @types/bun 1.4.1. No API
  or behavior change; the full gate suite (types, lint + evidence, tests,
  build, image build) passes on the new versions. — Thanks @imjlk!

## 0.2.1 — 2026-08-23

### Fixed

- [8c12333](https://github.com/imjlk/indexnow-relay/commit/8c12333313b6409f39363571c6dc779e4992d69e) Parse numeric `limit` query parameters on the admin batches and dead-letter endpoints while preserving range validation. — Thanks @imjlk!

## 0.2.0 — 2026-08-23

### Added

- [8297dd5](https://github.com/imjlk/indexnow-relay/commit/8297dd5dda944f12202c2fff3aeaff725b45c17e) Coolify one-file deployment and environment-variable configuration.
  
  - `INDEXNOW_SITES`: configure sites without a relay.config.ts - the same
    `sites` object as JSON, plus `INDEXNOW_RELAY_TOKEN` for auth. A config
    file and `INDEXNOW_SITES` together is a loud configuration conflict;
    errors never echo the (secret) JSON value.
  - New `docker-compose.coolify.yml` built on Coolify Magic Environment
    Variables: the only required input is `INDEXNOW_SITES` (store it as a
    Secret). The API token comes from `SERVICE_PASSWORD_64_RELAY`, the
    public URL from `SERVICE_URL_RELAY_8080`, and no host ports are
    published.
  - Health probes at `/health/live` and `/health/ready` (`/healthz` and
    `/readyz` remain as aliases).
  - Container data directory normalized to `/data` (was `/app/data`); mount
    volumes there. Startup logs now list site hostnames. — Thanks @imjlk!

## 0.1.0 — 2026-08-22

### Added

- [c83a9e9](https://github.com/imjlk/indexnow-relay/commit/c83a9e93aca5b2e44e931c4fc375da76bcec0d6b) Initial release.
  
  - Submit URLs for any number of configured sites to `POST /v1/urls`; the relay
    groups by host and delivers one IndexNow batch per site (all-or-nothing
    validation, receipt per submission).
  - Persistent SQLite queue with batching, coalescing, resubmit suppression,
    lease-based crash recovery, retry with exponential backoff, and dead
    letters with an operator API (overview, batches, pause/resume, requeue).
  - Single or scoped bearer tokens; secrets live only in environment
    variables - never in the database, logs, or API responses.
  - OpenAPI 3.1 document with real typia-generated schemas plus interactive
    docs, health probes, JSON structured logging with redaction.
  - One `ttsc` gate for types, lint, and an evidence graph: every requirement
    section in docs/REQUIREMENTS.md and every OpenAPI operation must be cited
    by the code that owns it.
  - Sampo-managed releases: changesets open release PRs that bump versions,
    regenerate the changelog, tag vX.Y.Z, and publish the multi-arch GHCR
    image.
  - Distroless multi-arch Docker image (~110 MB, non-root, no node_modules at
    runtime) published to GHCR. — Thanks @imjlk!

