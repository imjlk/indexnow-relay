# indexnow-relay

[![CI](https://github.com/imjlk/indexnow-relay/actions/workflows/ci.yml/badge.svg)](https://github.com/imjlk/indexnow-relay/actions/workflows/ci.yml)
[![Release](https://github.com/imjlk/indexnow-relay/actions/workflows/release.yml/badge.svg)](https://github.com/imjlk/indexnow-relay/actions/workflows/release.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
![Image](https://img.shields.io/badge/image-ghcr.io-imjlk%2Findexnow--relay-2496ed)

A self-hosted [IndexNow](https://www.indexnow.org/) relay for any number of
sites. Submit URLs once; the relay batches, coalesces, retries, and delivers
them to IndexNow per host — with a persistent SQLite queue that survives
restarts and crashes.

Built as a reference application for a modern Bun-native stack:
**TypeScript 7 (ttsc) · typia · oRPC v2 · Bun.serve · bun:sqlite**.

```
Client ──POST /v1/urls──▶ relay ──batch per host──▶ api.indexnow.org
                          │
                          └─ SQLite: queue, leases, receipts, dead letters
```

## Why

- **One endpoint for all your sites.** POST URLs for `www.example.com`,
  `docs.example.com`, and `blog.example.com` in one request; the relay groups
  by host and sends one IndexNow batch per site.
- **No target ids anywhere.** The hostname *is* the identity — in the config,
  the API, and the database.
- **Durable.** URLs wait in SQLite, not memory. Restart or crash mid-flight
  and leases are recovered automatically on boot.
- **Batching and coalescing.** A short batch window groups concurrent
  submissions; duplicate submissions within the window (or within the
  resubmit interval after a successful send) collapse into one delivery.
- **Retries with backoff, dead letters, and an operator API.** 429/5xx and
  network errors retry with exponential backoff; 4xx answers (e.g. an invalid
  key) go to a inspectable dead-letter list you can requeue.
- **Small attack surface.** Tokens and IndexNow keys come from environment
  variables only — they never touch SQLite, logs, or API responses. The
  runtime image is distroless (~110 MB) with no shell or package manager.

## Quickstart (Docker)

IndexNow requires a key file on **each site's origin** at a known location.
Generate a key per site and serve its text at the `keyPath`:

```bash
openssl rand -hex 16   # e.g. 3f2b8c1d4e5f60718293a4b5c6d7e8f9
# serve the key string at https://www.example.com/3f2b8c1d4e5f60718293a4b5c6d7e8f9.txt
```

Create `relay.config.ts` (see [`relay.config.example.ts`](relay.config.example.ts))
and an `.env` (see [`.env.example`](.env.example)):

```ts
import { defineConfig, env } from 'indexnow-relay/config'

export default defineConfig({
  auth: env('INDEXNOW_RELAY_TOKEN'),
  sites: {
    'www.example.com': env('INDEXNOW_KEY_WWW_EXAMPLE_COM'),
    'docs.example.com': {
      key: env('INDEXNOW_KEY_DOCS_EXAMPLE_COM'),
      keyPath: '/.well-known/{key}.txt',
    },
  },
})
```

Run it:

```bash
docker run -d --name indexnow-relay \
  -p 3000:3000 \
  --env-file .env \
  -v "$PWD/relay.config.ts:/app/relay.config.ts:ro" \
  -v indexnow-relay-data:/app/data \
  ghcr.io/imjlk/indexnow-relay:latest
```

Or with [`docker-compose.yml`](docker-compose.yml): `docker compose up -d`.

> The config file's import path depends on where it runs:
> `'indexnow-relay/config'` inside containers, `'./src/config/index.ts'`
> for repo development, `'./dist/config/index.js'` for a local production
> build.

Submit URLs:

```bash
curl -X POST http://localhost:3000/v1/urls \
  -H "Authorization: Bearer $INDEXNOW_RELAY_TOKEN" \
  -H 'content-type: application/json' \
  -d '{
    "urls": [
      "https://www.example.com/posts/hello-world",
      "https://docs.example.com/guide/quickstart"
    ],
    "event": "updated"
  }'
```

```json
{
  "receiptId": "01M0N7VN62553JC9WZ17AHT6KH",
  "received": 2,
  "enqueued": 2,
  "coalesced": 0,
  "sites": [
    { "host": "www.example.com", "enqueued": 1, "coalesced": 0 },
    { "host": "docs.example.com", "enqueued": 1, "coalesced": 0 }
  ]
}
```

Open `http://localhost:3000/` for interactive API docs, and
`http://localhost:3000/openapi.json` for the raw OpenAPI 3.1 document.

## Configuration

`relay.config.ts` is typed by `defineConfig` and validated at runtime with
typia. Secrets are always environment references created with `env('NAME')`
(an optional second argument is a fallback default).

### `auth`

```ts
// Single token (default): full access to every configured site.
auth: env('INDEXNOW_RELAY_TOKEN')

// Scoped tokens: each token may only touch its own sites.
// A token with sites: '*' can also call the admin API.
auth: {
  tokens: {
    admin: { value: env('INDEXNOW_ADMIN_TOKEN'), sites: '*' },
    docs: { value: env('INDEXNOW_DOCS_TOKEN'), sites: ['docs.example.com'] },
  },
}
```

### `sites`

Hostname-keyed. The hostname is the canonical site id.

```ts
sites: {
  // Shorthand: hostname -> key environment reference.
  'www.example.com': env('INDEXNOW_KEY_WWW_EXAMPLE_COM'),

  // Advanced: override any per-site behavior.
  'docs.example.com': {
    key: env('INDEXNOW_KEY_DOCS_EXAMPLE_COM'),
    keyPath: '/.well-known/{key}.txt', // default: '/{key}.txt'
    batchSize: 500,                    // URLs per IndexNow request (max 10,000)
    minResubmitIntervalMs: 600_000,    // suppress duplicate resubmissions
    enabled: true,                     // false = config present but inactive
  },
}
```

`keyLocation` is derived: `https://<host><keyPath with {key} replaced>` — you
never repeat the host or key.

### `queue` (all optional, defaults shown)

| Option | Default | Meaning |
| --- | --- | --- |
| `batchWindowMs` | `5_000` | How long a URL waits for more URLs before its site batch is sent |
| `maxCoalesceDelayMs` | `30_000` | Hard cap on how long a URL can be coalesced after first sight |
| `maxBatchSize` | `1_000` | Default URLs per IndexNow request |
| `maxConcurrentSites` | `4` | Sites drained in parallel |
| `pollIntervalMs` | `250` | Scheduler tick |
| `maxAttempts` | `5` | Retry attempts before a URL becomes a dead letter |
| `backoffBaseMs` / `backoffMaxMs` | `1_000` / `300_000` | Exponential backoff bounds (+ up to 30% jitter) |
| `httpTimeoutMs` | `10_000` | IndexNow request timeout |
| `retentionDays` | `30` | Receipts, batches, and dead letters older than this are purged |

### Environment variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `INDEXNOW_RELAY_CONFIG` | `./relay.config.ts` | Config file path |
| `INDEXNOW_RELAY_DB` | `data/relay.db` (image: `/app/data/relay.db`) | SQLite path |
| `PORT` / `HOST` | `3000` / `0.0.0.0` | HTTP listener |
| `LOG_LEVEL` | `info` | `debug` / `info` / `warn` / `error` |
| `INDEXNOW_ENDPOINT` | `https://api.indexnow.org/indexnow` | Shared IndexNow endpoint |

## API

All endpoints require `Authorization: Bearer <token>`. Full schemas live in
the OpenAPI document (`/openapi.json`, interactive docs at `/`).

| Method | Path | Purpose |
| --- | --- | --- |
| POST | `/v1/urls` | Submit URLs across any number of configured sites |
| GET | `/v1/receipts/{id}` | Inspect a submission (`stillPending` shows remaining work) |
| GET | `/v1/admin/overview` | Queue depths and batch counters per site |
| GET | `/v1/admin/batches?site=&limit=` | Recent IndexNow submission attempts |
| GET | `/v1/admin/dead-letters?site=&limit=` | Dead-lettered URLs |
| POST | `/v1/admin/dead-letters/retry` | Requeue dead letters (`{ site?, urls? }`) |
| POST | `/v1/admin/sites/{host}/pause` | Pause a site (`{ reason? }`) |
| POST | `/v1/admin/sites/{host}/resume` | Resume a site |
| GET | `/healthz`, `/readyz` | Liveness / readiness probes |

Submission is **all-or-nothing**: if any URL is invalid, any host is not
configured, or the token lacks access to any host, the whole request fails
(`INVALID_URL` 400, `UNKNOWN_SITE` 400, `FORBIDDEN_SITE` 403) and nothing is
enqueued.

Error semantics from IndexNow: `200`/`202` succeed (202 = key validation
pending), `429`/`5xx`/network errors retry with backoff, other `4xx` answers
fail permanently into dead letters.

## Operations

- **Crash safety** — on boot, leases and in-flight batches from a previous
  process are recovered; queued URLs resume automatically.
- **Pause** — `POST /v1/admin/sites/www.example.com/pause` stops deliveries
  for that site while still accepting (and queueing) submissions.
- **Dead letters** — inspect via `/v1/admin/dead-letters`, fix the cause
  (usually the key file), then requeue individually or per site.
- **Retention** — an hourly job purges receipts, batches, dead letters older
  than `retentionDays`, and resubmit-interval state that is no longer needed.
- **Logs** — one JSON object per line on stdout, secrets redacted.

## Development

Requires [Bun](https://bun.sh) >= 1.4.

```bash
bun install
bun run dev                # watch mode; config: ./relay.config.ts
bun test                   # 75 tests
bun run typecheck          # ttsc (TypeScript 7) + typia transform
bun run build              # production bundle -> dist/
bun start                  # run the bundle (NODE_ENV=production)
bun run generate:openapi   # refresh docs/openapi.json after contract changes
```

Local dev config (`relay.config.ts`, git-ignored) imports from
`./src/config/index.ts`:

```ts
import { defineConfig, env } from './src/config/index.ts'
```

### Architecture notes

- **TypeScript types are the single source of truth.** API DTOs are plain
  interfaces; `typia.createValidateEquals<T>()` compiles strict validators,
  and `typia.json.schema<T>()` compiles the matching JSON Schema.
- `src/schema/define-typia-schema.ts` combines both artifacts into one object
  implementing **Standard Schema V1** *and* **Standard JSON Schema V1**, so
  oRPC v2 validates through Standard Schema and generates real OpenAPI
  schemas (never the empty `{}` fallback).
- The typia transformer runs in every path: dev/tests via
  `scripts/preload.ts` (`Bun.plugin` + `@ttsc/unplugin/bun`), production via
  `Bun.build` with the same plugin — the distroless image ships only the
  bundled output.
- Secrets (tokens, IndexNow keys) exist only in normalized in-memory config;
  the SQLite schema has nowhere to put them by design.

```
src/
├─ server.ts / app.ts      entry + wiring (health probes, shutdown)
├─ api/                    oRPC v2 contracts, typia schemas, router, auth
├─ schema/                 typia <-> Standard Schema / JSON Schema bridge
├─ config/                 relay.config.ts loading, secrets, normalization
├─ core/                   URL normalization, sites, enqueue service, ULIDs
├─ db/                     bun:sqlite, migrations, repositories
├─ queue/                  scheduler, worker drains, leases, retry, recovery
├─ indexnow/               client, payload, response policy
└─ observability/          JSON logger (redaction), health
```

## License

[MIT](LICENSE)
