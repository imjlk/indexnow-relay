---
npm/indexnow-relay: patch (Fixed)
---

Ops hardening: `@orpc/json-schema` (imported directly by the app) is now
declared as a direct dependency instead of resolving transitively, and the
container healthcheck probes the `PORT` the server actually listens on
(default 3000) instead of hard-coded 3000. CI smoke tests now cover the
deployment boundaries — environment-variable configuration, a queue and site
cooldown surviving a process restart, an in-place upgrade from a schema-v1
database, config-file-plus-`INDEXNOW_SITES` failing fast, a non-default port,
and the built image reaching `healthy` on an overridden port. README
deployment docs split the env-var and config-file options into runnable
examples and add single-instance, upgrade (stop → back up volume → start →
verify), and data-volume guidance.
