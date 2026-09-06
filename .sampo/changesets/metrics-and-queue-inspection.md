---
npm/indexnow-relay: minor (Added)
---

Observability and queue inspection:

- `GET /metrics` (unrestricted token): Prometheus text exposition with
  queue gauges per site/status, next-due timestamps, submission batch
  counters, and build info.
- `GET /v1/admin/queue?site=&status=&limit=`: per-URL queue listing with
  attempts, due times, and last errors.
- Query strings now coerce to typed inputs (SmartCoercionHandlerPlugin),
  also fixing latent coercion gaps on the batches/dead-letters filters.
