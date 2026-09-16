import { afterEach, describe, expect, test } from 'bun:test'

import type { FetchLike } from '../src/indexnow/client.ts'
import { IndexNowClient } from '../src/indexnow/client.ts'
import { USER_AGENT } from '../src/version.ts'
import { drainSite, type DrainResult } from '../src/queue/worker.ts'
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

function deferredFetch(): { fetch: FetchLike; calls: RecordedCall[]; resolve: (status: number) => void } {
  const calls: RecordedCall[] = []
  let release: ((status: number) => void) | undefined
  const fetch: FetchLike = async (url, init) => {
    calls.push({
      url,
      body: JSON.parse((init.body as string | undefined) ?? '{}') as RecordedCall['body'],
    })
    return new Promise<number>((resolvePromise) => {
      release = resolvePromise
    }).then((statusCode) => new Response('', { status: statusCode }))
  }
  return {
    fetch,
    calls,
    resolve: (statusCode) => {
      if (release === undefined) throw new Error('fetch not started yet')
      release(statusCode)
    },
  }
}

/** Drives drainSite manually against an app whose scheduler never started. */
function manualDrain(a: RelayApp, fetch: FetchLike, isStopped: () => boolean = () => false): Promise<DrainResult> {
  return drainSite(
    a.config.sites[WWW_HOST]!,
    {
      db: a.db,
      pendingUrls: a.pendingUrls,
      submissionState: a.submissionState,
      batches: a.batches,
      queue: a.config.queue,
      client: new IndexNowClient({
        endpoint: a.config.indexnowEndpoint,
        timeoutMs: a.config.queue.httpTimeoutMs,
        userAgent: USER_AGENT,
        fetchImpl: fetch,
      }),
      logger: a.logger,
      notifier: a.notifier,
    },
    isStopped,
  )
}

