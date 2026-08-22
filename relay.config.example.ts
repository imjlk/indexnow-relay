/**
 * relay.config.ts example.
 *
 * Copy to `relay.config.ts` (git-ignored) and fill in your hosts.
 * Generate IndexNow keys with: openssl rand -hex 16
 *
 * Import path by environment:
 * - Inside this repository (dev / tests):   './src/config/index.ts'
 * - Local production run (`bun dist/...`):  './dist/config/index.js'
 * - Docker (config mounted at /app):        'indexnow-relay/config'
 */
import { defineConfig, env } from 'indexnow-relay/config'

export default defineConfig({
  // One bearer token for everything. For scoped tokens see the README.
  auth: env('INDEXNOW_RELAY_TOKEN'),

  sites: {
    // The common case: hostname -> key environment variable.
    'www.example.com': env('INDEXNOW_KEY_WWW_EXAMPLE_COM'),

    // Advanced: custom key file path, batch size, and resubmit interval.
    'docs.example.com': {
      key: env('INDEXNOW_KEY_DOCS_EXAMPLE_COM'),
      keyPath: '/.well-known/{key}.txt',
      batchSize: 500,
      minResubmitIntervalMs: 600_000,
    },
  },

  // Optional defaults applied to every site:
  // defaults: {
  //   keyPath: '/{key}.txt',
  //   batchSize: 1_000,
  //   minResubmitIntervalMs: 300_000,
  // },

  // Optional queue tuning (defaults shown):
  // queue: {
  //   batchWindowMs: 5_000,
  //   maxCoalesceDelayMs: 30_000,
  //   maxBatchSize: 1_000,
  //   maxConcurrentSites: 4,
  //   maxAttempts: 5,
  //   backoffBaseMs: 1_000,
  //   backoffMaxMs: 300_000,
  //   httpTimeoutMs: 10_000,
  //   retentionDays: 30,
  // },

  // database: { path: 'data/relay.db' },
  // server: { host: '0.0.0.0', port: 3000 },
  // indexnow: { endpoint: 'https://api.indexnow.org/indexnow' },
})
