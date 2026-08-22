import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
import typia from 'typia'

import { normalizeRelayConfig } from './normalize-config.ts'
import type { NormalizedRelayConfig, RelayConfigInput } from './config.types.ts'

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
  sourcePath: string
}

export function resolveConfigPath(explicitPath?: string): string {
  return resolve(explicitPath ?? process.env['INDEXNOW_RELAY_CONFIG'] ?? 'relay.config.ts')
}

/**
 * Loads `relay.config.ts`, validates its shape (typia), resolves environment
 * secrets, normalizes it, and runtime-validates the normalized result again.
 */
export async function loadRelayConfig(explicitPath?: string): Promise<LoadConfigResult> {
  const configPath = resolveConfigPath(explicitPath)

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

  const check = validateRawConfig(raw)
  if (!check.success) {
    const first = check.errors[0]
    throw new ConfigLoadError(
      `Invalid relay.config.ts shape at ${configPath}: ${first?.expected ?? 'unknown error'}` +
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

  return { config: normalized, sourcePath: configPath }
}
