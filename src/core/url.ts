/**
 * URL normalization for submitted URLs.
 *
 * Shape validation (string, length, array bounds) happens in typia schemas;
 * this module owns the domain rules: scheme allowlist, host extraction,
 * fragment stripping, and canonical formatting.
 */

export const MAX_URL_LENGTH = 2048

export class InvalidUrlError extends Error {
  readonly url: string
  readonly reason: string

  constructor(url: string, reason: string) {
    super(`Invalid URL: ${reason}`)
    this.name = 'InvalidUrlError'
    this.url = url
    this.reason = reason
  }
}

export interface NormalizedSubmitUrl {
  /** Canonical URL string used as the queue identity. */
  url: string
  /** Lowercased hostname (no port). */
  host: string
}

export function normalizeSubmitUrl(raw: string): NormalizedSubmitUrl {
  if (typeof raw !== 'string' || raw.length === 0) {
    throw new InvalidUrlError(String(raw), 'must be a non-empty string')
  }
  if (raw.length > MAX_URL_LENGTH) {
    throw new InvalidUrlError(raw, `exceeds ${MAX_URL_LENGTH} characters`)
  }

  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    throw new InvalidUrlError(raw, 'not a parsable absolute URL')
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new InvalidUrlError(raw, 'scheme must be http or https')
  }

  const host = parsed.hostname.toLowerCase()
  if (host.length === 0) {
    throw new InvalidUrlError(raw, 'missing hostname')
  }

  // IndexNow matches on exact URL strings; drop state that never changes
  // content identity: fragments and default ports.
  parsed.hash = ''
  if (
    (parsed.protocol === 'https:' && parsed.port === '443') ||
    (parsed.protocol === 'http:' && parsed.port === '80')
  ) {
    parsed.port = ''
  }
  if (parsed.pathname === '') {
    parsed.pathname = '/'
  }

  return { url: parsed.toString(), host }
}

export interface UrlGroup {
  host: string
  urls: string[]
}
