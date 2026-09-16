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
// IndexNow keys are 8-128 characters of letters, digits, and hyphens. The
// original value is preserved verbatim - never lowercased or trimmed -
// because the key file on the origin must match byte for byte.
const INDEXNOW_KEY_PATTERN = /^[A-Za-z0-9-]{8,128}$/
const DEFAULT_KEY_PATH = '/{key}.txt'
const DEFAULT_MIN_RESUBMIT_INTERVAL_MS = 300_000

export const DEFAULT_QUEUE_CONFIG: Readonly<NormalizedQueueConfig> = {
  batchWindowMs: 5_000,
  maxCoalesceDelayMs: 30_000,
  maxBatchSize: 1_000,
  maxConcurrentSites: 4,
  pollIntervalMs: 250,
  // Total attempts including the first send; a URL exhausting these becomes
  // a dead letter.
  maxAttempts: 10,
  backoffBaseMs: 30_000,
  backoffMaxMs: 900_000,
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
      `sites.${host}.key: invalid IndexNow key. Keys must be 8-128 characters of letters, ` +
        'digits, or hyphens (generate one with `openssl rand -hex 16`).',
    )
  }
  return key
}

/**
 * Validates `keyPath` as a path on the origin site and returns it with the
 * derived key-file scope: the directory holding the key file. IndexNow lets
 * a key file at `/catalog/{key}.txt` authorize only URLs under `/catalog/`;
 * the scope is compared on path-segment boundaries (`/catalog` matches
 * `/catalog` and `/catalog/...`, never `/catalogue`). An empty scope means
 * the whole site.
 */
function normalizeKeyPath(
  keyPath: string | undefined,
  host: string,
  key: string,
): { keyPath: string; keyScopeDir: string } {
  const resolved = keyPath ?? DEFAULT_KEY_PATH
  const placeholder = '{key}'
  const placeholderCount = resolved.split(placeholder).length - 1
  const placeholderAt = resolved.indexOf(placeholder)
  if (
    !resolved.startsWith('/') ||
    placeholderCount !== 1 ||
    resolved.includes('\\') ||
    resolved.indexOf('/', placeholderAt) !== -1 ||
    /%2f|%5c/i.test(resolved) ||
    /[?#\u0000-\u001f\u007f]/.test(resolved) ||
    resolved.split('/').includes('..')
  ) {
    throw new ConfigError(
      `sites.${host}.keyPath must be a plain path on this site: it must start with "/", ` +
        'contain the {key} placeholder exactly once in the final path segment, and carry no ' +
        'query, fragment, backslash, encoded separator, control character, or ".." segment.',
    )
  }

  const substituted = resolved.replace(placeholder, key)
  // the key value itself can complete an encoded separator across the
  // placeholder boundary (key "2f..." after a literal '%')
  if (/%2f|%5c/i.test(substituted)) {
    throw new ConfigError(
      `sites.${host}.keyPath must not produce an encoded path separator once the key is substituted.`,
    )
  }
  let keyLocation: URL
  try {
    keyLocation = new URL(`https://${host}${substituted}`)
  } catch {
    throw new ConfigError(`sites.${host}.keyPath does not form a usable key location URL.`)
  }
  // The built URL must round-trip to the configured path; anything the URL
  // parser would rewrite (dot segments are rejected above; non-ASCII or
  // whitespace would be percent-encoded and no longer match the origin file)
  // is refused instead of silently changing meaning. The resolved path is
  // deliberately kept out of the message - it embeds the secret key.
  if (keyLocation.hostname !== host || keyLocation.pathname !== substituted) {
    throw new ConfigError(
      `sites.${host}.keyPath must stay a plain, already-encoded path on "${host}" ` +
        '(non-ASCII or whitespace would be rewritten by the URL parser).',
    )
  }

  // The placeholder sits in the final segment, so its directory is the key
  // file's directory: exactly the scope IndexNow grants. Percent escapes are
  // canonicalized to uppercase hex (RFC 3986 comparison form) so the runtime
  // scope prefix check matches URLs regardless of escape casing.
  const scopeEnd = resolved.lastIndexOf('/')
  const scopeDir = scopeEnd <= 0 ? '' : resolved.slice(0, scopeEnd)
  return { keyPath: resolved, keyScopeDir: canonicalizeEscapes(scopeDir) }
}

/** Upper-cases the hex digits of every percent escape (RFC 3986 canonical form). */
function canonicalizeEscapes(path: string): string {
  return path.replace(/%[0-9a-fA-F]{2}/g, (escape) => escape.toUpperCase())
}

function normalizeQueue(input: QueueConfigInput | undefined): NormalizedQueueConfig {
  const merged: NormalizedQueueConfig = {
    ...DEFAULT_QUEUE_CONFIG,
    ...definedEntries(input),
  }

  // A raised default base must not break a config that only pins the
  // ceiling: keep the default base at or below an explicitly supplied max.
  if (input?.backoffBaseMs === undefined && merged.backoffMaxMs < DEFAULT_QUEUE_CONFIG.backoffBaseMs) {
    merged.backoffBaseMs = merged.backoffMaxMs
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
    const { keyPath, keyScopeDir } = normalizeKeyPath(advanced?.keyPath ?? input.defaults?.keyPath, host, key)

    sites[host] = {
      host,
      key,
      keyPath,
      keyScopeDir,
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

  const webhookFromConfig =
    input.notifications?.webhookUrl === undefined ? undefined : resolveSecret(input.notifications.webhookUrl, 'notifications.webhookUrl')
  const webhookUrl = webhookFromConfig ?? process.env['INDEXNOW_WEBHOOK_URL'] ?? null

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
    notifications: { webhookUrl, format: input.notifications?.format ?? 'auto' },
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
      // store the normalized, de-duplicated hostnames so case or trailing-dot
      // variations in the config cannot slip past the runtime includes() check
      const normalizedScope = [...new Set(siteScope.map((rawHost) => normalizeHostname(rawHost)))]
      for (const host of normalizedScope) {
        if (!(host in sites)) {
          throw new ConfigError(`auth.tokens.${id}.sites: "${host}" is not configured in sites.`)
        }
      }
      tokens.push({ id, value: resolvedValue, sites: normalizedScope })
      return
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
