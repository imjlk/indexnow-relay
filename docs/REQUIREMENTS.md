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
the hostname to an IndexNow key environment reference; an advanced object
form overrides the key file path (`keyPath`, default `/{key}.txt`, must
contain `{key}`), batch size, minimum resubmit interval, and enabled flag.
The full key location URL is derived, never repeated by the operator. Auth is
one bearer token by default, or a map of scoped tokens where each token names
the hosts it may touch; `sites: '*'` is unrestricted. Secrets come only from
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
`/`, hosts lowercased. Validation is all-or-nothing — if any URL is invalid
(`INVALID_URL` 400), any host is unconfigured (`UNKNOWN_SITE` 400), or the
token lacks access to any host (`FORBIDDEN_SITE` 403), nothing is enqueued.
Accepted submissions return a receipt with per-host `enqueued` and
`coalesced` counts, and all writes land in a single SQLite transaction.
Duplicates within a request, resubmissions while a URL is still pending, and
resubmissions within the site's resubmit interval after a successful send
coalesce instead of enqueueing again. A resubmitted dead URL is revived with
a fresh attempt budget.

## Receipts

`GET /v1/receipts/{id}` returns what was received, enqueued, and coalesced
per host, plus `stillPending` — how many of the receipt's URLs remain in the
queue. Receipts are retained for `queue.retentionDays`. A scoped token
cannot learn that a receipt exists if any involved host is outside its
scope: the response is 404, not 403.

## Delivery semantics

The relay submits to the IndexNow shared endpoint (configurable) with the
site's key and derived key location, one JSON batch per site per attempt,
bounded by the site's batch size (never above the protocol's 10,000). The
operator must serve each key file on the site's origin at the configured
`keyPath`; the relay never hosts key files. Response policy: `200` and `202`
succeed (`202` means key validation is still pending and is recorded as
such), `429`/`5xx`/network failures retry, all other `4xx` answers fail
permanently.

## Persistent queue and recovery

All queue state lives in SQLite (`pending_urls` keyed by `(site_host, url)`,
receipts, batch audit rows, per-site pause state, resubmit-interval state).
Batching waits `queue.batchWindowMs` for more URLs, never coalesces a URL
longer than `queue.maxCoalesceDelayMs` after first sight, and drains at most
`queue.maxConcurrentSites` sites in parallel. Claims are leased; on boot (or
when a lease expires) stale leases and in-flight batch rows from a previous
process are recovered and work resumes. IndexNow keys and bearer tokens are
never stored in the database: a leaked database file leaks URLs and metadata
only.

## Retries and dead letters

Retryable failures back off exponentially with jitter
(`queue.backoffBaseMs` doubling up to `queue.backoffMaxMs`). After
`queue.maxAttempts` attempts a URL becomes a dead letter with its last
error; permanent `4xx` failures dead-letter immediately. Dead letters are
listed via the operations API and can be requeued individually, per site, or
all at once. Dead letters older than `queue.retentionDays` are purged.

## Authentication and authorization

Every endpoint requires `Authorization: Bearer <token>`; tokens are compared
in constant time. Unrestricted tokens administer the operations API; scoped
tokens may only submit and view receipts for their own hosts. Bearer tokens
and IndexNow keys exist only in normalized in-memory configuration.

## Operations API

Unrestricted tokens get: a queue overview (per-site pending/dead counts,
next due time, batch counters), recent submission batches with outcomes,
dead-letter listing and requeue, and per-site pause/resume that survives
restarts. Pausing stops deliveries while still accepting and queueing
submissions.

## Observability and secret hygiene

`/health/live` reports process liveness and `/health/ready` checks the
scheduler and the SQLite database (unauthenticated; `/healthz` and `/readyz`
remain as legacy aliases). Neither probe calls the IndexNow API. Logs are one
JSON object per line with secret-named fields redacted, and startup logs list
site hostnames only.
Structured request failures and submission outcomes are logged without
secrets. `/` serves interactive API docs and `/openapi.json` the OpenAPI 3.1
document.

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
