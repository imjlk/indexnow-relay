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
