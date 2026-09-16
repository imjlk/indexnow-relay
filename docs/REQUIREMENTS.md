# indexnow-relay — Requirements

The reviewed requirement layer for the relay. Every H2 section below is an
obligation: the implementation cites each one from source with `@evidence`
tags (see `lint.config.ts`), so a requirement without a citation fails the
build. Fulfilled requirements live here in the operator's words; the code
answers for them.

## Site configuration

Sites are configured in `relay.config.ts`, keyed by bare hostname — the
hostname is the canonical site identity everywhere (config, API, database);
no separate target ids exist. The common case is one line per site mapping
the hostname to an IndexNow key environment reference. Keys are 8-128
characters of letters, digits, or hyphens, validated and preserved verbatim -
never lowercased or trimmed, since the key file must match byte for byte. An
advanced object form overrides the key file path (`keyPath`, default
`/{key}.txt`, must contain `{key}` exactly once in its final path segment;
queries, fragments, backslashes, encoded separators, control characters, and
`..` segments are rejected), batch size, minimum resubmit interval, and
enabled flag. Batch sizes are integers between 1 and 10,000 (the protocol's
per-request cap) on every path that sets one — per-site, site defaults, and
the queue default — and resubmit intervals are finite non-negative
milliseconds; invalid values fail startup with the field's path instead of
being corrected or reaching the scheduler. A key file below a subdirectory limits the site to submitting
URLs under that directory (prefix including the path separator), and error
messages never embed the key or its derived location.
The full key location URL is derived, never repeated by the operator. Auth is
one bearer token by default, or a map of scoped tokens where each token names
the hosts it may touch (stored normalized and de-duplicated, so case or
trailing-dot variations cannot slip past the runtime check);
`sites: '*'` is unrestricted. Secrets come only from
environment references or dev-convenience literals, are resolved at load
time, and the normalized configuration is validated again at runtime.

Environments without a config file (containers, Coolify) configure sites
through the `INDEXNOW_SITES` environment variable: the same `sites` object
as JSON (shorthand or advanced form), with `INDEXNOW_RELAY_TOKEN` for auth
and default values everywhere else. The two sources are mutually exclusive:
a config file plus `INDEXNOW_SITES` is a startup error (never a silent
merge), a missing config file plus `INDEXNOW_SITES` uses the environment,
and neither present is a startup error naming both options. Errors about
`INDEXNOW_SITES` never echo its contents because the value is secret;
startup logs list hostnames only.

## URL submission

`POST /v1/urls` accepts 1–10,000 absolute `http`/`https` URLs across any
number of configured hosts in one request, plus an optional `event`
(`created`/`updated`/`deleted`) used for operational context only. URLs are
normalized: fragments stripped, default ports removed, empty paths become
`/`, hosts lowercased. A URL outside its site's key-file directory scope, or carrying an encoded
path separator, is an `INVALID_URL` like any other invalid URL. Validation is all-or-nothing —
if any URL is invalid (`INVALID_URL` 400), any host is unconfigured
(`UNKNOWN_SITE` 400), or the token lacks access to any host
(`FORBIDDEN_SITE` 403), nothing is enqueued.
Accepted submissions return a receipt with per-host `enqueued` and
`coalesced` counts, and all writes land in a single SQLite transaction.
Duplicates within one request and resubmissions while a URL is still pending
coalesce instead of enqueueing again. A resubmission inside the site's
resubmit interval after a successful send is not dropped: the relay reserves
exactly one deferred redelivery whose delivery floor is the last success plus
the interval; the reservation stays queued and becomes eligible for delivery
once the floor passes (still subject to retries, pauses, and site cooldowns).
Repeated resubmissions merge into that reservation without postponing it, and
no redelivery ever happens without a new submission. Dead-row revival applies the same floor when a
recent success exists. Each pending URL carries a `revision` bumped by every
external resubmission, so a change that lands while an earlier change for
the same URL is in flight is preserved: the earlier delivery completes, and
the newer revision stays queued for the next batch instead of being deleted
by the finishing delivery. An explicit `event` on a resubmission replaces
the stored one (pending coalescing and dead-row revival alike); omission
keeps it. Resubmitting a pending URL never resets its attempt count or
shortens an ongoing retry wait. Counters are exact: `enqueued` counts fresh
queue rows (new, revived, or deferred reservations), `coalesced` counts
merges into existing rows, and `received = enqueued + coalesced` always
holds.

## Receipts

`GET /v1/receipts/{id}` returns what was received, enqueued, and coalesced
per host, plus `pendingLastReferenced` — how many distinct URLs are
currently pending (leased rows included) with this receipt as their latest
reference. A receipt is a record of what was accepted plus that limited
queue reference, never a delivery verdict: `pendingLastReferenced` 0 can
mean delivered, dead-lettered, or simply superseded by a newer receipt, so
no field claims completion. `stillPending` remains as a deprecated alias.
Delivery outcomes live in the operations API (queue, batches,
dead-letters). Receipts are retained for `queue.retentionDays`. A scoped
token cannot learn that a receipt exists if any involved host is outside
its scope: the response is 404, not 403.

## Delivery semantics

The relay submits to the IndexNow shared endpoint (configurable) with the
site's key and derived key location, one JSON batch per site per attempt,
bounded by the site's batch size (never above the protocol's 10,000). The
operator must serve each key file on the site's origin at the configured
`keyPath`; the relay never hosts key files. Response policy: `200` and `202`
succeed (`202` means key validation is still pending and is recorded as
such), `429`/`5xx`/network failures retry, all other `4xx` answers fail
permanently.

## Sitemap ingestion

