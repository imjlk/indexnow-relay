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

// RFC 9110 HTTP-date in its three formats (IMF-fixdate, RFC 850, asctime),
// always UTC. All three are decomposed into components and validated the
// same way - never handed to Date.parse, which both accepts non-RFC values
// (24:00:00, junk like "3600.5" read as a year) and reads zone-less asctime
// in the host timezone.
const IMF_FIXDATE_PATTERN =
  /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), (\d{2}) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (\d{4}) (\d{2}):(\d{2}):(\d{2}) GMT$/
const RFC_850_PATTERN =
  /^(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday), (\d{2})-(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)-(\d{2}) (\d{2}):(\d{2}):(\d{2}) GMT$/
const ASCTIME_PATTERN =
  /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) ( ?\d|\d{2}) (\d{2}):(\d{2}):(\d{2}) (\d{4})$/

const MONTH_INDEX: Record<string, number> = {
  Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5,
  Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11,
}

/**
 * Parses a `Retry-After` header (RFC 9110: non-negative integer seconds or
 * an HTTP-date, always UTC) into a delay in milliseconds. Returns undefined
 * when the header is absent, malformed (negative, fractional, non-date,
 * out-of-range), or unsafe to compute; a date in the past is treated as no
 * additional wait. The result is only ever combined with the relay's own
 * backoff via max().
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

  const date = httpDateUtcMs(raw, now)
  if (date === undefined) return undefined
  const delay = date - now
  if (delay <= 0) return undefined
  return delay
}

interface DateComponents {
  year: number
  monthIndex: number
  day: number
  hour: number
  minute: number
  second: number
}

function httpDateUtcMs(raw: string, now: number): number | undefined {
  const components = decomposeHttpDate(raw, now)
  if (components === undefined) return undefined
  const { year, monthIndex, day, hour, minute, second } = components

  if (hour > 23 || minute > 59 || second > 60) return undefined
  // Second 60 is a leap second: the instant is the start of the next minute.
  const wholeSecond = second === 60 ? 59 : second
  const ms = Date.UTC(year, monthIndex, day, hour, minute, wholeSecond) + (second === 60 ? 1000 : 0)

  // Reject calendar overflow (Feb 30, Sep 31, ...) instead of letting
  // Date.UTC roll it into the next month. The leap second's +1s is undone
  // first so the check compares the whole-second instant.
  const check = new Date(second === 60 ? ms - 1000 : ms)
  if (
    check.getUTCFullYear() !== year ||
    check.getUTCMonth() !== monthIndex ||
    check.getUTCDate() !== day ||
    check.getUTCHours() !== hour ||
    check.getUTCMinutes() !== minute ||
    check.getUTCSeconds() !== wholeSecond
  ) {
    return undefined
  }
  return ms
}

function decomposeHttpDate(raw: string, now: number): DateComponents | undefined {
  const fixdate = IMF_FIXDATE_PATTERN.exec(raw)
  if (fixdate !== null) {
    const [, day, month, year, hour, minute, second] = fixdate
    return {
      year: Number(year),
      monthIndex: MONTH_INDEX[month!]!,
      day: Number(day),
      hour: Number(hour),
      minute: Number(minute),
      second: Number(second),
    }
  }

  const rfc850 = RFC_850_PATTERN.exec(raw)
  if (rfc850 !== null) {
    const [, day, month, twoDigitYear, hour, minute, second] = rfc850
    // RFC 9110: a two-digit year resolves within 50 years of now - 00-49
    // is this century unless that lands more than 50 years ahead, then it
    // is the previous century.
    const year = Number(twoDigitYear)
    const thisCentury = year < 100 ? 2000 + year : year
    const currentYear = new Date(now).getUTCFullYear()
    const resolved = thisCentury > currentYear + 50 ? thisCentury - 100 : thisCentury
    return {
      year: resolved,
      monthIndex: MONTH_INDEX[month!]!,
      day: Number(day),
      hour: Number(hour),
      minute: Number(minute),
      second: Number(second),
    }
  }

  const asctime = ASCTIME_PATTERN.exec(raw)
  if (asctime !== null) {
    const [, month, day, hour, minute, second, year] = asctime
    return {
      year: Number(year),
      monthIndex: MONTH_INDEX[month!]!,
      day: Number(day),
      hour: Number(hour),
      minute: Number(minute),
      second: Number(second),
    }
  }

  return undefined
}
