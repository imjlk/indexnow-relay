import { afterEach, describe, expect, test } from 'bun:test'

import type { ORPCError } from '@orpc/server'

import { findToken } from '../src/core/site.ts'
import { closeApp } from '../src/app.ts'
import type { RelayApp } from '../src/api/context.ts'
import { ADMIN_TOKEN, BLOG_TOKEN, BLOG_HOST, BLOG_KEY, WWW_HOST, WWW_KEY, createTestApp } from './helpers/app.ts'

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

  test('schedules a deferred redelivery inside the resubmit window after success', () => {
    const a = app()
    const token = adminTokenOf(a)
    const sentAt = Date.now()

    // a delivered URL with an empty queue: only sent state remains
    a.submissionState.recordSent('www.example.com', ['https://www.example.com/a'], sentAt)

    const again = a.enqueue.submit(token, ['https://www.example.com/a'], undefined)
    expect(again.enqueued).toBe(1)
    expect(again.coalesced).toBe(0)

    // one row, reserved until the interval after the last success passes
    const row = a.pendingUrls.get('www.example.com', 'https://www.example.com/a')!
    expect(row.status).toBe('pending')
    expect(row.not_before_at).toBe(sentAt + a.config.sites['www.example.com']!.minResubmitIntervalMs)
    expect(row.due_at).toBe(row.not_before_at)
    expect(row.attempts).toBe(0)
  })

  test('repeated resubmissions merge into the deferred reservation without postponing it', () => {
    const a = app()
    const token = adminTokenOf(a)
    const interval = a.config.sites['www.example.com']!.minResubmitIntervalMs
    const realNow = Date.now
    const sentAt = realNow()
    let clock = sentAt
    Date.now = () => clock
    try {
      a.submissionState.recordSent('www.example.com', ['https://www.example.com/a'], sentAt)

      const first = a.enqueue.submit(token, ['https://www.example.com/a'], undefined)
      expect(first.enqueued).toBe(1)
      const reservedUntil = a.pendingUrls.get('www.example.com', 'https://www.example.com/a')!.due_at
      expect(reservedUntil).toBe(sentAt + interval)

      // later arrivals inside the interval must merge, not re-anchor the
      // reservation to their own (later) clock
      clock = sentAt + Math.floor(interval / 3)
      const second = a.enqueue.submit(token, ['https://www.example.com/a'], undefined)
      clock = sentAt + Math.floor(interval * 2 / 3)
      const third = a.enqueue.submit(token, ['https://www.example.com/a'], undefined)
      expect(second.coalesced + third.coalesced).toBe(2)

      const rows = a.pendingUrls.listQueue('www.example.com', 'pending', 10)
      expect(rows).toHaveLength(1)
      expect(rows[0]!.due_at).toBe(reservedUntil)
      expect(rows[0]!.revision).toBe(3)
    } finally {
      Date.now = realNow
    }
  })

  test('the resubmit window boundary decides between deferral and a normal batch', () => {
    const a = app()
    const token = adminTokenOf(a)
    const interval = a.config.sites['www.example.com']!.minResubmitIntervalMs
    const realNow = Date.now
    const now = realNow()
    Date.now = () => now
    try {
      a.submissionState.recordSent('www.example.com', ['https://www.example.com/boundary-before'], now - interval + 100)
      a.submissionState.recordSent('www.example.com', ['https://www.example.com/boundary-after'], now - interval - 100)

      const receipt = a.enqueue.submit(
        token,
        ['https://www.example.com/boundary-before', 'https://www.example.com/boundary-after'],
        undefined,
      )
      expect(receipt.enqueued).toBe(2)

      const deferred = a.pendingUrls.get('www.example.com', 'https://www.example.com/boundary-before')!
      expect(deferred.not_before_at).toBe(now - interval + 100 + interval)
      expect(deferred.due_at).toBe(deferred.not_before_at)
      const normal = a.pendingUrls.get('www.example.com', 'https://www.example.com/boundary-after')!
      expect(normal.not_before_at).toBe(0)
      expect(normal.due_at).toBe(now + a.config.queue.batchWindowMs)
    } finally {
      Date.now = realNow
    }
  })

  test('a longer retry wait outranks the resubmit interval', () => {
    const a = app()
    const token = adminTokenOf(a)
    a.enqueue.submit(token, ['https://www.example.com/a'], undefined)

    const claimed = a.pendingUrls.claimDue('www.example.com', Date.now(), 10, 'lease-1', Date.now() + 60_000)
    expect(claimed).toHaveLength(1)
    const retryAt = Date.now() + 3_600_000
    a.pendingUrls.failLeased('www.example.com', 'lease-1', Date.now(), retryAt, 'http_503', 10)
    a.submissionState.recordSent('www.example.com', ['https://www.example.com/a'], Date.now())

    const again = a.enqueue.submit(token, ['https://www.example.com/a'], undefined)
    expect(again.coalesced).toBe(1)

    const row = a.pendingUrls.get('www.example.com', 'https://www.example.com/a')!
    expect(row.due_at).toBe(retryAt)
    expect(row.not_before_at).toBe(retryAt)
  })

  test('a zero resubmit interval behaves like the normal batch window', () => {
    const created = createTestApp({
      sites: {
        [WWW_HOST]: { key: WWW_KEY, minResubmitIntervalMs: 0 },
        [BLOG_HOST]: { key: BLOG_KEY, keyPath: '/.well-known/{key}.txt', batchSize: 2 },
      },
    })
    apps.push(created)
    const token = findToken(created.config.auth.tokens, ADMIN_TOKEN)!
    const realNow = Date.now
    const frozenAt = realNow()
    Date.now = () => frozenAt
    let receipt: ReturnType<typeof created.enqueue.submit>
    try {
      created.submissionState.recordSent(WWW_HOST, ['https://www.example.com/a'], frozenAt)
      receipt = created.enqueue.submit(token, ['https://www.example.com/a'], undefined)
    } finally {
      Date.now = realNow
    }
    expect(receipt.enqueued).toBe(1)

    const row = created.pendingUrls.get(WWW_HOST, 'https://www.example.com/a')!
    expect(row.not_before_at).toBe(0)
    expect(row.due_at).toBe(frozenAt + created.config.queue.batchWindowMs)
  })

  test('received always equals enqueued plus coalesced across mixed submissions', () => {
    const a = app()
    const token = adminTokenOf(a)

    const first = a.enqueue.submit(
      token,
      ['https://www.example.com/a', 'https://www.example.com/a#dup', 'https://blog.example.com/x'],
      undefined,
    )
    expect(first.received).toBe(3)
    expect(first.enqueued).toBe(2)
    expect(first.coalesced).toBe(1)
    expect(first.received).toBe(first.enqueued + first.coalesced)

    const second = a.enqueue.submit(
      token,
      ['https://www.example.com/a', 'https://blog.example.com/y'],
      undefined,
    )
    expect(second.received).toBe(2)
    expect(second.enqueued).toBe(1)
    expect(second.coalesced).toBe(1)
    expect(second.received).toBe(second.enqueued + second.coalesced)
  })

  test('bumps revision per resubmission, even within the same millisecond', () => {
    const a = app()
    const token = adminTokenOf(a)

    const realNow = Date.now
    const frozenNow = realNow()
    Date.now = () => frozenNow
    try {
      const first = a.enqueue.submit(token, ['https://www.example.com/a'], 'created')
      const second = a.enqueue.submit(token, ['https://www.example.com/a'], 'created')
      expect(first.receiptId).not.toBe(second.receiptId)

      const row = a.pendingUrls.get('www.example.com', 'https://www.example.com/a')!
      expect(row.first_seen_at).toBe(frozenNow)
      expect(row.last_seen_at).toBe(frozenNow)
      expect(row.revision).toBe(2)
      expect(row.last_receipt_id).toBe(second.receiptId)
    } finally {
      Date.now = realNow
    }
  })

  test('updates event metadata on resubmit and keeps it when omitted', () => {
    const a = app()
    const token = adminTokenOf(a)
    a.enqueue.submit(token, ['https://www.example.com/a'], 'created')
    a.enqueue.submit(token, ['https://www.example.com/a'], 'updated')
    expect(a.pendingUrls.get('www.example.com', 'https://www.example.com/a')!.event_type).toBe('updated')

    a.enqueue.submit(token, ['https://www.example.com/a'], undefined)
    expect(a.pendingUrls.get('www.example.com', 'https://www.example.com/a')!.event_type).toBe('updated')
  })

  test('resubmission during a retry wait does not shorten the wait', () => {
    const a = app()
    const token = adminTokenOf(a)
    a.enqueue.submit(token, ['https://www.example.com/a'], undefined)

    // simulate a retryable failure: claim the URL, then fail with a far-future retryAt
    const claimed = a.pendingUrls.claimDue('www.example.com', Date.now(), 10, 'lease-1', Date.now() + 60_000)
    expect(claimed).toHaveLength(1)
    const retryAt = Date.now() + 3_600_000
    a.pendingUrls.failLeased('www.example.com', 'lease-1', Date.now(), retryAt, 'http_503', 10)

    const again = a.enqueue.submit(token, ['https://www.example.com/a'], 'updated')
    expect(again.coalesced).toBe(1)
    expect(again.enqueued).toBe(0)

    const row = a.pendingUrls.get('www.example.com', 'https://www.example.com/a')!
    expect(row.due_at).toBe(retryAt)
    expect(row.not_before_at).toBe(retryAt)
    // a stream of resubmissions must not buy the URL a fresh retry budget
    expect(row.attempts).toBe(1)
    expect(row.revision).toBe(2)
    expect(row.event_type).toBe('updated')
  })

  test('enforces the key-file directory scope on path-segment boundaries', () => {
    const created = createTestApp({
      sites: {
        [WWW_HOST]: { key: WWW_KEY, keyPath: '/catalog/{key}.txt' },
        [BLOG_HOST]: { key: BLOG_KEY, batchSize: 2 },
      },
    })
    apps.push(created)
    const token = findToken(created.config.auth.tokens, ADMIN_TOKEN)!

    const ok = created.enqueue.submit(
      token,
      ['https://www.example.com/catalog/item/1', 'https://www.example.com/catalog/', 'https://www.example.com/catalog/deep/nested'],
      undefined,
    )
    expect(ok.enqueued).toBe(3)

    for (const [label, url] of [
      ['sibling prefix', 'https://www.example.com/catalogue/1'],
      ['outside the scope', 'https://www.example.com/help/1'],
      // the slashless parent is its own resource, not the directory
      ['slashless parent', 'https://www.example.com/catalog'],
      // encoded separators decode into traversal on many origins
      ['encoded traversal', 'https://www.example.com/catalog/..%2fhelp'],
    ] as const) {
      const error = capture(() => created.enqueue.submit(token, [url], undefined))
      expect(errorCode(error)).toBe('INVALID_URL')
      const detail = ((error as { data?: { urls?: Array<{ url: string; reason: string }> } }).data?.urls) ?? []
      expect(detail).toHaveLength(1)
      expect(detail[0]!.url).toBe(url)
      expect(detail[0]!.reason).not.toContain(WWW_KEY)
      void label
    }

    // the whole-site default stays unrestricted
    const blog = created.enqueue.submit(token, ['https://blog.example.com/anywhere/x'], undefined)
    expect(blog.enqueued).toBe(1)
  })

  test('scope comparison is insensitive to percent-escape casing', () => {
    const created = createTestApp({
      sites: {
        [WWW_HOST]: { key: WWW_KEY, keyPath: '/caf%c3%a9/{key}.txt' },
        [BLOG_HOST]: { key: BLOG_KEY, batchSize: 2 },
      },
    })
    apps.push(created)
    const token = findToken(created.config.auth.tokens, ADMIN_TOKEN)!

    // escapes survive URL parsing verbatim, so both spellings are distinct
    // queue identities - but both must fall inside the scope regardless of
    // percent-escape casing
    const ok = created.enqueue.submit(token, ['https://www.example.com/caf%C3%A9/page'], undefined)
    expect(ok.enqueued).toBe(1)
    const lower = created.enqueue.submit(token, ['https://www.example.com/caf%c3%a9/page'], undefined)
    expect(lower.enqueued).toBe(1)
    expect(created.pendingUrls.listQueue(WWW_HOST, 'pending', 10)).toHaveLength(2)
  })

  test('scope errors never leak the key, and authorization comes first', () => {
    const secretKey = 'My-Key-7f3A-000000000001'
    const created = createTestApp({
      sites: {
        // the directory itself embeds the key value
        [WWW_HOST]: { key: secretKey, keyPath: `/x-${secretKey}/{key}.txt` },
        [BLOG_HOST]: { key: BLOG_KEY, batchSize: 2 },
      },
    })
    apps.push(created)
    const admin = findToken(created.config.auth.tokens, ADMIN_TOKEN)!
    const blog = findToken(created.config.auth.tokens, BLOG_TOKEN)!

    // a token unauthorized for the host gets FORBIDDEN_SITE, no scope detail
    const forbidden = capture(() => created.enqueue.submit(blog, ['https://www.example.com/outside'], undefined))
    expect(errorCode(forbidden)).toBe('FORBIDDEN_SITE')

    // an authorized token gets INVALID_URL without the configured directory
    const invalid = capture(() => created.enqueue.submit(admin, ['https://www.example.com/outside'], undefined))
    expect(errorCode(invalid)).toBe('INVALID_URL')
    const message = JSON.stringify((invalid as { data?: unknown }).data ?? {})
    expect(message).not.toContain(secretKey)
  })

  test('unreserved percent escapes compare equal in both directions', () => {
    const created = createTestApp({
      sites: {
        [WWW_HOST]: { key: WWW_KEY, keyPath: '/catalog/{key}.txt' },
        [BLOG_HOST]: { key: BLOG_KEY, keyPath: '/%63atalog/{key}.txt', batchSize: 2 },
      },
    })
    apps.push(created)
    const token = findToken(created.config.auth.tokens, ADMIN_TOKEN)!

    // %61 = 'a': escaped spelling of an in-scope path
    const escaped = created.enqueue.submit(token, ['https://www.example.com/c%61talog/page'], undefined)
    expect(escaped.enqueued).toBe(1)

    // scope configured with an escaped letter, URL submitted plainly
    const plain = created.enqueue.submit(token, ['https://blog.example.com/catalog/page'], undefined)
    expect(plain.enqueued).toBe(1)

    // decoded dot segments are traversal, not spelling
    const traversal = capture(() => created.enqueue.submit(token, ['https://www.example.com/catalog/%2e%2e/help'], undefined))
    expect(errorCode(traversal)).toBe('INVALID_URL')
  })

  test('an out-of-scope URL rejects the whole request all-or-nothing', () => {
    const created = createTestApp({
      sites: {
        [WWW_HOST]: { key: WWW_KEY, keyPath: '/catalog/{key}.txt' },
        [BLOG_HOST]: { key: BLOG_KEY, batchSize: 2 },
      },
    })
    apps.push(created)
    const token = findToken(created.config.auth.tokens, ADMIN_TOKEN)!

    const error = capture(() =>
      created.enqueue.submit(
        token,
        ['https://www.example.com/catalog/item/1', 'https://www.example.com/help/1'],
        undefined,
      ),
    )
    expect(errorCode(error)).toBe('INVALID_URL')
    // nothing was enqueued on either host and no receipt was written
    expect(created.pendingUrls.queueDepths()).toEqual([])
    const receipts = created.db.query('SELECT COUNT(*) AS n FROM receipts').get() as { n: number }
    expect(receipts.n).toBe(0)
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

  test('reviving a dead URL applies the resubmission event', () => {
    const a = app()
    const token = adminTokenOf(a)
    a.enqueue.submit(token, ['https://www.example.com/a'], 'created')

    a.db
      .prepare("UPDATE pending_urls SET status = 'dead' WHERE url = ?")
      .run('https://www.example.com/a')

    a.enqueue.submit(token, ['https://www.example.com/a'], 'deleted')
    const row = a.pendingUrls.get('www.example.com', 'https://www.example.com/a')!
    expect(row.status).toBe('pending')
    expect(row.event_type).toBe('deleted')
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