`POST /v1/sitemap` accepts the absolute http(s) URL of a remote sitemap or
sitemap index. The relay fetches it server-side (timeout, per-document and
total byte caps, document and URL-count caps), extracts every `<loc>` with
XML entity and CDATA decoding, follows sitemap indexes breadth-first up to a
bounded depth, and feeds the resulting URLs into the exact same submission
pipeline as `POST /v1/urls` - all-or-nothing validation, automatic host
grouping, coalescing, and one receipt. A sitemap containing any
unconfigured or unauthorized host rejects the whole request; no partial
ingestion. Fetch failures, unusable documents, and cap overruns are distinct
errors (502 / 400 / 413).

## Persistent queue and recovery

All queue state lives in SQLite (`pending_urls` keyed by `(site_host, url)`,
receipts, batch audit rows, per-site pause state, resubmit-interval state).
Batching waits `queue.batchWindowMs` for more URLs, never coalesces a URL
longer than `queue.maxCoalesceDelayMs` after first sight, and drains at most
`queue.maxConcurrentSites` sites in parallel. Claims are leased; on boot (or
when a lease expires) stale leases and in-flight batch rows from a previous
process are recovered and work resumes. Delivery state changes are atomic:
claiming URLs and opening their batch audit row is one transaction, and so is
each outcome (ownership check, delete-or-keep, sent-state, and batch close,
or retry/dead-letter plus batch close). A success response applies per-URL
delivery state only to claim items the finishing lease still owns — a lease
that expired and was swept or re-claimed mid-flight changes neither the
queue rows nor their delivery history; the batch audit row still records the
HTTP outcome, and structured logs distinguish applied from stale URLs. HTTP calls happen between transactions;
notifications and logging fire only after the state change commits. A
scheduled retry sets a delivery floor that later coalescing cannot pull
forward. IndexNow keys and bearer tokens are never stored in the database: a
leaked database file leaks URLs and metadata only.

## Retries and dead letters

Retryable failures (`429`, any `5xx`, network errors) back off exponentially
with jitter (`queue.backoffBaseMs` doubling up to `queue.backoffMaxMs`). When
the answer carries a parseable `Retry-After` (integer seconds or an HTTP
date), the retry waits until the later of the relay's own backoff and the
server's requested time; `backoffMaxMs` never shortens a server-requested
wait. A retryable failure also cools down the whole site — not just the
failed URLs — until the retry time, persisted across restarts; pauses and
cooldowns are re-checked before every batch claim, and `resume` clears a
manual pause but never a cooldown. After `queue.maxAttempts` total attempts
(including the first send) a URL becomes a dead letter with its last error;
permanent `4xx` failures dead-letter immediately. A retryable batch in which
every URL exhausted its budget is recorded dead, not as a scheduled retry.
Dead letters are listed via the operations API and can be requeued
individually, per site, or all at once. A dead letter's retention anchor is
its failure-transition time — the moment it became a dead letter, whether by
retry exhaustion or permanent failure — not its original submission time, so
a URL that waited out long backoffs is never purged the instant it dead
letters. Dead letters older than `queue.retentionDays` are purged.

## Authentication and authorization

Every endpoint requires `Authorization: Bearer <token>`; tokens are compared
in constant time. Unrestricted tokens administer the operations API; scoped
tokens may only submit and view receipts for their own hosts. Bearer tokens
and IndexNow keys exist only in normalized in-memory configuration.

## Operations API

Unrestricted tokens get: a queue overview (per-site pending/dead counts,
next due time, active delivery-cooldown time `retryNotBefore`, batch
counters), a queue listing with per-URL attempts and
due times (filterable by site and status), recent submission batches with
outcomes, dead-letter listing and requeue, and per-site pause/resume that
survives restarts. Pausing stops deliveries while still accepting and
queueing submissions.

## Observability and secret hygiene

`/health/live` reports process liveness and `/health/ready` checks the
scheduler and the SQLite database (unauthenticated; `/healthz` and `/readyz`
remain as legacy aliases). Neither probe calls the IndexNow API. `/metrics`
serves Prometheus text exposition - queue gauges and batch counters by site,
plus build info - gated behind an unrestricted token. Logs are one JSON
object per line with secret-named fields redacted, and startup logs list
site hostnames only.
Structured request failures and submission outcomes are logged without
secrets. `/` serves interactive API docs and `/openapi.json` the OpenAPI 3.1
document.

## Notifications

When URLs become dead letters - a permanent IndexNow failure (invalid key,
rejected batch) or exhausted retry attempts - the relay fires one webhook
notification so the failure surfaces immediately instead of days later. The
webhook URL comes from `notifications.webhookUrl` in the config or the
`INDEXNOW_WEBHOOK_URL` environment variable; unset means disabled. Payloads
are dialect-adaptive (`generic` JSON, Slack `{"text"}`, Discord
`{"content"}`, auto-detected from the URL host with a config override), carry
counts/reasons/identifiers only - never secrets and never the affected URLs
(those stay behind the admin API) - and delivery is fire-and-forget with
bounded retries: it never blocks the queue and its failure is logged, not
raised.

## Toolchain contract

TypeScript interfaces are the single source of truth for API DTOs. All
external input is validated with `typia.createValidateEquals` (strict:
unknown properties rejected), and every oRPC v2 contract consumes the typia
validator through a Standard Schema V1 + Standard JSON Schema V1 bridge, so
the generated OpenAPI document carries real schemas — never an empty `{}`
and never an unresolved `$ref`. The typia transformer runs in every
execution path: dev and tests through the ttsc runtime preload, production
through the bundled build; `ttsc --noEmit` gates types, lint, and the
evidence graph together. The shipped container is distroless, runs as
non-root, and carries no runtime `node_modules`.
