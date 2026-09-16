import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync } from 'node:fs'

import type { SiteConfigInput } from '../src/config/config.types.ts'
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
      siteState: a.siteState,
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
}afterEach(async () => {
  for (const a of apps.splice(0)) {
    await closeApp(a)
  }
})

const status = (code: number): Response => new Response('', { status: code })

describe('queue worker end to end', () => {
  test('a successful delivery without further submissions triggers no extra request', async () => {
    const { fetch, calls } = recordingFetch(() => status(200))
    const a = track(createTestApp({ fetchImpl: fetch }))
    a.scheduler.start()

    a.enqueue.submit(findToken(a.config.auth.tokens, ADMIN_TOKEN)!, ['https://www.example.com/a'], undefined)
    await waitFor(() => a.pendingUrls.queueDepths().length === 0, 3000, 'queue to drain')

    // deferred redelivery exists only when a resubmission arrives; success
    // alone must never produce a second IndexNow request
    await Bun.sleep(150)
    expect(calls).toHaveLength(1)
    expect(a.pendingUrls.queueDepths()).toEqual([])
  })

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

    // ...and the follow-up change is still queued with a fresh cycle whose
    // delivery floor is the just-finished success + the resubmit interval
    const row = a.pendingUrls.get(WWW_HOST, 'https://www.example.com/a')!
    expect(row.status).toBe('pending')
    expect(row.lease_id).toBeNull()
    expect(row.revision).toBe(2)
    expect(row.attempts).toBe(0)
    expect(row.last_error).toBeNull()
    expect(row.event_type).toBe('updated')
    expect(row.first_seen_at).toBe(row.last_seen_at)
    // the floor is exactly the just-recorded success + the site interval
    const sentAt = a.submissionState.getSentAt(WWW_HOST, ['https://www.example.com/a']).get('https://www.example.com/a')!
    expect(row.not_before_at).toBe(sentAt + a.config.sites[WWW_HOST]!.minResubmitIntervalMs)
    expect(row.due_at).toBe(row.not_before_at)
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
    const a = track(createTestApp({
      fetchImpl: stepped.fetch,
      sites: {
        [WWW_HOST]: { key: WWW_KEY, minResubmitIntervalMs: 0 },
        [BLOG_HOST]: { key: BLOG_KEY, keyPath: '/.well-known/{key}.txt', batchSize: 2 },
      },
    }))
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
    expect(a.pendingUrls.releaseFollowUps(WWW_HOST, 'lease-1', [staleClaim], 0, 0)).toEqual([])

    // resubmitted row re-leased elsewhere: the revision guard holds too
    a.db
      .prepare("UPDATE pending_urls SET lease_id = 'lease-2', revision = 2 WHERE url = ?")
      .run(url)
    expect(a.pendingUrls.deleteLeased(WWW_HOST, 'lease-1', [staleClaim])).toBe(0)
    expect(a.pendingUrls.releaseFollowUps(WWW_HOST, 'lease-1', [staleClaim], 0, 0)).toEqual([])

    const row = a.pendingUrls.get(WWW_HOST, url)!
    expect(row.lease_id).toBe('lease-2')
    expect(row.revision).toBe(2)
    expect(row.attempts).toBe(0)

    // a pre-existing floor higher than the success floor keeps bounding
    // due_at even if the clock moved backwards during delivery
    const floorAt = Date.now() + 3_600_000
    a.db
      .prepare("UPDATE pending_urls SET lease_id = 'lease-3', revision = 5, not_before_at = ?, due_at = ? WHERE url = ?")
      .run(floorAt, floorAt, url)
    const kept = a.pendingUrls.releaseFollowUps(
      WWW_HOST,
      'lease-3',
      [{ url, event_type: null, attempts: 0, revision: 4 }],
      0,
      0,
    )
    expect(kept).toEqual([url])
    const floored = a.pendingUrls.get(WWW_HOST, url)!
    expect(floored.not_before_at).toBe(floorAt)
    expect(floored.due_at).toBe(floorAt)
  })
})

