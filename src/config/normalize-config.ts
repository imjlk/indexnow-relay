import type {
  NormalizedQueueConfig,
  NormalizedRelayConfig,
  NormalizedSite,
  NormalizedToken,
  QueueConfigInput,
  RelayConfigInput,
  SecretValue,
  SiteAdvancedConfig,
  SiteConfigInput,
} from './config.types.ts'
import { isEnvSecretReference, resolveSecret } from './resolve-secrets.ts'

export class ConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ConfigError'
  }
}

const HOSTNAME_PATTERN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/
const INDEXNOW_KEY_PATTERN = /^[0-9a-f]{8,128}$/i
const DEFAULT_KEY_PATH = '/{key}.txt'
const DEFAULT_MIN_RESUBMIT_INTERVAL_MS = 300_000

export const DEFAULT_QUEUE_CONFIG: Readonly<NormalizedQueueConfig> = {
  batchWindowMs: 5_000,
  maxCoalesceDelayMs: 30_000,
  maxBatchSize: 1_000,
  maxConcurrentSites: 4,
  pollIntervalMs: 250,
  maxAttempts: 5,
  backoffBaseMs: 1_000,
  backoffMaxMs: 300_000,
  httpTimeoutMs: 10_000,
  retentionDays: 30,
}

/**
 * Normalizes a user-supplied hostname: lowercases it, tolerates a URL prefix
 * (`https://blog.example.com/`), strips a trailing dot, and rejects anything
 * that is not a bare hostname.
 */
export function normalizeHostname(raw: string): string {
  let candidate = raw.trim().toLowerCase()

  if (candidate.includes('://')) {
    try {
      candidate = new URL(candidate).hostname
    } catch {
      throw new ConfigError(`Invalid site key "${raw}": not a parsable URL.`)
    }
  } else if (candidate.includes('/')) {
    candidate = candidate.split('/')[0]!
  }

  if (candidate.endsWith('.')) {
    candidate = candidate.slice(0, -1)
  }

  if (candidate.length === 0 || !HOSTNAME_PATTERN.test(candidate) || candidate.includes(':')) {
    throw new ConfigError(
      `Invalid hostname "${raw}": site keys must be bare hostnames (e.g. "www.example.com"), ` +
        'without scheme, path, or port.',
    )
  }

  return candidate
}

function isAdvancedSiteConfig(value: SiteConfigInput): value is SiteAdvancedConfig {
  return typeof value === 'object' && value !== null && !isEnvSecretReference(value as SecretValue)
}

function resolveSiteKey(value: SiteConfigInput, host: string): string {
  const key = resolveSecret(isAdvancedSiteConfig(value) ? value.key : value, `sites.${host}.key`)
  if (!INDEXNOW_KEY_PATTERN.test(key)) {
    throw new ConfigError(
      `sites.${host}.key: invalid IndexNow key. Keys must be 8-128 hexadecimal characters ` +
        '(generate one with `openssl rand -hex 16`).',
    )
  }
  return key.toLowerCase()
}

function normalizeKeyPath(keyPath: string | undefined, host: string): string {
  const resolved = keyPath ?? DEFAULT_KEY_PATH
  if (!resolved.startsWith('/') || !resolved.includes('{key}')) {
    throw new ConfigError(
      `sites.${host}.keyPath: "${resolved}" must start with "/" and contain the {key} placeholder.`,
    )
  }
  return resolved
}

function normalizeQueue(input: QueueConfigInput | undefined): NormalizedQueueConfig {
  const merged: NormalizedQueueConfig = {
    ...DEFAULT_QUEUE_CONFIG,
    ...definedEntries(input),
  }

  if (merged.maxCoalesceDelayMs < merged.batchWindowMs) {
    throw new ConfigError(
      `queue.maxCoalesceDelayMs (${merged.maxCoalesceDelayMs}) must be >= queue.batchWindowMs (${merged.batchWindowMs}).`,
    )
  }
  if (merged.backoffMaxMs < merged.backoffBaseMs) {
    throw new ConfigError('queue.backoffMaxMs must be >= queue.backoffBaseMs.')
  }

  return merged
}

