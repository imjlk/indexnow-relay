import { afterEach, describe, expect, test } from 'bun:test'

import type { ORPCError } from '@orpc/server'

import { findToken } from '../src/core/site.ts'
import { closeApp } from '../src/app.ts'
import type { RelayApp } from '../src/api/context.ts'
import { ADMIN_TOKEN, BLOG_TOKEN, createTestApp } from './helpers/app.ts'

const apps: RelayApp[] = []

afterEach(async () => {
  for (const app of apps.splice(0)) {
    await closeApp(app)
  }
})

function app(): RelayApp {
  const created = createTestApp()
  apps.push(created)
  return created
}

const adminTokenOf = (a: RelayApp) => findToken(a.config.auth.tokens, ADMIN_TOKEN)!
const blogTokenOf = (a: RelayApp) => findToken(a.config.auth.tokens, BLOG_TOKEN)!

const errorCode = (error: unknown): string => (error as ORPCError<string, unknown>).code

describe('EnqueueService.submit', () => {
  test('splits a request across hosts and writes a receipt atomically', () => {
    const a = app()
    const receipt = a.enqueue.submit(
      adminTokenOf(a),
      [
        'https://www.example.com/a',
        'https://www.example.com/b',
        'https://blog.example.com/x',
      ],
      'updated',
    )

    expect(receipt.received).toBe(3)
    expect(receipt.enqueued).toBe(3)
    expect(receipt.coalesced).toBe(0)
    expect(receipt.sites).toEqual([
      { host: 'www.example.com', enqueued: 2, coalesced: 0 },
      { host: 'blog.example.com', enqueued: 1, coalesced: 0 },
    ])

    const stored = a.receipts.get(receipt.receiptId)
    expect(stored).not.toBeNull()
    expect(a.pendingUrls.countPendingByReceipt(receipt.receiptId)).toBe(3)
  })

  test('coalesces duplicates within one request', () => {
    const a = app()
    const receipt = a.enqueue.submit(
      adminTokenOf(a),
      ['https://www.example.com/a', 'https://www.example.com/a#frag'],
      undefined,
    )
    // fragment stripped -> identical URL -> coalesced
    expect(receipt.received).toBe(2)
    expect(receipt.enqueued).toBe(1)
    expect(receipt.coalesced).toBe(1)
  })

  test('coalesces resubmissions while a URL is still pending', () => {
    const a = app()
    a.enqueue.submit(adminTokenOf(a), ['https://www.example.com/a'], undefined)
    const second = a.enqueue.submit(adminTokenOf(a), ['https://www.example.com/a'], undefined)
    expect(second.enqueued).toBe(0)
    expect(second.coalesced).toBe(1)
  })

  test('coalesces resubmissions inside the resubmit window after success', async () => {
    const a = app()
    const token = adminTokenOf(a)

    a.enqueue.submit(token, ['https://www.example.com/a'], undefined)
    // simulate a successful submission
    a.submissionState.recordSent('www.example.com', ['https://www.example.com/a'], Date.now())

    const again = a.enqueue.submit(token, ['https://www.example.com/a'], undefined)
    expect(again.coalesced).toBe(1)
    expect(again.enqueued).toBe(0)
  })

  test('rejects invalid URLs without writing anything (all-or-nothing)', () => {
    const a = app()
    const invalid = capture(() => a.enqueue.submit(adminTokenOf(a), ['https://www.example.com/a', 'ftp://nope/'], undefined))
    expect(errorCode(invalid)).toBe('INVALID_URL')
    const notParseable = capture(() => a.enqueue.submit(adminTokenOf(a), ['not-a-url'], undefined))
    expect(errorCode(notParseable)).toBe('INVALID_URL')
    expect(a.pendingUrls.queueDepths()).toEqual([])
  })

  test('rejects unknown hosts', () => {
    const a = app()
    const error = capture(() => a.enqueue.submit(adminTokenOf(a), ['https://other.example.org/x'], undefined))
    expect(errorCode(error)).toBe('UNKNOWN_SITE')
  })

  test('rejects hosts outside a scoped token', () => {
    const a = app()
    const error = capture(() =>
      a.enqueue.submit(blogTokenOf(a), ['https://blog.example.com/ok', 'https://www.example.com/nope'], undefined),
    )
    expect(errorCode(error)).toBe('FORBIDDEN_SITE')
    // nothing was enqueued for the allowed host either
    expect(a.pendingUrls.queueDepths()).toEqual([])
  })

  test('revives a dead URL when it is resubmitted', async () => {
    const a = app()
    const token = adminTokenOf(a)
    a.enqueue.submit(token, ['https://www.example.com/a'], undefined)

    a.db
      .prepare("UPDATE pending_urls SET status = 'dead' WHERE url = ?")
      .run('https://www.example.com/a')

    const again = a.enqueue.submit(token, ['https://www.example.com/a'], undefined)
    expect(again.enqueued).toBe(1)
    const row = a.pendingUrls.get('www.example.com', 'https://www.example.com/a')
    expect(row!.status).toBe('pending')
    expect(row!.attempts).toBe(0)
  })
})

function capture(fn: () => unknown): unknown {
  try {
    fn()
  } catch (error) {
    return error
  }
  throw new Error('expected fn to throw')
}
