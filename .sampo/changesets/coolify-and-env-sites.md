---
npm/indexnow-relay: minor (Added)
---

Coolify one-file deployment and environment-variable configuration.

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
  volumes there. Startup logs now list site hostnames.
