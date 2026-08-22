import { afterEach, describe, expect, test } from 'bun:test'

import type { FetchLike } from '../src/indexnow/client.ts'
import { closeApp } from '../src/app.ts'
import type { RelayApp } from '../src/api/context.ts'
import { ADMIN_TOKEN, BLOG_KEY, BLOG_HOST, WWW_KEY, WWW_HOST, createTestApp, waitFor } from './helpers/app.ts'
import { findToken } from '../src/core/site.ts'

interface RecordedCall {
  url: string
  body: {
    host: string
    key: string
    keyLocation: string
    urlList: string[]
  }
}

function recordingFetch(respond: () => Response): { fetch: FetchLike; calls: RecordedCall[] } {
  const calls: RecordedCall[] = []
  const fetch: FetchLike = async (url, init) => {
    calls.push({
      url,
      body: JSON.parse((init.body as string | undefined) ?? '{}') as RecordedCall['body'],
    })
    return respond()
  }
  return { fetch, calls }
}

const apps: RelayApp[] = []

function track(a: RelayApp): RelayApp {
  apps.push(a)
  return a
}

afterEach(async () => {
  for (const a of apps.splice(0)) {
    await closeApp(a)
  }
})

const status = (code: number): Response => new Response('', { status: code })

describe('queue worker end to end', () => {
  test('submits a batch, records sent state, and empties the queue', async () => {
    const { fetch, calls } = recordingFetch(() => status(200))
    const a = track(createTestApp({ fetchImpl: fetch }))
    a.scheduler.start()

    a.enqueue.submit(findToken(a.config.auth.tokens, ADMIN_TOKEN)!, ['https://www.example.com/a', 'https://www.example.com/b'], 'updated')

    await waitFor(() => a.pendingUrls.queueDepths().length === 0, 3000, 'queue to drain')

    expect(calls).toHaveLength(1)
    expect(calls[0]!.body.host).toBe(WWW_HOST)
    expect(calls[0]!.body.key).toBe(WWW_KEY)
    expect(calls[0]!.body.keyLocation).toBe(`https://${WWW_HOST}/${WWW_KEY}.txt`)
    expect(calls[0]!.body.urlList).toEqual(['https://www.example.com/a', 'https://www.example.com/b'])

    expect(a.submissionState.getSentAt(WWW_HOST, ['https://www.example.com/a']).size).toBe(1)

    const batches = a.batches.list(undefined, 10)
    expect(batches).toHaveLength(1)
    expect(batches[0]!.status).toBe('succeeded')
    expect(batches[0]!.url_count).toBe(2)
  })

  test('honors per-site batchSize by splitting into multiple batches', async () => {
    const { fetch, calls } = recordingFetch(() => status(200))
    const a = track(createTestApp({ fetchImpl: fetch }))
    a.scheduler.start()

    // blog.example.com has batchSize: 2 in the test config
    a.enqueue.submit(
      findToken(a.config.auth.tokens, ADMIN_TOKEN)!,
      ['https://blog.example.com/1', 'https://blog.example.com/2', 'https://blog.example.com/3'],
      undefined,
    )

    await waitFor(() => a.pendingUrls.queueDepths().length === 0, 3000, 'queue to drain')
    expect(calls).toHaveLength(2)
    expect(calls[0]!.body.urlList).toHaveLength(2)
    expect(calls[1]!.body.urlList).toHaveLength(1)
    expect(calls[0]!.body.keyLocation).toBe(`https://${BLOG_HOST}/.well-known/${BLOG_KEY}.txt`)
  })

  test('retries on 429 and succeeds on the next attempt', async () => {
    let attempt = 0
    const { fetch, calls } = recordingFetch(() => {
      attempt += 1
      return status(attempt === 1 ? 429 : 200)
    })
    const a = track(createTestApp({ fetchImpl: fetch }))
    a.scheduler.start()

    a.enqueue.submit(findToken(a.config.auth.tokens, ADMIN_TOKEN)!, ['https://www.example.com/a'], undefined)

    await waitFor(() => a.pendingUrls.queueDepths().length === 0 && calls.length === 2, 3000, 'retry to succeed')

    const batches = a.batches.list(undefined, 10)
    expect(batches.map((b) => b.status).sort()).toEqual(['retry_scheduled', 'succeeded'])
    expect(batches.find((b) => b.status === 'retry_scheduled')!.http_status).toBe(429)
  })

  test('dead-letters after exhausting attempts', async () => {
    const { fetch, calls } = recordingFetch(() => status(500))
    const a = track(createTestApp({ fetchImpl: fetch }))
    a.scheduler.start()

    a.enqueue.submit(findToken(a.config.auth.tokens, ADMIN_TOKEN)!, ['https://www.example.com/a'], undefined)

    await waitFor(() => a.pendingUrls.listDead(undefined, 10).length === 1, 3000, 'dead letter')
    // maxAttempts = 2 in the test config
    expect(calls.length).toBe(2)

    const dead = a.pendingUrls.listDead(undefined, 10)
    expect(dead[0]!.url).toBe('https://www.example.com/a')
    expect(dead[0]!.attempts).toBe(2)
  })

  test('moves URLs to dead letters immediately on permanent failure (403)', async () => {
    const { fetch, calls } = recordingFetch(() => status(403))
    const a = track(createTestApp({ fetchImpl: fetch }))
    a.scheduler.start()

    a.enqueue.submit(findToken(a.config.auth.tokens, ADMIN_TOKEN)!, ['https://www.example.com/a'], undefined)

    await waitFor(() => a.pendingUrls.listDead(undefined, 10).length === 1, 3000, 'dead letter')
    expect(calls).toHaveLength(1)

    const batches = a.batches.list(undefined, 10)
    expect(batches[0]!.status).toBe('dead')
    expect(batches[0]!.http_status).toBe(403)
  })

  test('requeued dead letters are submitted again', async () => {
    let shouldFail = true
    const { fetch, calls } = recordingFetch(() => status(shouldFail ? 403 : 200))
    const a = track(createTestApp({ fetchImpl: fetch }))
    a.scheduler.start()

    a.enqueue.submit(findToken(a.config.auth.tokens, ADMIN_TOKEN)!, ['https://www.example.com/a'], undefined)
    await waitFor(() => a.pendingUrls.listDead(undefined, 10).length === 1, 3000, 'dead letter')

    shouldFail = false
    const now = Date.now()
    const requeued = a.pendingUrls.requeueDead(now, now, undefined, undefined)
    expect(requeued).toBe(1)
    a.scheduler.wake()

    await waitFor(() => a.pendingUrls.queueDepths().length === 0 && calls.length === 2, 3000, 'requeued submission')
  })

  test('a paused site is not drained until resumed', async () => {
    const { fetch, calls } = recordingFetch(() => status(200))
    const a = track(createTestApp({ fetchImpl: fetch }))

    a.siteState.setPaused(WWW_HOST, true, 'testing', Date.now())
    a.scheduler.start()

    a.enqueue.submit(findToken(a.config.auth.tokens, ADMIN_TOKEN)!, ['https://www.example.com/a'], undefined)
    await Bun.sleep(150)
    expect(calls).toHaveLength(0)
    expect(a.pendingUrls.queueDepths().find((d) => d.status === 'pending')!.count).toBe(1)

    a.siteState.setPaused(WWW_HOST, false, undefined, Date.now())
    a.scheduler.wake()
    await waitFor(() => calls.length === 1, 3000, 'submission after resume')
  })

  test('recovers URLs left leased by a crashed process', async () => {
    const { fetch, calls } = recordingFetch(() => status(200))
    const a = track(createTestApp({ fetchImpl: fetch }))

    a.enqueue.submit(findToken(a.config.auth.tokens, ADMIN_TOKEN)!, ['https://www.example.com/a'], undefined)

    // simulate a crashed worker: a lease that will never complete
    a.db
      .prepare("UPDATE pending_urls SET lease_id = 'stale-lease', lease_until = ? WHERE site_host = ?")
      .run(Date.now() + 60_000, WWW_HOST)
    expect(a.pendingUrls.nextDueAt(WWW_HOST)).toBe(null)

    // scheduler.start() runs boot recovery: leases cleared, work resumed
    a.scheduler.start()
    await waitFor(() => calls.length === 1, 3000, 'recovered submission')
  })

  test('network failures are retryable, not permanent', async () => {
    let attempts = 0
    const fetch: FetchLike = async () => {
      attempts += 1
      if (attempts === 1) throw new Error('ECONNRESET')
      return status(200)
    }
    const a = track(createTestApp({ fetchImpl: fetch }))
    a.scheduler.start()

    a.enqueue.submit(findToken(a.config.auth.tokens, ADMIN_TOKEN)!, ['https://www.example.com/a'], undefined)
    await waitFor(() => a.pendingUrls.queueDepths().length === 0 && attempts === 2, 3000, 'network retry')
  })
})
