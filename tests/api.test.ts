import { afterEach, describe, expect, test } from 'bun:test'

import { closeApp, routeRequest } from '../src/app.ts'
import type { RelayApp } from '../src/api/context.ts'
import type { FetchLike } from '../src/indexnow/client.ts'
import { ADMIN_TOKEN, BLOG_TOKEN, WWW_HOST, createTestApp, readJson } from './helpers/app.ts'

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

const BASE = 'http://relay.test'

const postUrls = (body: unknown, token?: string): Promise<Response> =>
  routeRequest(
    track(createTestApp({ fetchImpl: neverCalledFetch() })),
    new Request(`${BASE}/v1/urls`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
      },
      body: JSON.stringify(body),
    }),
  )

function neverCalledFetch(): FetchLike {
  return async () => {
    throw new Error('IndexNow must not be called in these tests')
  }
}

describe('POST /v1/urls', () => {
  test('requires a bearer token', async () => {
    const response = await postUrls({ urls: [`https://${WWW_HOST}/a`] })
    expect(response.status).toBe(401)
    const body = await readJson(response)
    expect(body['code']).toBe('UNAUTHORIZED')
  })

  test('rejects an unknown token', async () => {
    const response = await postUrls({ urls: [`https://${WWW_HOST}/a`] }, 'wrong-token-0000000000000')
    expect(response.status).toBe(401)
  })

  test('rejects an empty URL list at the schema layer', async () => {
    const response = await postUrls({ urls: [] }, ADMIN_TOKEN)
    expect(response.status).toBe(400)
  })

  test('rejects unknown top-level properties at the schema layer', async () => {
    const response = await postUrls({ urls: [`https://${WWW_HOST}/a`], nope: true }, ADMIN_TOKEN)
    expect(response.status).toBe(400)
  })

  test('rejects semantically invalid URLs with INVALID_URL', async () => {
    const response = await postUrls({ urls: ['ftp://www.example.com/file'] }, ADMIN_TOKEN)
    expect(response.status).toBe(400)
    const body = await readJson(response)
    expect(body['code']).toBe('INVALID_URL')
  })

  test('rejects unconfigured hosts with UNKNOWN_SITE', async () => {
    const response = await postUrls({ urls: ['https://other.example.org/x'] }, ADMIN_TOKEN)
    expect(response.status).toBe(400)
    const body = await readJson(response)
    expect(body['code']).toBe('UNKNOWN_SITE')
  })

  test('enforces token scopes with FORBIDDEN_SITE', async () => {
    const response = await postUrls({ urls: [`https://${WWW_HOST}/a`] }, BLOG_TOKEN)
    expect(response.status).toBe(403)
    const body = await readJson(response)
    expect(body['code']).toBe('FORBIDDEN_SITE')
  })

  test('accepts a multi-site submission and returns a receipt', async () => {
    const response = await postUrls(
      { urls: [`https://${WWW_HOST}/a`, 'https://blog.example.com/b'], event: 'updated' },
      ADMIN_TOKEN,
    )
    expect(response.status).toBe(200)
    const body = await readJson(response)

    expect(body['receiptId']).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/)
    expect(body['received']).toBe(2)
    expect(body['enqueued']).toBe(2)
    expect(body['sites']).toEqual([
      { host: WWW_HOST, enqueued: 1, coalesced: 0 },
      { host: 'blog.example.com', enqueued: 1, coalesced: 0 },
    ])
  })
})

describe('GET /v1/receipts/{id}', () => {
  test('returns receipt progress and 404 for unknown ids', async () => {
    const a = track(createTestApp({ fetchImpl: neverCalledFetch() }))

    const submit = await routeRequest(
      a,
      new Request(`${BASE}/v1/urls`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${ADMIN_TOKEN}` },
        body: JSON.stringify({ urls: [`https://${WWW_HOST}/a`] }),
      }),
    )
    const { receiptId } = (await readJson(submit)) as { receiptId: string }

    const found = await routeRequest(a, new Request(`${BASE}/v1/receipts/${receiptId}`, { headers: { authorization: `Bearer ${ADMIN_TOKEN}` } }))
    expect(found.status).toBe(200)
    const body = await readJson(found)
    expect(body['stillPending']).toBe(1)

    const missing = await routeRequest(
      a,
      new Request(`${BASE}/v1/receipts/01AAAAAAAAAAAAAAAAAAAAAAAA`, { headers: { authorization: `Bearer ${ADMIN_TOKEN}` } }),
    )
    expect(missing.status).toBe(404)
  })

  test('hides receipts from tokens without access to every involved site', async () => {
    const a = track(createTestApp({ fetchImpl: neverCalledFetch() }))
    const submit = await routeRequest(
      a,
      new Request(`${BASE}/v1/urls`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${ADMIN_TOKEN}` },
        body: JSON.stringify({ urls: [`https://${WWW_HOST}/a`] }),
      }),
    )
    const { receiptId } = (await readJson(submit)) as { receiptId: string }

    const response = await routeRequest(
      a,
      new Request(`${BASE}/v1/receipts/${receiptId}`, { headers: { authorization: `Bearer ${BLOG_TOKEN}` } }),
    )
    expect(response.status).toBe(404)
  })
})

