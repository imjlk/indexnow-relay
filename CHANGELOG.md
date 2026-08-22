# indexnow-relay

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

