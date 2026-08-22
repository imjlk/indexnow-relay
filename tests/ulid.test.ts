import { describe, expect, test } from 'bun:test'

import { createUlid } from '../src/core/ulid.ts'

describe('createUlid', () => {
  test('produces 26 Crockford base32 characters', () => {
    const id = createUlid()
    expect(id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/)
  })

  test('is sortable by creation time', () => {
    const earlier = createUlid(Date.now() - 5000)
    const later = createUlid(Date.now())
    expect(earlier < later).toBe(true)
  })

  test('does not collide in a tight loop', () => {
    const ids = new Set(Array.from({ length: 10_000 }, () => createUlid()))
    expect(ids.size).toBe(10_000)
  })
})
