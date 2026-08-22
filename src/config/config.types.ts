import type { tags } from 'typia'

/**
 * Reference to a secret stored in an environment variable.
 * Created with {@link env}(); never inline real secrets in the config file.
 */
export interface EnvSecretReference {
  readonly $secret: 'env'
  readonly name: string
  readonly default?: string | undefined
}

/** Either an environment reference or a literal value (dev convenience). */
export type SecretValue = EnvSecretReference | string

export interface SiteAdvancedConfig {
  /** IndexNow key for this host. */
  key: SecretValue
  /**
   * Path on the origin site where the key file is served.
   * Must contain the `{key}` placeholder. Default: `/{key}.txt`
   */
  keyPath?: string
  /** Max URLs per IndexNow request for this site. Default: 1000 */
  batchSize?: number & tags.Minimum<1> & tags.Maximum<10_000>
  /** Minimum interval before the same URL is resubmitted. Default: 300_000 */
  minResubmitIntervalMs?: number & tags.Minimum<0>
  /** Set to false to stop submitting for this site. Default: true */
  enabled?: boolean
}

export type SiteConfigInput = SecretValue | SiteAdvancedConfig

export interface SiteDefaults {
  keyPath?: string
  batchSize?: number
  minResubmitIntervalMs?: number
}

export interface ScopedTokenConfig {
  value: SecretValue
  /** `'*'` grants all configured sites; otherwise a list of hostnames. */
  sites: '*' | string[]
}

export interface AdvancedAuthConfig {
  tokens: Record<string, ScopedTokenConfig>
}

export interface QueueConfigInput {
  /** How long a URL waits for more URLs before its site batch is sent. */
  batchWindowMs?: number & tags.Minimum<0>
  /** Hard cap on how long a URL can be coalesced after first sight. */
  maxCoalesceDelayMs?: number & tags.Minimum<0>
  maxBatchSize?: number & tags.Minimum<1> & tags.Maximum<10_000>
  maxConcurrentSites?: number & tags.Minimum<1>
  pollIntervalMs?: number & tags.Minimum<50>
  maxAttempts?: number & tags.Minimum<1>
  backoffBaseMs?: number & tags.Minimum<0>
  backoffMaxMs?: number & tags.Minimum<0>
  httpTimeoutMs?: number & tags.Minimum<100>
  retentionDays?: number & tags.Minimum<1>
}

export interface RelayConfigInput {
  /**
   * Single token (`SecretValue`) or scoped tokens
   * (`AdvancedAuthConfig`) used to authorize `POST /v1/urls`.
   */
  auth: SecretValue | AdvancedAuthConfig
  /** Hostname-keyed site map. The hostname IS the site identity. */
  sites: Record<string, SiteConfigInput>
  defaults?: SiteDefaults
  queue?: QueueConfigInput
  database?: { path?: string }
  server?: { host?: string; port?: number & tags.Minimum<1> & tags.Maximum<65_535> }
  indexnow?: { endpoint?: string }
}

// ---------------------------------------------------------------------------
// Normalized (runtime) configuration - plain data so typia can revalidate it.
// ---------------------------------------------------------------------------

export interface NormalizedSite {
  host: string
  key: string
  keyPath: string
  keyLocation: string
  enabled: boolean
  batchSize: number
  minResubmitIntervalMs: number
}

export interface NormalizedToken {
  id: string
  value: string
  sites: '*' | string[]
}

export interface NormalizedQueueConfig {
  batchWindowMs: number
  maxCoalesceDelayMs: number
  maxBatchSize: number
  maxConcurrentSites: number
  pollIntervalMs: number
  maxAttempts: number
  backoffBaseMs: number
  backoffMaxMs: number
  httpTimeoutMs: number
  retentionDays: number
}

export interface NormalizedRelayConfig {
  auth: { tokens: NormalizedToken[] }
  sites: Record<string, NormalizedSite>
  queue: NormalizedQueueConfig
  databasePath: string
  server: { host: string; port: number }
  indexnowEndpoint: string
}
