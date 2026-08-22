import type { RelayConfigInput } from './config.types.ts'

/**
 * Identity function that provides compile-time typing and autocomplete for
 * `relay.config.ts`. The value is validated again at runtime (typia) after
 * environment secrets are resolved.
 */
export function defineConfig(config: RelayConfigInput): RelayConfigInput {
  return config
}

/**
 * Marks a config value as "read from this environment variable at startup".
 *
 * ```ts
 * export default defineConfig({
 *   auth: env('INDEXNOW_RELAY_TOKEN'),
 *   sites: {
 *     'www.example.com': env('INDEXNOW_KEY_WWW_EXAMPLE_COM'),
 *   },
 * })
 * ```
 *
 * An optional fallback keeps local development painless:
 * `env('MY_KEY', 'fallback-value')`.
 */
export function env(name: string, defaultValue?: string): { $secret: 'env'; name: string; default?: string } {
  return { $secret: 'env', name, ...(defaultValue === undefined ? {} : { default: defaultValue }) }
}
