import { describe, expect, test } from 'bun:test'

import type { RawSubmitResult } from '../src/indexnow/response-policy.ts'
import { classifySubmitResult } from '../src/indexnow/response-policy.ts'
import { parseRetryAfterMs, retryDelayMs } from '../src/queue/retry-policy.ts'
import { DEFAULT_QUEUE_CONFIG } from '../src/config/normalize-config.ts'

const NOW = 1_700_000_000_000

describe('parseRetryAfterMs', () => {
  test('parses non-negative integer seconds', () => {
    expect(parseRetryAfterMs('0', NOW)).toBe(0)
    expect(parseRetryAfterMs('120', NOW)).toBe(120_000)
    expect(parseRetryAfterMs(' 60 ', NOW)).toBe(60_000)
  })

  test('parses HTTP dates into a delay from now', () => {
    const future = new Date(NOW + 90_000).toUTCString()
    expect(parseRetryAfterMs(future, NOW)).toBe(90_000)
  })

  test('a past date means no additional wait', () => {
    const past = new Date(NOW - 60_000).toUTCString()
    expect(parseRetryAfterMs(past, NOW)).toBeUndefined()
  })

  test('ignores malformed and unsafe values', () => {
    expect(parseRetryAfterMs(null, NOW)).toBeUndefined()
    expect(parseRetryAfterMs(undefined, NOW)).toBeUndefined()
    expect(parseRetryAfterMs('', NOW)).toBeUndefined()
    expect(parseRetryAfterMs('   ', NOW)).toBeUndefined()
    expect(parseRetryAfterMs('-1', NOW)).toBeUndefined()
    expect(parseRetryAfterMs('1.5', NOW)).toBeUndefined()
    expect(parseRetryAfterMs('soon', NOW)).toBeUndefined()
    expect(parseRetryAfterMs(String(2 ** 31), NOW)).toBeUndefined()
  })

  test('numeric-looking junk is never read as a far-future date', () => {
    // Date.parse('3600.5') is the year 3600 - it must not become a cooldown
    expect(parseRetryAfterMs('3600.5', NOW)).toBeUndefined()
    expect(parseRetryAfterMs('12:00:00', NOW)).toBeUndefined()
    expect(parseRetryAfterMs('2026-01-01T00:00:00Z', NOW)).toBeUndefined()
    expect(parseRetryAfterMs('0.5', NOW)).toBeUndefined()
    // all-digits values are always seconds, never years
    expect(parseRetryAfterMs('9999', NOW)).toBe(9_999_000)
  })

  test('accepts the three RFC 9110 date formats', () => {
    // expectations are computed with the TZ-independent Date.UTC, so a local
    // timezone on the test runner cannot mask a wrong implementation
    expect(parseRetryAfterMs('Wed, 15 Nov 2026 08:12:31 GMT', NOW)).toBe(
      Date.UTC(2026, 10, 15, 8, 12, 31) - NOW,
    )
    expect(parseRetryAfterMs('Wednesday, 15-Nov-26 08:12:31 GMT', NOW)).toBe(
      Date.UTC(2026, 10, 15, 8, 12, 31) - NOW,
    )
    // asctime has no zone suffix but is UTC per RFC 9110, regardless of the
    // host timezone
    expect(parseRetryAfterMs('Sun Nov  6 08:49:37 2028', NOW)).toBe(
      Date.UTC(2028, 10, 6, 8, 49, 37) - NOW,
    )
    expect(parseRetryAfterMs('Sun Nov  6 08:49:37 2028', Date.UTC(2028, 10, 6, 8, 48, 37))).toBe(60_000)
    // leap second 60 is valid in every format and rolls into the next minute
    expect(parseRetryAfterMs('Sun Nov  6 08:48:60 2028', Date.UTC(2028, 10, 6, 8, 48, 0))).toBe(60_000)
    expect(parseRetryAfterMs('Sat, 31 Dec 2016 23:59:60 GMT', Date.UTC(2016, 11, 31, 23, 59, 0))).toBe(60_000)
    expect(parseRetryAfterMs('Saturday, 31-Dec-16 23:59:60 GMT', Date.UTC(2016, 11, 31, 23, 59, 0))).toBe(60_000)
  })

  test('rejects out-of-range or rolling-over date fields in every format', () => {
    const cases = [
      // hour 24 rolls into the next day instead of being a valid time
      'Wed, 16 Sep 2026 24:00:00 GMT',
      'Wednesday, 16-Sep-26 24:00:00 GMT',
      'Wed Sep 16 24:00:00 2026',
      // calendar overflow would silently become the next month
      'Thu, 31 Sep 2026 12:00:00 GMT',
      'Wednesday, 31-Sep-26 12:00:00 GMT',
      'Wed Sep 31 12:00:00 2026',
      'Mon, 30 Feb 2028 12:00:00 GMT',
      'Wed Feb 29 2027 12:00:00 00', // 2027 is not a leap year - and bad year digits
      // plain out-of-range fields
      'Wed Sep 16 99:00:00 2026',
      'Wed Sep 16 12:99:00 2026',
      'Wed Sep 16 12:00:99 2026',
      'Wed, 39 Sep 2026 12:00:00 GMT',
      'Wed, 00 Sep 2026 12:00:00 GMT',
    ]
    for (const header of cases) {
      expect(parseRetryAfterMs(header, Date.UTC(2026, 8, 16, 11))).toBeUndefined()
    }
    // a real leap day stays valid
    expect(parseRetryAfterMs('Mon, 29 Feb 2028 12:00:00 GMT', Date.UTC(2028, 1, 29, 11))).toBe(3_600_000)
  })
})

describe('classifySubmitResult', () => {
  const raw = (overrides: Partial<RawSubmitResult>): RawSubmitResult => ({
    completed: true,
    httpStatus: 200,
    retryAfter: null,
    networkError: false,
    ...overrides,
  })

  test('200 and 202 succeed; 202 flags pending key validation', () => {
    expect(classifySubmitResult(raw({ httpStatus: 200 }))).toEqual({
      kind: 'success',
      httpStatus: 200,
      keyValidationPending: false,
    })
    expect(classifySubmitResult(raw({ httpStatus: 202 }))).toEqual({
      kind: 'success',
      httpStatus: 202,
      keyValidationPending: true,
    })
  })

  test('429 and every 5xx retry', () => {
    for (const status of [429, 500, 501, 502, 503, 504, 555, 599]) {
      expect(classifySubmitResult(raw({ httpStatus: status })).kind).toBe('retryable')
    }
  })

  test('other 4xx and unexpected statuses fail permanently', () => {
    for (const status of [400, 403, 422, 301, 100]) {
      const outcome = classifySubmitResult(raw({ httpStatus: status }))
      expect(outcome.kind).toBe('permanent')
    }
  })

  test('network failures retry', () => {
    const outcome = classifySubmitResult(raw({ completed: false, httpStatus: undefined, networkError: true }))
    expect(outcome.kind).toBe('retryable')
  })
})

describe('retryDelayMs', () => {
  test('grows exponentially and never exceeds backoffMaxMs', () => {
    const queue = { ...DEFAULT_QUEUE_CONFIG, backoffBaseMs: 30_000, backoffMaxMs: 900_000 }
    const seen = [1, 2, 3, 6, 10].map((attempt) => retryDelayMs(attempt, queue))
    expect(seen[0]).toBeGreaterThanOrEqual(30_000)
    expect(seen[2]).toBeGreaterThanOrEqual(120_000)
    for (const delay of seen) {
      expect(delay).toBeLessThanOrEqual(900_000)
    }
  })
})
