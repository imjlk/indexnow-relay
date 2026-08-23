export { defineConfig, env } from './define-config.ts'
export {
  buildEnvSitesConfig,
  ConfigLoadError,
  decideConfigSource,
  ENV_CONFIG_VAR,
  ENV_SITES_VAR,
  loadRelayConfig,
  resolveConfigPath,
} from './load-config.ts'
export type { ConfigSourceDecision, ConfigSourceInput, LoadConfigResult } from './load-config.ts'
export { EnvSitesError, parseEnvSites } from './parse-env-sites.ts'
export { normalizeRelayConfig, normalizeHostname, ConfigError, DEFAULT_QUEUE_CONFIG } from './normalize-config.ts'
export { resolveSecret, SecretResolutionError } from './resolve-secrets.ts'
export type {
  AdvancedAuthConfig,
  EnvSecretReference,
  NormalizedQueueConfig,
  NormalizedRelayConfig,
  NormalizedSite,
  NormalizedToken,
  QueueConfigInput,
  RelayConfigInput,
  ScopedTokenConfig,
  SecretValue,
  SiteAdvancedConfig,
  SiteConfigInput,
  SiteDefaults,
} from './config.types.ts'