describe('admin endpoints', () => {
  test('rejects scoped tokens', async () => {
    const a = track(createTestApp({ fetchImpl: neverCalledFetch() }))
    const response = await routeRequest(
      a,
      new Request(`${BASE}/v1/admin/overview`, { headers: { authorization: `Bearer ${BLOG_TOKEN}` } }),
    )
    expect(response.status).toBe(403)
    const body = await readJson(response)
    expect(body['code']).toBe('FORBIDDEN')
  })

  test('overview lists sites with queue depths', async () => {
    const a = track(createTestApp({ fetchImpl: neverCalledFetch() }))

    await routeRequest(
      a,
      new Request(`${BASE}/v1/urls`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${ADMIN_TOKEN}` },
        body: JSON.stringify({ urls: [`https://${WWW_HOST}/a`] }),
      }),
    )

    const response = await routeRequest(
      a,
      new Request(`${BASE}/v1/admin/overview`, { headers: { authorization: `Bearer ${ADMIN_TOKEN}` } }),
    )
    expect(response.status).toBe(200)
    const body = await readJson(response)
    const sites = body['sites'] as Array<{ host: string; pending: number }>
    expect(sites.find((s) => s.host === WWW_HOST)!.pending).toBe(1)
  })

  test('parses and validates numeric list limits from query parameters', async () => {
    const a = track(createTestApp({ fetchImpl: neverCalledFetch() }))
    const headers = { authorization: `Bearer ${ADMIN_TOKEN}` }

    const batches = await routeRequest(a, new Request(`${BASE}/v1/admin/batches?limit=10`, { headers }))
    expect(batches.status).toBe(200)

    const deadLetters = await routeRequest(
      a,
      new Request(`${BASE}/v1/admin/dead-letters?site=${WWW_HOST}&limit=10`, { headers }),
    )
    expect(deadLetters.status).toBe(200)

    const belowMinimum = await routeRequest(
      a,
      new Request(`${BASE}/v1/admin/dead-letters?limit=0`, { headers }),
    )
    expect(belowMinimum.status).toBe(400)

    const invalid = await routeRequest(
      a,
      new Request(`${BASE}/v1/admin/batches?limit=not-a-number`, { headers }),
    )
    expect(invalid.status).toBe(400)
  })

  test('pause and resume a site', async () => {
    const a = track(createTestApp({ fetchImpl: neverCalledFetch() }))

    const paused = await routeRequest(
      a,
      new Request(`${BASE}/v1/admin/sites/${WWW_HOST}/pause`, {
        method: 'POST',
        headers: { authorization: `Bearer ${ADMIN_TOKEN}`, 'content-type': 'application/json' },
        body: JSON.stringify({ host: WWW_HOST, reason: 'maintenance window' }),
      }),
    )
    expect(paused.status).toBe(200)
    expect(((await readJson(paused))['host'] as string)).toBe(WWW_HOST)

    const unknown = await routeRequest(
      a,
      new Request(`${BASE}/v1/admin/sites/nope.example.org/pause`, {
        method: 'POST',
        headers: { authorization: `Bearer ${ADMIN_TOKEN}`, 'content-type': 'application/json' },
        body: JSON.stringify({ host: 'nope.example.org' }),
      }),
    )
    expect(unknown.status).toBe(404)

    const resumed = await routeRequest(
      a,
      new Request(`${BASE}/v1/admin/sites/${WWW_HOST}/resume`, {
        method: 'POST',
        headers: { authorization: `Bearer ${ADMIN_TOKEN}`, 'content-type': 'application/json' },
        body: JSON.stringify({ host: WWW_HOST }),
      }),
    )
    expect(resumed.status).toBe(200)
  })
})

describe('health and docs', () => {
  test('health aliases: /health/live + /healthz, /health/ready + /readyz', async () => {
    const a = track(createTestApp({ fetchImpl: neverCalledFetch() }))
    expect((await routeRequest(a, new Request(`${BASE}/health/live`))).status).toBe(200)
    expect((await routeRequest(a, new Request(`${BASE}/healthz`))).status).toBe(200)
    expect((await routeRequest(a, new Request(`${BASE}/health/ready`))).status).toBe(503)
    a.scheduler.start()
    expect((await routeRequest(a, new Request(`${BASE}/health/ready`))).status).toBe(200)
  })

  test('healthz is always live; readyz requires a running scheduler', async () => {
    const a = track(createTestApp({ fetchImpl: neverCalledFetch() }))

    const live = await routeRequest(a, new Request(`${BASE}/healthz`))
    expect(live.status).toBe(200)

    const notReady = await routeRequest(a, new Request(`${BASE}/readyz`))
    expect(notReady.status).toBe(503)

    a.scheduler.start()
    const ready = await routeRequest(a, new Request(`${BASE}/readyz`))
    expect(ready.status).toBe(200)
  })

  test('serves the OpenAPI spec and the docs UI', async () => {
    const a = track(createTestApp({ fetchImpl: neverCalledFetch() }))
    const spec = await routeRequest(a, new Request(`${BASE}/openapi.json`))
    expect(spec.status).toBe(200)
    const document = await readJson(spec)
    expect(document['openapi']).toMatch(/^3\.1\./)
    expect((document['paths'] as Record<string, unknown>)['/v1/urls']).toBeDefined()

    const docs = await routeRequest(a, new Request(`${BASE}/`))
    expect(docs.status).toBe(200)
  })

  test('unknown paths return a JSON 404', async () => {
    const a = track(createTestApp({ fetchImpl: neverCalledFetch() }))
    const response = await routeRequest(a, new Request(`${BASE}/nope`))
    expect(response.status).toBe(404)
    const body = await readJson(response)
    expect(body['code']).toBe('NOT_FOUND')
  })
})
