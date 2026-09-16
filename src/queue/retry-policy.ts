import type { NormalizedQueueConfig } from '../config/config.types.ts'

/**
 * Exponential backoff with capped jitter.
 *
 * attempt 1 failed -> base * 2^0, attempt 2 -> base * 2^1, ... capped at
 * `backoffMaxMs`. A random 0-30% is added to de-synchronize sites that fail
 * together (e.g. after a network blip).
 *
 * `backoffMaxMs` caps only this self-computed backoff - it never shortens a
 * wait the server explicitly asked for (see {@link parseRetryAfterMs}).
 *
 * @evidence docs/REQUIREMENTS.md#retries-and-dead-letters Computes the
 *           exponential backoff schedule for retryable failures.
 */
export function retryDelayMs(attempt: number, queue: NormalizedQueueConfig): number {
  const exp = Math.min(queue.backoffBaseMs * 2 ** Math.max(0, attempt - 1), queue.backoffMaxMs)
  const jitter = Math.floor(exp * 0.3 * Math.random())
  return Math.min(exp + jitter, queue.backoffMaxMs)
}

const MAX_RETRY_AFTER_SECONDS = 2 ** 31 - 1

// RFC 9110 HTTP-date: IMF-fixdate, plus the two obsolete formats the spec
// asks recipients to accept (RFC 850 and asctime). Anything else - including
// junk like "3600.5", which Date.parse would happily read as the year 3600 -
// is rejected before parsing.
const HTTP_DATE_PATTERN =
  /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$|^(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday), \d{2}-(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)-\d{2} \d{2}:\d{2}:\d{2} GMT$|^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun) (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) [ \d]\d \d{2}:\d{2}:\d{2} \d{4}$/

/**
 * Parses a `Retry-After` header (RFC 9110: non-negative integer seconds or
 * an HTTP-date) into a delay in milliseconds. Returns undefined when the
 * header is absent, malformed (negative, fractional, non-date), or unsafe to
 * compute; a date in the past is treated as no additional wait. The result
 * is only ever combined with the relay's own backoff via max().
 */
export function parseRetryAfterMs(header: string | null | undefined, now: number): number | undefined {
  if (header === null || header === undefined) return undefined
  const raw = header.trim()
  if (raw.length === 0) return undefined

  if (/^\d+$/.test(raw)) {
    const seconds = Number(raw)
    if (seconds > MAX_RETRY_AFTER_SECONDS) return undefined
    return seconds * 1000
  }

  if (!HTTP_DATE_PATTERN.test(raw)) return undefined
  const date = Date.parse(raw)
  if (Number.isNaN(date)) return undefined
  const delay = date - now
  if (delay <= 0) return undefined
  return delay
}
