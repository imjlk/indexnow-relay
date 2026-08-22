import { afterAll, describe, expect, test } from 'bun:test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  ConfigError,
  env,
  loadRelayConfig,
  normalizeHostname,
  normalizeRelayConfig,
  resolveSecret,
} from '../src/config/index.ts'
import type { RelayConfigInput } from '../src/config/index.ts'

const baseConfig = (overrides: Partial<RelayConfigInput> = {}): RelayConfigInput => ({
  auth: 'operator-token-000000000001',
  sites: { 'www.example.com': 'a1b2c3d4e5f60718' },
  ...overrides,
})

describe('normalizeHostname', () => {
  test('lowercases and trims', () => {
    expect(normalizeHostname('  WWW.Example.COM ')).toBe('www.example.com')
  })

  test('accepts a URL prefix and extracts the hostname', () => {
    expect(normalizeHostname('https://blog.example.com/some/path')).toBe('blog.example.com')
  })

  test('strips a trailing dot', () => {
    expect(normalizeHostname('example.com.')).toBe('example.com')
  })

  test('rejects ports, paths, and garbage', () => {
    expect(() => normalizeHostname('example.com:8443')).toThrow(ConfigError)
    expect(() => normalizeHostname('not a host')).toThrow(ConfigError)
    expect(() => normalizeHostname('')).toThrow(ConfigError)
  })
})

describe('resolveSecret', () => {
  const original = process.env['INDEXNOW_TEST_SECRET']

  afterAll(() => {
    if (original === undefined) delete process.env['INDEXNOW_TEST_SECRET']
    else process.env['INDEXNOW_TEST_SECRET'] = original
  })

  test('reads from the environment', () => {
    process.env['INDEXNOW_TEST_SECRET'] = 'found-it'
    expect(resolveSecret(env('INDEXNOW_TEST_SECRET'), 'test')).toBe('found-it')
  })

  test('falls back to a default', () => {
    delete process.env['INDEXNOW_TEST_SECRET']
    expect(resolveSecret(env('INDEXNOW_TEST_SECRET', 'fallback'), 'test')).toBe('fallback')
  })

  test('throws a helpful error when missing', () => {
    delete process.env['INDEXNOW_TEST_SECRET']
    expect(() => resolveSecret(env('INDEXNOW_TEST_SECRET'), 'test')).toThrow(/INDEXNOW_TEST_SECRET/)
  })
})

describe('normalizeRelayConfig', () => {
  test('expands the one-line shorthand site', () => {
    const config = normalizeRelayConfig(baseConfig())
    const site = config.sites['www.example.com']!

    expect(site.host).toBe('www.example.com')
    expect(site.key).toBe('a1b2c3d4e5f60718')
    expect(site.keyPath).toBe('/{key}.txt')
    expect(site.keyLocation).toBe('https://www.example.com/a1b2c3d4e5f60718.txt')
    expect(site.enabled).toBe(true)
    expect(site.batchSize).toBe(1000)
  })

  test('applies per-site overrides and defaults', () => {
    const config = normalizeRelayConfig(
      baseConfig({
        defaults: { batchSize: 500 },
        sites: {
          'www.example.com': { key: 'a1b2c3d4e5f60718', batchSize: 100 },
          'docs.example.com': { key: 'a1b2c3d4e5f60719', keyPath: '/.well-known/{key}.txt' },
        },
      }),
    )
    expect(config.sites['www.example.com']!.batchSize).toBe(100)
    expect(config.sites['docs.example.com']!.batchSize).toBe(500)
    expect(config.sites['docs.example.com']!.keyLocation).toBe(
      'https://docs.example.com/.well-known/a1b2c3d4e5f60719.txt',
    )
  })

  test('wraps a single token as the default admin token', () => {
    const config = normalizeRelayConfig(baseConfig())
    expect(config.auth.tokens).toHaveLength(1)
    expect(config.auth.tokens[0]!.sites).toBe('*')
  })

  test('rejects an invalid IndexNow key', () => {
    expect(() => normalizeRelayConfig(baseConfig({ sites: { 'www.example.com': 'not-hex' } }))).toThrow(ConfigError)
  })

  test('rejects a keyPath without the {key} placeholder', () => {
    expect(() =>
      normalizeRelayConfig(
        baseConfig({ sites: { 'www.example.com': { key: 'a1b2c3d4e5f60718', keyPath: '/key.txt' } } }),
      ),
    ).toThrow(ConfigError)
  })

  test('rejects hosts that normalize to duplicates', () => {
    expect(() =>
      normalizeRelayConfig(
        baseConfig({
          sites: {
            'www.example.com': 'a1b2c3d4e5f60718',
            'WWW.EXAMPLE.COM': 'a1b2c3d4e5f60719',
          },
        }),
      ),
    ).toThrow(ConfigError)
  })

  test('rejects scoped tokens referencing unknown sites', () => {
    expect(() =>
      normalizeRelayConfig(
        baseConfig({
          auth: { tokens: { limited: { value: 'scoped-token-0000000001', sites: ['nope.example.com'] } } },
        }),
      ),
    ).toThrow(ConfigError)
  })

  test('rejects an empty sites map', () => {
    expect(() => normalizeRelayConfig(baseConfig({ sites: {} }))).toThrow(ConfigError)
  })

  test('rejects backoff ceiling below its base', () => {
    expect(() => normalizeRelayConfig(baseConfig({ queue: { backoffBaseMs: 1000, backoffMaxMs: 10 } }))).toThrow(
      ConfigError,
    )
  })
})

describe('loadRelayConfig (end to end)', () => {
  // The fixture is checked in: ttsc's runtime plugin compiles one immutable
  // session of project files at process start, so config files used under the
  // preload plugin must exist before the process boots (true for dev and this
  // fixture; production containers import the mounted config with Bun's
  // native TS support instead).
  const fixturePath = join(import.meta.dir, 'fixtures', 'env-config.fixture.ts')

  test('loads a relay.config.ts and validates it at runtime', async () => {
    process.env['INDEXNOW_RELAY_FIXTURE_TOKEN'] = 'operator-token-000000000001'
    process.env['INDEXNOW_RELAY_FIXTURE_KEY'] = 'a1b2c3d4e5f60718'

    const { config } = await loadRelayConfig(fixturePath)
    expect(config.sites['www.example.com']!.key).toBe('a1b2c3d4e5f60718')
    expect(config.auth.tokens[0]!.value).toBe('operator-token-000000000001')

    delete process.env['INDEXNOW_RELAY_FIXTURE_TOKEN']
    delete process.env['INDEXNOW_RELAY_FIXTURE_KEY']
  })

  test('fails clearly when a required environment variable is missing', async () => {
    delete process.env['INDEXNOW_RELAY_FIXTURE_TOKEN']
    process.env['INDEXNOW_RELAY_FIXTURE_KEY'] = 'a1b2c3d4e5f60718'
    await expect(loadRelayConfig(fixturePath)).rejects.toThrow(/INDEXNOW_RELAY_FIXTURE_TOKEN/)
    delete process.env['INDEXNOW_RELAY_FIXTURE_KEY']
  })
})