/** Deferred fetch that queues one pending response per call. */
function steppedFetch(): { fetch: FetchLike; calls: RecordedCall[]; resolveNext: (status: number) => void } {
  const calls: RecordedCall[] = []
  const pending: Array<(status: number) => void> = []
  const fetch: FetchLike = async (url, init) => {
    calls.push({
      url,
      body: JSON.parse((init.body as string | undefined) ?? '{}') as RecordedCall['body'],
    })
    return new Promise<number>((resolve) => {
      pending.push(resolve)
    }).then((statusCode) => new Response('', { status: statusCode }))
  }
  return {
    fetch,
    calls,
    resolveNext: (statusCode) => {
      const release = pending.shift()
      if (release === undefined) throw new Error('no fetch call is waiting')
      release(statusCode)
    },
  }
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
  test('a submission alone does not deliver before scheduler.start()', async () => {
    // No fetchImpl injected: if the scheduler drained before start(), this
    // would hit the real IndexNow endpoint.
    const a = track(createTestApp())

    a.enqueue.submit(findToken(a.config.auth.tokens, ADMIN_TOKEN)!, ['https://www.example.com/a'], undefined)
    await Bun.sleep(100)

    const row = a.pendingUrls.get(WWW_HOST, 'https://www.example.com/a')!
    expect(row.status).toBe('pending')
    expect(row.lease_id).toBeNull()
    expect(a.batches.list(undefined, 10)).toHaveLength(0)
  })

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

describe('in-flight resubmission preservation', () => {
  test('a resubmission that lands mid-delivery survives the first success', async () => {
    const deferred = deferredFetch()
    const a = track(createTestApp({ fetchImpl: deferred.fetch }))
    const token = findToken(a.config.auth.tokens, ADMIN_TOKEN)!
    let stopAfterFirstBatch = false

    a.enqueue.submit(token, ['https://www.example.com/a'], 'created')
    const draining = manualDrain(a, deferred.fetch, () => stopAfterFirstBatch)
    await waitFor(() => deferred.calls.length === 1, 3000, 'first batch in flight')

    // the follow-up change arrives while the first HTTP call is pending
    a.enqueue.submit(token, ['https://www.example.com/a'], 'updated')

    stopAfterFirstBatch = true
    deferred.resolve(200)
    const result = await draining

    // first delivery succeeded and is recorded...
    expect(result.batchesSucceeded).toBe(1)
    expect(result.followUpsPreserved).toBe(1)
    expect(a.submissionState.getSentAt(WWW_HOST, ['https://www.example.com/a']).size).toBe(1)
    expect(a.batches.list(undefined, 10)[0]!.status).toBe('succeeded')

    // ...and the follow-up change is still queued with a fresh cycle
    const row = a.pendingUrls.get(WWW_HOST, 'https://www.example.com/a')!
    expect(row.status).toBe('pending')
    expect(row.lease_id).toBeNull()
    expect(row.revision).toBe(2)
    expect(row.attempts).toBe(0)
    expect(row.last_error).toBeNull()
    expect(row.event_type).toBe('updated')
    expect(row.first_seen_at).toBe(row.last_seen_at)
    expect(row.due_at).toBeLessThanOrEqual(Date.now())
  })

  test('repeated mid-flight resubmissions leave exactly one follow-up row', async () => {
    const deferred = deferredFetch()
    const a = track(createTestApp({ fetchImpl: deferred.fetch }))
    const token = findToken(a.config.auth.tokens, ADMIN_TOKEN)!
    let stopAfterFirstBatch = false

    a.enqueue.submit(token, ['https://www.example.com/a'], undefined)
    const draining = manualDrain(a, deferred.fetch, () => stopAfterFirstBatch)
    await waitFor(() => deferred.calls.length === 1, 3000, 'batch in flight')

    a.enqueue.submit(token, ['https://www.example.com/a'], undefined)
    a.enqueue.submit(token, ['https://www.example.com/a'], undefined)
    a.enqueue.submit(token, ['https://www.example.com/a'], undefined)

    stopAfterFirstBatch = true
    deferred.resolve(200)
    const result = await draining

    const pending = a.pendingUrls.listQueue(WWW_HOST, 'pending', 10)
    expect(pending).toHaveLength(1)
    expect(pending[0]!.revision).toBe(4)
    expect(result.followUpsPreserved).toBe(1)
  })

  test('a failure while recording success rolls back queue, state, and batch', async () => {
    const deferred = deferredFetch()
    const a = track(createTestApp({ fetchImpl: deferred.fetch }))
    const token = findToken(a.config.auth.tokens, ADMIN_TOKEN)!

    a.enqueue.submit(token, ['https://www.example.com/a'], undefined)
    const draining = manualDrain(a, deferred.fetch)
    await waitFor(() => deferred.calls.length === 1, 3000, 'batch in flight')

    const original = a.batches.markSucceeded.bind(a.batches)
    const patched = a.batches as unknown as {
      markSucceeded: (id: string, httpStatus: number, completedAt: number) => void
    }
    patched.markSucceeded = () => {
      throw new Error('db exploded')
    }

    deferred.resolve(200)
    await expect(draining).rejects.toThrow('db exploded')
    patched.markSucceeded = original

    // nothing partially applied: the row is still leased-pending, no sent
    // state, the audit row is still in flight
    const row = a.pendingUrls.get(WWW_HOST, 'https://www.example.com/a')!
    expect(row.status).toBe('pending')
    expect(row.lease_id).not.toBeNull()
    expect(a.submissionState.getSentAt(WWW_HOST, ['https://www.example.com/a'])).toEqual(new Map())
    expect(a.batches.list(undefined, 10)[0]!.status).toBe('in_flight')
  })

  test('a resubmission during follow-up delivery is preserved, not suppressed', async () => {
    const stepped = steppedFetch()
    const a = track(createTestApp({ fetchImpl: stepped.fetch }))
    const token = findToken(a.config.auth.tokens, ADMIN_TOKEN)!
    let stop = false
    const url = 'https://www.example.com/a'

    a.enqueue.submit(token, [url], undefined)
    const draining = manualDrain(a, stepped.fetch, () => stop)
    await waitFor(() => stepped.calls.length === 1, 3000, 'first batch in flight')

    // first follow-up lands mid-flight (revision 2)
    a.enqueue.submit(token, [url], undefined)
    stepped.resolveNext(200)
    await waitFor(() => stepped.calls.length === 2, 3000, 'follow-up batch in flight')

    // the first success was just recorded, so the resubmit-interval gate is
    // active - it must still coalesce into the in-flight follow-up row
    // instead of being suppressed and lost when that row delivers
    const third = a.enqueue.submit(token, [url], 'updated')
    expect(third.coalesced).toBe(1)

    stop = true
    stepped.resolveNext(200)
    await draining

    const row = a.pendingUrls.get(WWW_HOST, url)!
    expect(row.status).toBe('pending')
    expect(row.revision).toBe(3)
    expect(row.event_type).toBe('updated')
    expect(row.lease_id).toBeNull()
  })

  test('an expired lease completed late does not touch the new lease', () => {
    const a = track(createTestApp())
    const url = 'https://www.example.com/a'
    a.enqueue.submit(findToken(a.config.auth.tokens, ADMIN_TOKEN)!, [url], undefined)
    const staleClaim = { url, event_type: null, attempts: 0, revision: 1 }

    // same-revision replacement lease: the lease predicate alone must block
    // the stale worker's delete
    a.db.prepare("UPDATE pending_urls SET lease_id = 'lease-2' WHERE url = ?").run(url)
    expect(a.pendingUrls.deleteLeased(WWW_HOST, 'lease-1', [staleClaim])).toBe(0)
    expect(a.pendingUrls.releaseFollowUps(WWW_HOST, 'lease-1', [staleClaim], 0)).toEqual([])

    // resubmitted row re-leased elsewhere: the revision guard holds too
    a.db
      .prepare("UPDATE pending_urls SET lease_id = 'lease-2', revision = 2 WHERE url = ?")
      .run(url)
    expect(a.pendingUrls.deleteLeased(WWW_HOST, 'lease-1', [staleClaim])).toBe(0)
    expect(a.pendingUrls.releaseFollowUps(WWW_HOST, 'lease-1', [staleClaim], 0)).toEqual([])

    const row = a.pendingUrls.get(WWW_HOST, url)!
    expect(row.lease_id).toBe('lease-2')
    expect(row.revision).toBe(2)
    expect(row.attempts).toBe(0)
  })
})
