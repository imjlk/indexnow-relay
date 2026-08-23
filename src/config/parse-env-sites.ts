import typia from 'typia'

import type { SiteConfigInput } from './config.types.ts'

const validateEnvSites = typia.createValidateEquals<Record<string, SiteConfigInput>>()

export class EnvSitesError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'EnvSitesError'
  }
}

/**
 * Parses the `INDEXNOW_SITES` environment variable: a JSON object mapping
 * hostnames to IndexNow keys (shorthand) or advanced site objects - the same
 * `sites` shape `relay.config.ts` uses.
 *
 * Error messages deliberately omit the raw value and offending fields:
 * the variable is secret and parser messages (including JSON.parse snippets)
 * would otherwise echo parts of it.
 *
 * @evidence docs/REQUIREMENTS.md#site-configuration Owns INDEXNOW_SITES
 *           parsing: sites-only JSON config for environments without a
 *           relay.config.ts, reusing the exact SiteConfigInput shape.
 */
export function parseEnvSites(raw: string): Record<string, SiteConfigInput> {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new EnvSitesError(
      'INDEXNOW_SITES is not valid JSON. Expected a JSON object like ' +
        '{"www.example.com": "<key>"} or advanced site objects. ' +
        '(Details omitted: the value is secret.)',
    )
  }

  const result = validateEnvSites(parsed)
  if (!result.success) {
    const first = result.errors[0]
    throw new EnvSitesError(
      `INDEXNOW_SITES has an invalid value at ${first?.path ?? '$input'}: ` +
        `expected ${first?.expected ?? 'a valid site entry'}` +
        `${first?.description === undefined ? '' : ` (${first.description})`}. ` +
        '(Offending values omitted: the variable is secret.)',
    )
  }

  return result.data
}
