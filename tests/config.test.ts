import { afterAll, describe, expect, test } from 'bun:test'
import { join, resolve } from 'node:path'

import {
  buildEnvSitesConfig,
  ConfigError,
  decideConfigSource,
  env,
  EnvSitesError,
  loadRelayConfig,
  normalizeHostname,
  resolveConfigPath,
  normalizeRelayConfig,
  parseEnvSites,
  resolveSecret,
} from '../src/config/index.ts'
import type { RelayConfigInput } from '../src/config/index.ts'

const baseConfig = (overrides: Partial<RelayConfigInput> = {}): RelayConfigInput => ({
  auth: 'operator-token-000000000001',
  sites: { 'www.example.com': 'a1b2c3d4e5f60718' },
  ...overrides,
})

function captureConfigError(fn: () => unknown): ConfigError {
  try {
    fn()
  } catch (error) {
    return error as ConfigError
  }
  throw new Error('expected fn to throw')
}

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

  test('retry defaults give a patient, bounded budget', () => {
    const { queue } = normalizeRelayConfig(baseConfig())
    expect(queue.maxAttempts).toBe(10)
    expect(queue.backoffBaseMs).toBe(30_000)
    expect(queue.backoffMaxMs).toBe(900_000)
  })

  test('a ceiling-only queue override keeps a usable base', () => {
    // raising the default base must not turn an existing ceiling-only
    // config into a startup error
    const { queue } = normalizeRelayConfig(baseConfig({ queue: { backoffMaxMs: 10_000 } }))
    expect(queue.backoffBaseMs).toBe(10_000)
    expect(queue.backoffMaxMs).toBe(10_000)
  })

  test('rejects an invalid IndexNow key without echoing it', () => {
    for (const bad of ['not-hex', 'short', 'x'.repeat(129), 'has space', 'has_underscore']) {
      const error = captureConfigError(() => normalizeRelayConfig(baseConfig({ sites: { 'www.example.com': bad } })))
      expect(error).toBeInstanceOf(ConfigError)
      expect(error.message).not.toContain(bad)
    }
  })

  test('preserves mixed-case and hyphenated keys verbatim', () => {
    const key = 'My-Key-7f3A-000000000001'
    const config = normalizeRelayConfig(baseConfig({ sites: { 'www.example.com': key } }))
    expect(config.sites['www.example.com']!.key).toBe(key)
    expect(config.sites['www.example.com']!.keyLocation).toBe(`https://www.example.com/${key}.txt`)
  })

  test('derives the key-file scope from the keyPath directory', () => {
    const config = normalizeRelayConfig(
      baseConfig({
        sites: {
          'www.example.com': { key: 'a1b2c3d4e5f60718', keyPath: '/catalog/{key}.txt' },
          'docs.example.com': { key: 'a1b2c3d4e5f60719', keyPath: '/catalog/sub/{key}.txt' },
          'blog.example.com': 'a1b2c3d4e5f60711',
        },
      }),
    )
    expect(config.sites['www.example.com']!.keyScopeDir).toBe('/catalog')
    expect(config.sites['docs.example.com']!.keyScopeDir).toBe('/catalog/sub')
    expect(config.sites['blog.example.com']!.keyScopeDir).toBe('')
  })

  test('rejects confusing keyPath values without echoing the full path', () => {
    const badPaths = [
      'https://cdn.example.com/{key}.txt', // absolute URL, not a path
      '/{key}.txt?source=cfg',             // query
      '/{key}.txt#fragment',               // fragment
      '/catalog\\{key}.txt',                  // backslash
      '/catalog/{key}.txt/extra/{key}',    // two placeholders
      '/catalog/../{key}.txt',             // dot-dot segment
      '/cat alog/{key}.txt',               // whitespace (would be percent-encoded)
      '/no-placeholder.txt',               // missing placeholder
      '/catalog/%2f{key}.txt',             // encoded separator
      '/catalog/%5C{key}.txt',             // encoded backslash
    ]
    const key = 'a1b2c3d4e5f60718'
    // this fixture embeds the concrete key: redaction must cover it too
    const badPathsWithKey = [`/x-${key}/../{key}.txt`, ...badPaths]
    for (const keyPath of badPathsWithKey) {
      let message = ''
      try {
        normalizeRelayConfig(baseConfig({ sites: { 'www.example.com': { key, keyPath } } }))
      } catch (error) {
        message = (error as ConfigError).message
      }
      expect(message).not.toBe('')
      // neither the supplied path nor the resolved location (which embeds
      // the secret key) may surface
      expect(message).not.toContain(keyPath)
      expect(message).not.toContain(key)
    }
  })

  test('rejects encoded separators formed across the placeholder boundary', () => {
    // a key starting with "2f" completes an escaped slash after a literal %
    expect(() =>
      normalizeRelayConfig(
        baseConfig({ sites: { 'www.example.com': { key: '2fABCDEF000001', keyPath: '/catalog/private%{key}.txt' } } }),
      ),
    ).toThrow(ConfigError)
    expect(() =>
      normalizeRelayConfig(
        baseConfig({ sites: { 'www.example.com': { key: '5cABCDEF000001', keyPath: '/catalog/private%{key}.txt' } } }),
      ),
    ).toThrow(ConfigError)
  })

  test('scope directories are stored with canonical percent escapes', () => {
    const config = normalizeRelayConfig(
      baseConfig({ sites: { 'www.example.com': { key: 'a1b2c3d4e5f60718', keyPath: '/caf%c3%a9/{key}.txt' } } }),
    )
    expect(config.sites['www.example.com']!.keyScopeDir).toBe('/caf%C3%A9')
  })

  test('keeps the placeholder in the final path segment so the scope is the key directory', () => {
    for (const keyPath of ['/{key}/proof.txt', '/catalog/{key}/proof.txt']) {
      expect(() =>
        normalizeRelayConfig(baseConfig({ sites: { 'www.example.com': { key: 'a1b2c3d4e5f60718', keyPath } } })),
      ).toThrow(ConfigError)
    }
  })

  test('stores scoped token site lists normalized and de-duplicated', () => {
    const config = normalizeRelayConfig(
      baseConfig({
        auth: { tokens: { blog: { value: 'blog-token-0000000000001', sites: ['BLOG.Example.COM.', 'blog.example.com'] } } },
        sites: { 'blog.example.com': 'a1b2c3d4e5f60711' },
      }),
    )
    expect(config.auth.tokens[0]!.sites).toEqual(['blog.example.com'])
  })

  test('rejects invalid batch sizes on all three input paths', () => {
    for (const bad of [0, -1, 1.5, 10_001]) {
      const cases: Array<[string, Partial<RelayConfigInput>]> = [
        ['sites', { sites: { 'www.example.com': { key: 'a1b2c3d4e5f60718', batchSize: bad } } }],
        ['defaults', { defaults: { batchSize: bad } }],
        ['queue', { queue: { maxBatchSize: bad } }],
      ]
      for (const [label, overrides] of cases) {
        const error = captureConfigError(() => normalizeRelayConfig(baseConfig(overrides)))
        expect(error).toBeInstanceOf(ConfigError)
        expect(error.message).toMatch(/must be an integer between 1 and 10000/)
        expect(error.message.toLowerCase()).toContain(label === 'sites' ? 'sites' : label)
        void label
      }
    }
  })

  test('accepts the batch-size bounds on all three input paths', () => {
    for (const good of [1, 10_000]) {
      const viaSite = normalizeRelayConfig(baseConfig({ sites: { 'www.example.com': { key: 'a1b2c3d4e5f60718', batchSize: good } } }))
      expect(viaSite.sites['www.example.com']!.batchSize).toBe(good)
      const viaDefaults = normalizeRelayConfig(baseConfig({ defaults: { batchSize: good } }))
      expect(viaDefaults.sites['www.example.com']!.batchSize).toBe(good)
      const viaQueue = normalizeRelayConfig(baseConfig({ queue: { maxBatchSize: good } }))
      expect(viaQueue.queue.maxBatchSize).toBe(good)
      expect(viaQueue.sites['www.example.com']!.batchSize).toBe(good)
    }
  })

  test('omitted batch sizes keep the existing defaults and precedence', () => {
    const config = normalizeRelayConfig(baseConfig())
    expect(config.queue.maxBatchSize).toBe(1_000)
    expect(config.sites['www.example.com']!.batchSize).toBe(1_000)
    const withDefault = normalizeRelayConfig(baseConfig({ defaults: { batchSize: 500 } }))
    expect(withDefault.sites['www.example.com']!.batchSize).toBe(500)
  })

  test('a valid site override does not excuse an invalid defaults.batchSize', () => {
    const error = captureConfigError(() =>
      normalizeRelayConfig(
        baseConfig({
          defaults: { batchSize: 1.5 },
          sites: { 'www.example.com': { key: 'a1b2c3d4e5f60718', batchSize: 100 } },
        }),
      ),
    )
    expect(error).toBeInstanceOf(ConfigError)
    expect(error.message).toContain('defaults.batchSize')
  })

  test('rejects non-finite or negative resubmit intervals', () => {
    for (const bad of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
      for (const overrides of [
        { defaults: { minResubmitIntervalMs: bad } },
        { sites: { 'www.example.com': { key: 'a1b2c3d4e5f60718', minResubmitIntervalMs: bad } } },
      ] as Array<Partial<RelayConfigInput>>) {
        const error = captureConfigError(() => normalizeRelayConfig(baseConfig(overrides)))
        expect(error).toBeInstanceOf(ConfigError)
        expect(error.message).toMatch(/finite non-negative/)
      }
    }
    const zero = normalizeRelayConfig(baseConfig({ defaults: { minResubmitIntervalMs: 0 } }))
    expect(zero.sites['www.example.com']!.minResubmitIntervalMs).toBe(0)
  })

  test('loadRelayConfig rejects a bad defaults.batchSize file before serving', async () => {
    // checked-in fixture: ttsc's runtime plugin needs the file present at
    // process start (see the loadRelayConfig fixture note below)
    const configPath = join(import.meta.dir, 'fixtures', 'bad-batch-size.fixture.ts')
    process.env['INDEXNOW_RELAY_FIXTURE_TOKEN'] = 'operator-token-000000000001'
    process.env['INDEXNOW_RELAY_FIXTURE_KEY'] = 'a1b2c3d4e5f60718'
    try {
      const error = await loadRelayConfig(configPath).then(
        () => null,
        (e: unknown) => e,
      )
      expect(error).toBeInstanceOf(Error)
      const message = (error as Error).message
      expect(message).toContain('defaults.batchSize')
      expect(message).toMatch(/integer between 1 and 10000/)
      expect(message).not.toContain('operator-token-000000000001')
    } finally {
      delete process.env['INDEXNOW_RELAY_FIXTURE_TOKEN']
      delete process.env['INDEXNOW_RELAY_FIXTURE_KEY']
    }
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

describe('INDEXNOW_SITES environment configuration', () => {
  const SHORTHAND = JSON.stringify({
    'www.example.com': 'a1b2c3d4e5f60718',
    'docs.example.com': 'a1b2c3d4e5f60719',
  })

  test('parses the shorthand and advanced forms', () => {
    const shorthand = parseEnvSites(SHORTHAND)
    expect(shorthand['www.example.com']).toBe('a1b2c3d4e5f60718')

    const advanced = parseEnvSites(
      JSON.stringify({
        'www.example.com': 'a1b2c3d4e5f60718',
        'docs.example.com': { key: 'a1b2c3d4e5f60719', keyPath: '/.well-known/{key}.txt', batchSize: 500 },
      }),
    )
    expect(advanced['docs.example.com']).toEqual({
      key: 'a1b2c3d4e5f60719',
      keyPath: '/.well-known/{key}.txt',
      batchSize: 500,
    })
  })

  test('rejects invalid JSON without echoing the secret', () => {
    let message = ''
    try {
      parseEnvSites('{"www.example.com": "a1b2c3d4e5f6071')
    } catch (error) {
      message = error instanceof Error ? error.message : ''
    }
    expect(message).toContain('not valid JSON')
    expect(message).not.toContain('a1b2c3d4e5f6071')
  })

  test('rejects wrong shapes without echoing values', () => {
    let message = ''
    try {
      // key must be a string or env reference, not a number
      parseEnvSites(JSON.stringify({ 'www.example.com': { key: 12345 } }))
    } catch (error) {
      message = error instanceof Error ? error.message : ''
    }
    expect(message).toContain('invalid value')
    expect(message).not.toContain('12345')

    expect(() => parseEnvSites(JSON.stringify(['not', 'an', 'object']))).toThrow(EnvSitesError)
  })

  test('buildEnvSitesConfig yields a normalizable config', () => {
    const input = buildEnvSitesConfig(SHORTHAND)
    process.env['INDEXNOW_RELAY_TOKEN'] = 'operator-token-000000000001'
    const normalized = normalizeRelayConfig(input)
    expect(Object.keys(normalized.sites).sort()).toEqual(['docs.example.com', 'www.example.com'])
    expect(normalized.auth.tokens[0]!.value).toBe('operator-token-000000000001')
    delete process.env['INDEXNOW_RELAY_TOKEN']
  })

  test('source decision: file, env, conflict, and missing', () => {
    const base = { resolvedPath: '/x/relay.config.ts', explicit: false, fileExists: true, envSites: undefined }
    expect(decideConfigSource({ ...base, envSites: undefined }).kind).toBe('file')
    expect(decideConfigSource({ ...base, fileExists: false, envSites: SHORTHAND }).kind).toBe('env-sites')
    expect(decideConfigSource({ ...base, envSites: SHORTHAND }).kind).toBe('conflict')
    expect(decideConfigSource({ ...base, fileExists: false }).kind).toBe('missing')
    expect(decideConfigSource({ ...base, fileExists: false, explicit: true }).kind).toBe('explicit-missing')
    // empty string env counts as unset
    expect(decideConfigSource({ ...base, fileExists: false, envSites: '' }).kind).toBe('missing')
  })

  test('empty INDEXNOW_RELAY_CONFIG counts as unset (env-sites stays reachable)', async () => {
    const saved = process.env['INDEXNOW_RELAY_CONFIG']
    process.env['INDEXNOW_RELAY_CONFIG'] = ''
    expect(resolveConfigPath()).toBe(resolve('relay.config.ts'))
    if (saved === undefined) delete process.env['INDEXNOW_RELAY_CONFIG']
    else process.env['INDEXNOW_RELAY_CONFIG'] = saved
  })

  test('loadRelayConfig fails on file + INDEXNOW_SITES conflict', async () => {
    const configPath = join(import.meta.dir, 'fixtures', 'env-config.fixture.ts')
    process.env['INDEXNOW_SITES'] = SHORTHAND
    await expect(loadRelayConfig(configPath)).rejects.toThrow(/conflict/i)
    delete process.env['INDEXNOW_SITES']
  })

  test('loadRelayConfig fails with both options named when neither is present', async () => {
    const savedConfig = process.env['INDEXNOW_RELAY_CONFIG']
    const savedSites = process.env['INDEXNOW_SITES']
    delete process.env['INDEXNOW_RELAY_CONFIG']
    delete process.env['INDEXNOW_SITES']
    await expect(loadRelayConfig(join(import.meta.dir, '.no-such-dir', 'relay.config.ts'))).rejects.toThrow(
      /INDEXNOW_SITES/,
    )
    if (savedConfig !== undefined) process.env['INDEXNOW_RELAY_CONFIG'] = savedConfig
    if (savedSites !== undefined) process.env['INDEXNOW_SITES'] = savedSites
  })
})
