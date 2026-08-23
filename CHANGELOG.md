# indexnow-relay

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

