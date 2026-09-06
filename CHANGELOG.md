# indexnow-relay

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

