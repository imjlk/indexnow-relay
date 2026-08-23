import { existsSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
import typia from 'typia'

import { normalizeRelayConfig } from './normalize-config.ts'
import type { NormalizedRelayConfig, RelayConfigInput, SiteConfigInput } from './config.types.ts'
import { parseEnvSites } from './parse-env-sites.ts'

const validateRawConfig = typia.createValidateEquals<RelayConfigInput>()
const validateNormalizedConfig = typia.createValidateEquals<NormalizedRelayConfig>()

export class ConfigLoadError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ConfigLoadError'
  }
}

export interface LoadConfigResult {
  config: NormalizedRelayConfig
  /** File path that was loaded, or the env var name for env-based config. */
  sourcePath: string
}

export const ENV_SITES_VAR = 'INDEXNOW_SITES'
export const ENV_CONFIG_VAR = 'INDEXNOW_RELAY_CONFIG'

export type ConfigSourceDecision =
  | { kind: 'file'; path: string }
  | { kind: 'env-sites' }
  | { kind: 'conflict'; path: string }
  | { kind: 'explicit-missing'; path: string }
  | { kind: 'missing' }

export interface ConfigSourceInput {
  /** Resolved config file path (explicit or default). */
  resolvedPath: string
  /** True when the path came from an argument or INDEXNOW_RELAY_CONFIG. */
  explicit: boolean
  fileExists: boolean
  /** INDEXNOW_SITES value; empty string counts as unset. */
  envSites: string | undefined
}

/**
 * Which configuration source to use:
 *
 * 1. a config file (explicit argument, INDEXNOW_RELAY_CONFIG, or the default
 *    relay.config.ts), or
 * 2. INDEXNOW_SITES (+ INDEXNOW_RELAY_TOKEN) when no file is present.
 *
 * Providing both is a configuration conflict and fails loudly - silently
 * merging file sites with env sites would make the effective site set
 * depend on merge order. An explicitly requested file that does not exist
 * also fails (typo protection) instead of falling back to the environment.
 */
export function decideConfigSource(input: ConfigSourceInput): ConfigSourceDecision {
  const envSitesSet = input.envSites !== undefined && input.envSites.length > 0

  if (input.fileExists && envSitesSet) {
    return { kind: 'conflict', path: input.resolvedPath }
  }
  if (input.fileExists) {
    return { kind: 'file', path: input.resolvedPath }
  }
  if (input.explicit) {
    return { kind: 'explicit-missing', path: input.resolvedPath }
  }
  if (envSitesSet) {
    return { kind: 'env-sites' }
  }
  return { kind: 'missing' }
}

export function resolveConfigPath(explicitPath?: string): string {
  const fromArg = explicitPath !== undefined && explicitPath.length > 0 ? explicitPath : undefined
  const fromEnv = process.env[ENV_CONFIG_VAR]
  const hasEnv = fromEnv !== undefined && fromEnv.length > 0
  return resolve(fromArg ?? (hasEnv ? fromEnv : undefined) ?? 'relay.config.ts')
}

/**
 * Builds a config input from INDEXNOW_SITES. Auth always comes from
 * INDEXNOW_RELAY_TOKEN; all other options (queue tuning, defaults, ...)
 * keep their defaults - a config file is still the way to set those.
 */
export function buildEnvSitesConfig(envSitesRaw: string): RelayConfigInput {
  const sites: Record<string, SiteConfigInput> = parseEnvSites(envSitesRaw)
  return {
    auth: { $secret: 'env', name: 'INDEXNOW_RELAY_TOKEN' },
    sites,
  }
}

/**
 * Loads the relay configuration from a config file or INDEXNOW_SITES (see
 * {@link decideConfigSource}), validates its shape (typia), resolves
 * environment secrets, normalizes it, and runtime-validates the result.
 */
export async function loadRelayConfig(explicitPath?: string): Promise<LoadConfigResult> {
  const configPath = resolveConfigPath(explicitPath)
  const configEnv = process.env[ENV_CONFIG_VAR]
  const decision = decideConfigSource({
    resolvedPath: configPath,
    // Empty strings count as unset: an empty INDEXNOW_RELAY_CONFIG (or
    // argument) must not turn the default path into an "explicit" one -
    // containers rely on the env-sites fallback when no file is mounted.
    explicit:
      (explicitPath !== undefined && explicitPath.length > 0) ||
      (configEnv !== undefined && configEnv.length > 0),
    fileExists: existsSync(configPath),
    envSites: process.env[ENV_SITES_VAR],
  })

  if (decision.kind === 'conflict') {
    throw new ConfigLoadError(
      `Configuration conflict: config file "${decision.path}" and ${ENV_SITES_VAR} are both set. ` +
        `Provide exactly one - a config file (sites, queue tuning, tokens) or ${ENV_SITES_VAR} (sites only).`,
    )
  }
  if (decision.kind === 'explicit-missing') {
    throw new ConfigLoadError(
      `Config file "${decision.path}" (requested explicitly) does not exist. ` +
        `Remove the explicit setting, or use ${ENV_SITES_VAR} instead.`,
    )
  }
  if (decision.kind === 'missing') {
    throw new ConfigLoadError(
      `No configuration found: no relay.config.ts and ${ENV_SITES_VAR} is not set. ` +
        `Set ${ENV_SITES_VAR} to a JSON object of sites (e.g. {"www.example.com": "<indexnow-key>"}) ` +
        `plus INDEXNOW_RELAY_TOKEN, or provide a relay.config.ts file.`,
    )
  }

  const raw =
    decision.kind === 'env-sites'
      ? buildEnvSitesConfig(process.env[ENV_SITES_VAR]!)
      : await importConfigFile(decision.path)

  const check = validateRawConfig(raw)
  if (!check.success) {
    const first = check.errors[0]
    const origin = decision.kind === 'env-sites' ? ENV_SITES_VAR : decision.path
    throw new ConfigLoadError(
      `Invalid configuration from ${origin}: ${first?.expected ?? 'unknown error'}` +
        `${first?.path ? ` (at ${first.path})` : ''}`,
    )
  }

  const normalized = normalizeRelayConfig(check.data)

  const normalizedCheck = validateNormalizedConfig(normalized)
  if (!normalizedCheck.success) {
    // Defensive: normalization produced something unexpected.
    throw new ConfigLoadError(
      `Normalized config failed runtime validation: ${normalizedCheck.errors[0]?.expected}`,
    )
  }

  return { config: normalized, sourcePath: decision.kind === 'env-sites' ? ENV_SITES_VAR : decision.path }
}

async function importConfigFile(configPath: string): Promise<RelayConfigInput> {
  let module: { default?: unknown }
  try {
    module = (await import(pathToFileURL(configPath).href)) as { default?: unknown }
  } catch (error) {
    throw new ConfigLoadError(
      `Failed to load config file "${configPath}": ${error instanceof Error ? error.message : String(error)}`,
    )
  }

  const raw = module.default
  if (raw === undefined || raw === null) {
    throw new ConfigLoadError(`Config file "${configPath}" must have a default export.`)
  }
  return raw as RelayConfigInput
}
