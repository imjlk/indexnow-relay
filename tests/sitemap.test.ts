import { describe, expect, test } from 'bun:test'

import { routeRequest } from '../src/app.ts'
import type { RelayApp } from '../src/api/context.ts'
import type { FetchLike } from '../src/indexnow/client.ts'
import { decodeXmlEntities, extractLocs, fetchSitemapUrls, SitemapError } from '../src/core/sitemap.ts'
import { ADMIN_TOKEN, WWW_HOST, createTestApp, readJson } from './helpers/app.ts'

const xmlResponse = (xml: string): Response =>
  new Response(xml, { status: 200, headers: { 'content-type': 'application/xml' } })

const URLSET = (urls: string[]): string =>
  `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls
    .map((url) => `<url><loc>${url}</loc></url>`)
    .join('')}</urlset>`

describe('sitemap parsing', () => {
  test('extracts <loc> values with whitespace trimmed', () => {
    expect(extractLocs(URLSET(['https://www.example.com/a', 'https://www.example.com/b']))).toEqual([
      'https://www.example.com/a',
      'https://www.example.com/b',
    ])
  })

  test('handles CDATA and XML entities', () => {
    const xml = '<urlset><url><loc><![CDATA[https://www.example.com/a&amp;b]]></loc></url>' +
      '<url><loc>https://www.example.com/&#x3A;&#39;q&#39;</loc></url></urlset>'
    expect(extractLocs(xml)).toEqual(['https://www.example.com/a&b', "https://www.example.com/:'q'"])
  })

  test('decodes named, decimal, and hex entities; passes unknowns through', () => {
    expect(decodeXmlEntities('&amp;&lt;&gt;&quot;&apos;')).toBe('&<>"\'')
    expect(decodeXmlEntities('&#65;&#x42;')).toBe('AB')
    expect(decodeXmlEntities('&nbsp;')).toBe('&nbsp;')
  })
})

describe('fetchSitemapUrls', () => {
  const serve = (docs: Record<string, string>): FetchLike =>
    async (url: string) => {
      const body = docs[url]
      if (body === undefined) return new Response('not found', { status: 404 })
      return xmlResponse(body)
    }

  test('fetches a urlset and resolves relative locs', async () => {
    const urls = await fetchSitemapUrls('https://www.example.com/sitemap.xml', {
      fetchImpl: serve({
        'https://www.example.com/sitemap.xml': URLSET(['/a', 'https://www.example.com/b']),
      }),
    })
    expect(urls).toEqual(['https://www.example.com/a', 'https://www.example.com/b'])
  })

  test('follows sitemap indexes breadth-first and dedupes', async () => {
    const urls = await fetchSitemapUrls('https://www.example.com/index.xml', {
      fetchImpl: serve({
        'https://www.example.com/index.xml':
          '<sitemapindex><sitemap><loc>https://www.example.com/a.xml</loc></sitemap>' +
          '<sitemap><loc>/b.xml</loc></sitemap></sitemapindex>',
        'https://www.example.com/a.xml': URLSET(['https://www.example.com/1']),
        'https://www.example.com/b.xml': URLSET(['https://www.example.com/1', 'https://www.example.com/2']),
      }),
    })
    expect(urls.sort()).toEqual(['https://www.example.com/1', 'https://www.example.com/2'])
  })

  test('network failures and HTTP errors are SITEMAP_FETCH_FAILED', async () => {
    const networkFail: FetchLike = async () => {
      throw new Error('ECONNRESET')
    }
    await expect(fetchSitemapUrls('https://x.example.com/s.xml', { fetchImpl: networkFail })).rejects.toThrow(
      SitemapError,
    )

    await expect(
      fetchSitemapUrls('https://www.example.com/sitemap.xml', { fetchImpl: serve({}) }),
    ).rejects.toThrow(/HTTP 404/)
  })

  test('documents without locs are SITEMAP_INVALID; URL caps are SITEMAP_TOO_LARGE', async () => {
    await expect(
      fetchSitemapUrls('https://www.example.com/sitemap.xml', {
        fetchImpl: serve({ 'https://www.example.com/sitemap.xml': '<html><body>nope</body></html>' }),
      }),
    ).rejects.toThrow(/no <loc>/)

    await expect(
      fetchSitemapUrls('https://www.example.com/sitemap.xml', {
        fetchImpl: serve({
          'https://www.example.com/sitemap.xml': URLSET(['/1', '/2', '/3']),
        }),
        limits: { maxUrls: 2 },
      }),
    ).rejects.toThrow(/more than 2/)
  })
})

describe('POST /v1/sitemap', () => {
  const BASE = 'http://relay.test'

  function sitemapApp(xml: string): { app: RelayApp; calls: string[] } {
    const calls: string[] = []
    const sitemapUrl = `https://${WWW_HOST}/sitemap.xml`
    const fetchImpl: FetchLike = async (url: string) => {
      calls.push(url)
      if (url === sitemapUrl) return xmlResponse(xml)
      if (url === `https://${WWW_HOST}/missing-sitemap.xml`) return new Response('not found', { status: 404 })
      return new Response('', { status: 200 }) // IndexNow endpoint
    }
    const app = createTestApp({
      fetchImpl,
      queue: { batchWindowMs: 600_000, maxCoalesceDelayMs: 700_000 },
    })
    return { app, calls }
  }

  test('ingests a sitemap through the normal pipeline', async () => {
    const { app, calls } = sitemapApp(URLSET([`https://${WWW_HOST}/one`, `https://${WWW_HOST}/two`]))

    const response = await routeRequest(
      app,
      new Request(`${BASE}/v1/sitemap`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${ADMIN_TOKEN}` },
        body: JSON.stringify({ url: `https://${WWW_HOST}/sitemap.xml` }),
      }),
    )

    expect(response.status).toBe(200)
    const body = (await readJson(response)) as Record<string, unknown>
    expect(body['received']).toBe(2)
    expect(body['enqueued']).toBe(2)
    expect(calls).toEqual([`https://${WWW_HOST}/sitemap.xml`]) // IndexNow not called yet (batch window)
  })

  test('a sitemap with an unconfigured host rejects the whole request', async () => {
    const { app } = sitemapApp(URLSET([`https://${WWW_HOST}/ok`, 'https://other.example.org/nope']))

    const response = await routeRequest(
      app,
      new Request(`${BASE}/v1/sitemap`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${ADMIN_TOKEN}` },
        body: JSON.stringify({ url: `https://${WWW_HOST}/sitemap.xml` }),
      }),
    )

    expect(response.status).toBe(400)
    const body = await readJson(response)
    expect(body['code']).toBe('UNKNOWN_SITE')
    expect(app.pendingUrls.queueDepths()).toEqual([]) // nothing enqueued
  })

  test('sitemap fetch failures surface as 502 SITEMAP_FETCH_FAILED', async () => {
    const { app } = sitemapApp('<urlset></urlset>')

    const response = await routeRequest(
      app,
      new Request(`${BASE}/v1/sitemap`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${ADMIN_TOKEN}` },
        body: JSON.stringify({ url: `https://${WWW_HOST}/missing-sitemap.xml` }),
      }),
    )

    expect(response.status).toBe(502)
    const body = await readJson(response)
    expect(body['code']).toBe('SITEMAP_FETCH_FAILED')
  })
})
