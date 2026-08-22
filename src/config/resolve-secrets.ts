import type { EnvSecretReference, SecretValue } from './config.types.ts'

export class SecretResolutionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SecretResolutionError'
  }
}

export function isEnvSecretReference(value: unknown): value is EnvSecretReference {
  return typeof value === 'object' && value !== null && (value as EnvSecretReference).$secret === 'env'
}

/**
 * Resolves a `SecretValue` into a concrete string. Values are kept in memory
 * only; they are never written to SQLite, logs, or API responses.
 */
export function resolveSecret(value: SecretValue, context: string): string {
  if (typeof value === 'string') {
    return value
  }

  const resolved = process.env[value.name] ?? value.default
  if (resolved === undefined || resolved.length === 0) {
    throw new SecretResolutionError(
      `${context}: environment variable "${value.name}" is not set. ` +
        'Provide it before starting the relay (see relay.config.ts).',
    )
  }
  return resolved
}
