import { defineConfig, env } from '../../src/config/index.ts'

/**
 * End-to-end fixture for loadRelayConfig tests. Environment references are
 * resolved at load time (not import time), so different tests can exercise
 * different environment states against this same file.
 */
export default defineConfig({
  auth: env('INDEXNOW_RELAY_FIXTURE_TOKEN'),
  sites: {
    'www.example.com': env('INDEXNOW_RELAY_FIXTURE_KEY'),
  },
})