describe('Retry-After and per-site cooldowns', () => {
  const url = (path: string): string => `https://www.example.com/${path}`

  function coolDownApp(respond: () => Response, sites?: Record<string, SiteConfigInput>) {
    const { fetch, calls } = recordingFetch(respond)
    const a = track(createTestApp({ fetchImpl: fetch, ...(sites === undefined ? {} : { sites }) }))
    return { a, calls }
  }

  test('a Retry-After in seconds parks the site and the URL', async () => {
    const sentAt = Date.now()
    const { a, calls } = coolDownApp(() => new Response('', { status: 429, headers: { 'retry-after': '60' } }))
    a.scheduler.start()

    a.enqueue.submit(findToken(a.config.auth.tokens, ADMIN_TOKEN)!, [url('a')], undefined)
    await waitFor(() => calls.length === 1, 3000, 'first 429')

    // own backoff (5-20ms in the test config) would have retried long ago
    await Bun.sleep(200)
    expect(calls).toHaveLength(1)

    const row = a.pendingUrls.get(WWW_HOST, url('a'))!
    expect(row.status).toBe('pending')
    expect(row.due_at).toBeGreaterThanOrEqual(sentAt + 60_000 - 1_000)
    expect(row.not_before_at).toBe(row.due_at)
    expect(a.siteState.retryNotBefore(WWW_HOST)).toBeGreaterThanOrEqual(sentAt + 60_000 - 1_000)
  })

  test('a Retry-After HTTP date parks the site until that date', async () => {
    const sentAt = Date.now()
    const waitUntil = new Date(sentAt + 120_000).toUTCString()
    const { a, calls } = coolDownApp(() => new Response('', { status: 429, headers: { 'retry-after': waitUntil } }))
    a.scheduler.start()

    a.enqueue.submit(findToken(a.config.auth.tokens, ADMIN_TOKEN)!, [url('a')], undefined)
    await waitFor(() => calls.length === 1, 3000, 'first 429')
    await Bun.sleep(150)

    expect(calls).toHaveLength(1)
    expect(a.pendingUrls.get(WWW_HOST, url('a'))!.due_at).toBeGreaterThanOrEqual(sentAt + 120_000 - 1_000)
  })

  test('an unparseable Retry-After falls back to the own backoff', async () => {
    let attempts = 0
    const { a, calls } = coolDownApp(() => {
      attempts += 1
      return attempts === 1
        ? new Response('', { status: 429, headers: { 'retry-after': 'in a bit' } })
        : new Response('', { status: 200 })
    })
    a.scheduler.start()

    a.enqueue.submit(findToken(a.config.auth.tokens, ADMIN_TOKEN)!, [url('a')], undefined)
    await waitFor(() => calls.length === 2, 3000, 'own-backoff retry')
    expect(a.pendingUrls.queueDepths().length).toBe(0)
  })

  test('other due URLs of a cooling site wait too; other sites proceed', async () => {
    const { a, calls } = coolDownApp(() => new Response('', { status: 429, headers: { 'retry-after': '60' } }), {
      [WWW_HOST]: { key: WWW_KEY, batchSize: 1 },
      [BLOG_HOST]: { key: BLOG_KEY, keyPath: '/.well-known/{key}.txt', batchSize: 2 },
    })
    a.scheduler.start()

    const token = findToken(a.config.auth.tokens, ADMIN_TOKEN)!
    a.enqueue.submit(token, [url('a'), url('b')], undefined)
    a.enqueue.submit(token, ['https://blog.example.com/x'], undefined)

    await waitFor(() => calls.length === 2, 3000, 'first www batch and the blog batch')
    await Bun.sleep(200)

    const wwwCalls = calls.filter((c) => c.body.host === WWW_HOST)
    const blogCalls = calls.filter((c) => c.body.host === BLOG_HOST)
    expect(wwwCalls).toHaveLength(1)
    expect(blogCalls).toHaveLength(1)

    const pending = new Map(a.pendingUrls.listQueue(WWW_HOST, 'pending', 10).map((row) => [row.url, row]))
    expect(pending.size).toBe(2)
    // the failed URL carries the server wait; the unsent URL is merely
    // parked behind the site-level cooldown
    expect(pending.get(url('a'))!.due_at).toBeGreaterThanOrEqual(Date.now() + 55_000)
    expect(pending.get(url('b'))!.due_at).toBeLessThanOrEqual(Date.now())
    expect(a.siteState.retryNotBefore(WWW_HOST)).toBeGreaterThan(Date.now())
  })

  test('a site cooldown survives a process restart', async () => {
    const dir = `${process.env.TMPDIR ?? '/tmp'}/indexnow-relay-restart-${crypto.randomUUID()}`
    const dbPath = `${dir}/relay.db`
    mkdirSync(dir, { recursive: true })

    const first = recordingFetch(() => new Response('', { status: 429, headers: { 'retry-after': '60' } }))
    const a = createTestApp({ fetchImpl: first.fetch, databasePath: dbPath })
    a.scheduler.start()
    a.enqueue.submit(findToken(a.config.auth.tokens, ADMIN_TOKEN)!, [url('a')], undefined)
    await waitFor(() => first.calls.length === 1, 3000, 'first 429')
    await closeApp(a)

    const second = recordingFetch(() => new Response('', { status: 200 }))
    const b = track(createTestApp({ fetchImpl: second.fetch, databasePath: dbPath }))
    b.scheduler.start()
    await Bun.sleep(250)

    expect(second.calls).toHaveLength(0)
    expect(b.siteState.retryNotBefore(WWW_HOST)).toBeGreaterThan(Date.now())
  })

  test('resuming a site does not bypass its cooldown', async () => {
    const { a, calls } = coolDownApp(() => new Response('', { status: 429, headers: { 'retry-after': '60' } }))
    a.scheduler.start()
    const token = findToken(a.config.auth.tokens, ADMIN_TOKEN)!

    a.enqueue.submit(token, [url('a')], undefined)
    await waitFor(() => calls.length === 1, 3000, 'first 429')
    await waitFor(() => a.siteState.retryNotBefore(WWW_HOST) > Date.now(), 3000, 'cooldown set')
    const cooldownAtPause = a.siteState.retryNotBefore(WWW_HOST)

    a.siteState.setPaused(WWW_HOST, true, 'ops', Date.now())
    a.siteState.setPaused(WWW_HOST, false, undefined, Date.now())
    // a fresh, immediately-due URL: only the site cooldown can hold it back
    a.enqueue.submit(token, [url('fresh')], undefined)
    a.scheduler.wake()
    await Bun.sleep(200)

    expect(calls).toHaveLength(1)
    expect(a.siteState.retryNotBefore(WWW_HOST)).toBe(cooldownAtPause)
  })

  test('pausing mid-drain finishes the in-flight batch and starts no new one', async () => {
    const stepped = steppedFetch()
    const a = track(createTestApp({
      fetchImpl: stepped.fetch,
      sites: { [WWW_HOST]: { key: WWW_KEY, batchSize: 1 }, [BLOG_HOST]: { key: BLOG_KEY, keyPath: '/.well-known/{key}.txt', batchSize: 2 } },
    }))
    a.scheduler.start()

    const token = findToken(a.config.auth.tokens, ADMIN_TOKEN)!
    a.enqueue.submit(token, [url('a'), url('b')], undefined)
    await waitFor(() => stepped.calls.length === 1, 3000, 'first batch in flight')

    a.siteState.setPaused(WWW_HOST, true, 'ops', Date.now())
    stepped.resolveNext(200)
    await Bun.sleep(200)

    expect(stepped.calls).toHaveLength(1)
    expect(a.pendingUrls.listQueue(WWW_HOST, 'pending', 10)).toHaveLength(1)
  })

  test('a lease lost mid-flight is recorded as a retry, not deaths', async () => {
    const stepped = steppedFetch()
    const a = track(createTestApp({ fetchImpl: stepped.fetch }))
    const token = findToken(a.config.auth.tokens, ADMIN_TOKEN)!
    let stop = false

    a.enqueue.submit(token, [url('a')], undefined)
    const draining = manualDrain(a, stepped.fetch, () => stop)
    await waitFor(() => stepped.calls.length === 1, 3000, 'batch in flight')

    // the lease expires and the sweep reclaims the rows while the HTTP
    // call is still pending (e.g. forward clock jump)
    a.db.prepare('UPDATE pending_urls SET lease_until = ? WHERE site_host = ?').run(Date.now() - 1, WWW_HOST)
    a.pendingUrls.clearExpiredLeases(Date.now())

    stop = true
    stepped.resolveNext(503)
    await draining

    const batch = a.batches.list(undefined, 10)[0]!
    expect(batch.status).toBe('retry_scheduled')
    expect(batch.error_message).toContain('lease expired')
    expect(batch.retry_at).toBe(a.siteState.retryNotBefore(WWW_HOST))

    // the stale worker's failure must not have touched the reclaimed rows
    const row = a.pendingUrls.get(WWW_HOST, url('a'))!
    expect(row.status).toBe('pending')
    expect(row.attempts).toBe(0)
    expect(row.lease_id).toBeNull()
  })

  test('exhausted retries are not recorded as a scheduled retry', async () => {
    const { a } = coolDownApp(() => new Response('', { status: 500 }))
    a.scheduler.start()

    a.enqueue.submit(findToken(a.config.auth.tokens, ADMIN_TOKEN)!, [url('a')], undefined)
    await waitFor(() => a.pendingUrls.listDead(undefined, 10).length === 1, 3000, 'dead letter')

    // only the first batch scheduled a retry; the exhausting batch is dead
    const statuses = a.batches.list(undefined, 10).map((b) => b.status)
    expect(statuses).toHaveLength(2)
    expect(statuses.filter((s) => s === 'dead')).toHaveLength(1)
    expect(statuses.filter((s) => s === 'retry_scheduled')).toHaveLength(1)
  })

  test('a mixed batch records the retry and dead-letters only the exhausted URL', async () => {
    const { a, calls } = coolDownApp(() => new Response('', { status: 500 }), {
      [WWW_HOST]: { key: WWW_KEY, batchSize: 2 }, [BLOG_HOST]: { key: BLOG_KEY, keyPath: '/.well-known/{key}.txt', batchSize: 2 },
    })

    const token = findToken(a.config.auth.tokens, ADMIN_TOKEN)!
    a.enqueue.submit(token, [url('exhausted'), url('fresh')], undefined)
    // one URL starts one attempt from its budget's end
    a.db
      .prepare('UPDATE pending_urls SET attempts = ? WHERE url = ?')
      .run(a.config.queue.maxAttempts - 1, url('exhausted'))
    a.scheduler.start()
    await waitFor(() => calls.length === 1, 3000, 'batch attempted')

    await waitFor(() => a.pendingUrls.listDead(undefined, 10).length === 1, 3000, 'dead letter')
    const dead = a.pendingUrls.listDead(undefined, 10)
    expect(dead[0]!.url).toBe(url('exhausted'))

    const stillPending = a.pendingUrls.listQueue(WWW_HOST, 'pending', 10)
    expect(stillPending.map((r) => r.url)).toEqual([url('fresh')])
    expect(a.batches.list(undefined, 10)[0]!.status).toBe('retry_scheduled')
  })
})
