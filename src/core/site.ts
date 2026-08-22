import { timingSafeEqual } from 'node:crypto'

import type { NormalizedRelayConfig, NormalizedSite, NormalizedToken } from '../config/config.types.ts'

/**
 * Hostname-keyed site lookup. The hostname IS the site identity - there is no
 * separate target id anywhere in the API or the database.
 */
export class SiteRegistry {
  readonly #sites: ReadonlyMap<string, NormalizedSite>

  constructor(config: NormalizedRelayConfig) {
    this.#sites = new Map(Object.entries(config.sites))
  }

  get(host: string): NormalizedSite | undefined {
    return this.#sites.get(host)
  }

  all(): NormalizedSite[] {
    return [...this.#sites.values()]
  }

  enabled(): NormalizedSite[] {
    return this.all().filter((site) => site.enabled)
  }
}

function timingSafeEquals(a: string, b: string): boolean {
  const aBytes = new TextEncoder().encode(a)
  const bBytes = new TextEncoder().encode(b)
  if (aBytes.length !== bBytes.length) return false
  return timingSafeEqual(aBytes, bBytes)
}

/** Constant-time token lookup. */
export function findToken(tokens: NormalizedToken[], presented: string): NormalizedToken | undefined {
  let matched: NormalizedToken | undefined
  for (const token of tokens) {
    if (timingSafeEquals(token.value, presented)) {
      matched = token
    }
  }
  return matched
}

export function isAdminToken(token: NormalizedToken): boolean {
  return token.sites === '*'
}

export function tokenAllowsSite(token: NormalizedToken, host: string): boolean {
  return token.sites === '*' || token.sites.includes(host)
}