function definedEntries<T extends object>(input: T | undefined): Partial<T> {
  if (!input) return {}
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined) out[key] = value
  }
  return out as Partial<T>
}

/**
 * Expands shorthand site entries, resolves environment secrets, validates all
 * cross-references, and produces the fully normalized runtime configuration.
 *
 * @evidence docs/REQUIREMENTS.md#site-configuration Turns the host-keyed user
 *           config (shorthand or advanced) into the normalized site registry
 *           with derived key locations and validated tokens.
 */
export function normalizeRelayConfig(input: RelayConfigInput): NormalizedRelayConfig {
  const siteEntries = Object.entries(input.sites ?? {})
  if (siteEntries.length === 0) {
    throw new ConfigError('sites: at least one site is required.')
  }

  const queue = normalizeQueue(input.queue)

  const sites: Record<string, NormalizedSite> = {}
  for (const [rawHost, siteInput] of siteEntries) {
    const host = normalizeHostname(rawHost)
    if (host in sites) {
      throw new ConfigError(`sites: duplicate host "${host}" after normalization.`)
    }

    const advanced = isAdvancedSiteConfig(siteInput) ? siteInput : undefined
    const key = resolveSiteKey(siteInput, rawHost)
    const keyPath = normalizeKeyPath(advanced?.keyPath ?? input.defaults?.keyPath, host)

    sites[host] = {
      host,
      key,
      keyPath,
      keyLocation: `https://${host}${keyPath.replace('{key}', key)}`,
      enabled: advanced?.enabled ?? true,
      batchSize: advanced?.batchSize ?? input.defaults?.batchSize ?? queue.maxBatchSize,
      minResubmitIntervalMs:
        advanced?.minResubmitIntervalMs ??
        input.defaults?.minResubmitIntervalMs ??
        DEFAULT_MIN_RESUBMIT_INTERVAL_MS,
    }
  }

  const tokens = normalizeAuth(input.auth, sites)

  const databasePath = input.database?.path ?? process.env['INDEXNOW_RELAY_DB'] ?? 'data/relay.db'
  const host = process.env['HOST'] ?? input.server?.host ?? '0.0.0.0'
  const port = Number(process.env['PORT'] ?? input.server?.port ?? 3000)
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new ConfigError(`server.port: "${port}" is not a valid port.`)
  }

  const indexnowEndpoint =
    input.indexnow?.endpoint ?? process.env['INDEXNOW_ENDPOINT'] ?? 'https://api.indexnow.org/indexnow'

  return {
    auth: { tokens },
    sites,
    queue,
    databasePath,
    server: { host, port },
    indexnowEndpoint,
  }
}

function normalizeAuth(
  auth: RelayConfigInput['auth'],
  sites: Record<string, NormalizedSite>,
): NormalizedToken[] {
  const tokens: NormalizedToken[] = []

  const addToken = (id: string, value: SecretValue, siteScope: '*' | string[]): void => {
    const resolvedValue = resolveSecret(value, `auth.tokens.${id}.value`)
    if (resolvedValue.length < 16) {
      throw new ConfigError(`auth.tokens.${id}.value: bearer tokens must be at least 16 characters.`)
    }

    if (siteScope !== '*') {
      for (const rawHost of siteScope) {
        const host = normalizeHostname(rawHost)
        if (!(host in sites)) {
          throw new ConfigError(`auth.tokens.${id}.sites: "${host}" is not configured in sites.`)
        }
      }
    }

    tokens.push({ id, value: resolvedValue, sites: siteScope })
  }

  if (auth === undefined || auth === null) {
    throw new ConfigError('auth is required (a bearer token or a tokens map).')
  }

  if (typeof auth === 'string' || isEnvSecretReference(auth)) {
    addToken('default', auth, '*')
    return tokens
  }

  const entries = Object.entries(auth.tokens ?? {})
  if (entries.length === 0) {
    throw new ConfigError('auth.tokens: at least one token is required.')
  }
  for (const [id, token] of entries) {
    if (typeof token !== 'object' || token === null) {
      throw new ConfigError(`auth.tokens.${id}: expected { value, sites }.`)
    }
    addToken(id, token.value, token.sites)
  }
  return tokens
}
