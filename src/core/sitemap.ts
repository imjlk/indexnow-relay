import type { FetchLike } from '../indexnow/client.ts'

export type SitemapErrorCode = 'SITEMAP_FETCH_FAILED' | 'SITEMAP_INVALID' | 'SITEMAP_TOO_LARGE'

export class SitemapError extends Error {
  readonly code: SitemapErrorCode
  readonly detail?: Record<string, unknown>

  constructor(code: SitemapErrorCode, message: string, detail?: Record<string, unknown>) {
    super(message)
    this.name = 'SitemapError'
    this.code = code
    this.detail = detail
  }
}

/** Per-document cap; sitemapindex children each get the same budget. */
const MAX_BYTES_PER_DOCUMENT = 10 * 1024 * 1024
const MAX_TOTAL_BYTES = 50 * 1024 * 1024
const MAX_SITEMAP_DOCUMENTS = 50
const MAX_URLS = 10_000
const MAX_INDEX_DEPTH = 5
const FETCH_TIMEOUT_MS = 15_000

interface SitemapFetchOptions {
  fetchImpl?: FetchLike
  /** Injectable for tests; defaults to the module constants. */
  limits?: Partial<{ maxBytesPerDocument: number; maxTotalBytes: number; maxDocuments: number; maxUrls: number }>
}

/**
 * Fetches a sitemap (or sitemap index) and returns every `<loc>` URL from
 * its `<urlset>` entries. Sitemap indexes are followed breadth-first up to
 * {@link MAX_INDEX_DEPTH} levels. Caps guard memory: bytes per document,
 * total bytes, document count, and extracted URL count.
 *
 * @evidence docs/REQUIREMENTS.md#sitemap-ingestion Owns sitemap fetching
 *           and <loc> extraction (urlset + sitemapindex recursion, caps,
 *           entity/CDATA decoding) feeding the normal submission pipeline.
 */
export async function fetchSitemapUrls(sitemapUrl: string, options: SitemapFetchOptions = {}): Promise<string[]> {
  const limits = {
    maxBytesPerDocument: options.limits?.maxBytesPerDocument ?? MAX_BYTES_PER_DOCUMENT,
    maxTotalBytes: options.limits?.maxTotalBytes ?? MAX_TOTAL_BYTES,
    maxDocuments: options.limits?.maxDocuments ?? MAX_SITEMAP_DOCUMENTS,
    maxUrls: options.limits?.maxUrls ?? MAX_URLS,
  }
  const doFetch = options.fetchImpl ?? ((input, init) => fetch(input, init))

  const start = parseSitemapUrl(sitemapUrl)

  const queue: Array<{ url: URL; depth: number }> = [{ url: start, depth: 0 }]
  const visited = new Set<string>([start.href])
  const urls: string[] = []
  const seen = new Set<string>()
  let totalBytes = 0
  let documents = 0

  while (queue.length > 0) {
    const { url, depth } = queue.shift()!
    documents += 1
    if (documents > limits.maxDocuments) {
      throw new SitemapError('SITEMAP_TOO_LARGE', `Sitemap exceeds the limit of ${limits.maxDocuments} documents.`)
    }

    const body = await fetchDocument(url, doFetch, limits)

    const isIndex = /<sitemapindex[\s>]/i.test(body.slice(0, 2048))
    const locs = extractLocs(body)

    if (isIndex) {
      if (depth >= MAX_INDEX_DEPTH) {
        throw new SitemapError('SITEMAP_INVALID', `Sitemap index nesting exceeds ${MAX_INDEX_DEPTH} levels.`)
      }
      for (const loc of locs) {
        const child = new URL(loc, url)
        if (child.protocol !== 'http:' && child.protocol !== 'https:') continue
        if (visited.has(child.href)) continue
        visited.add(child.href)
        queue.push({ url: child, depth: depth + 1 })
      }
      continue
    }

    for (const loc of locs) {
      const absolute = new URL(loc, url)
      if (absolute.protocol !== 'http:' && absolute.protocol !== 'https:') continue
      if (seen.has(absolute.href)) continue
      seen.add(absolute.href)
      urls.push(absolute.href)
      if (urls.length > limits.maxUrls) {
        throw new SitemapError('SITEMAP_TOO_LARGE', `Sitemap yields more than ${limits.maxUrls} URLs.`, {
          limit: limits.maxUrls,
        })
      }
    }
  }

  if (urls.length === 0) {
    throw new SitemapError('SITEMAP_INVALID', 'Sitemap contained no <loc> URLs.')
  }

  return urls

  async function fetchDocument(url: URL, fetchImpl: FetchLike, caps: typeof limits): Promise<string> {
    let response: Response
    try {
      response = await fetchImpl(url.href, {
        redirect: 'follow',
        headers: { accept: 'application/xml, text/xml, */*' },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      })
    } catch {
      throw new SitemapError('SITEMAP_FETCH_FAILED', `Failed to fetch sitemap from ${url.href}.`)
    }

    if (!response.ok) {
      throw new SitemapError('SITEMAP_FETCH_FAILED', `Fetching sitemap from ${url.href} returned HTTP ${response.status}.`)
    }
    if (response.body === null) {
      throw new SitemapError('SITEMAP_INVALID', `Sitemap document from ${url.href} is empty.`)
    }

    const reader = response.body.getReader()
    const chunks: Uint8Array[] = []
    let documentBytes = 0
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      documentBytes += value.byteLength
      if (documentBytes > caps.maxBytesPerDocument || totalBytes + documentBytes > caps.maxTotalBytes) {
        throw new SitemapError('SITEMAP_TOO_LARGE', `Sitemap document from ${url.href} exceeds the size limit.`)
      }
      chunks.push(value)
    }
    totalBytes += documentBytes

    const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0)
    const merged = new Uint8Array(total)
    let offset = 0
    for (const chunk of chunks) {
      merged.set(chunk, offset)
      offset += chunk.byteLength
    }
    return new TextDecoder('utf-8').decode(merged)
  }
}

function parseSitemapUrl(raw: string): URL {
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    throw new SitemapError('SITEMAP_INVALID', 'The sitemap URL is not a valid absolute URL.')
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new SitemapError('SITEMAP_INVALID', 'The sitemap URL must use http or https.')
  }
  return parsed
}

const LOC_PATTERN = /<loc>\s*(?:<!\[CDATA\[([\s\S]*?)\]\]>|([^<]*?))\s*<\/loc>/gi

/** Extracts and entity-decodes every `<loc>` value; CDATA aware. */
export function extractLocs(xml: string): string[] {
  const locs: string[] = []
  for (const match of xml.matchAll(LOC_PATTERN)) {
    const raw = match[1] ?? match[2] ?? ''
    const decoded = decodeXmlEntities(raw)
    if (decoded.length > 0) locs.push(decoded)
  }
  return locs
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
}

export function decodeXmlEntities(value: string): string {
  return value.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, entity: string) => {
    if (entity.startsWith('#x') || entity.startsWith('#X')) {
      const code = Number.parseInt(entity.slice(2), 16)
      return Number.isNaN(code) ? whole : String.fromCodePoint(code)
    }
    if (entity.startsWith('#')) {
      const code = Number.parseInt(entity.slice(1), 10)
      return Number.isNaN(code) ? whole : String.fromCodePoint(code)
    }
    return NAMED_ENTITIES[entity] ?? whole
  })
}
