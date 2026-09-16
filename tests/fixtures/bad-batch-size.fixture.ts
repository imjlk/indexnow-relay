import { defineConfig, env } from '../../src/config/index.ts'

// Invalid on purpose: 1.5 is inside the batch-size range but is not an
// integer, so loading this config must fail startup validation.
export default defineConfig({
  auth: env('INDEXNOW_RELAY_FIXTURE_TOKEN'),
  defaults: { batchSize: 1.5 },
  sites: { 'www.example.com': env('INDEXNOW_RELAY_FIXTURE_KEY') },
})
