import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { buildApp } from '../../src/app.ts'
import type { RelayApp } from '../../src/api/context.ts'
import { normalizeRelayConfig } from '../../src/config/index.ts'
import type { QueueConfigInput } from '../../src/config/index.ts'
import type { FetchLike } from '../../src/indexnow/client.ts'
import { Logger } from '../../src/observability/logger.ts'

export const ADMIN_TOKEN = 'test-admin-token-000000000001'
export const BLOG_TOKEN = 'test-blog-token-000000000001'

export const WWW_HOST = 'www.example.com'
export const BLOG_HOST = 'blog.example.com'
export const WWW_KEY = 'a1b2c3d4e5f60718'
export const BLOG_KEY = 'b1b2c3d4e5f60719'

export interface TestAppOptions {
  fetchImpl?: FetchLike
  queue?: Partial<QueueConfigInput>
}

/**
 * A production-wired app on a temp database with tiny timings and an
 * injectable IndexNow fetch. The scheduler is NOT started - each test
 * decides.
 */
export function createTestApp(options: TestAppOptions = {}): RelayApp {
  const dir = mkdtempSync(join(tmpdir(), 'indexnow-relay-test-'))

  const config = normalizeRelayConfig({
    auth: {
      tokens: {
        admin: { value: ADMIN_TOKEN, sites: '*' },
        blog: { value: BLOG_TOKEN, sites: [BLOG_HOST] },
      },
    },
    sites: {
      [WWW_HOST]: WWW_KEY,
      [BLOG_HOST]: { key: BLOG_KEY, keyPath: '/.well-known/{key}.txt', batchSize: 2 },
    },
    database: { path: join(dir, 'relay.db') },
    queue: {
      pollIntervalMs: 20,
      batchWindowMs: 0,
      maxCoalesceDelayMs: 50,
      maxAttempts: 2,
      backoffBaseMs: 5,
      backoffMaxMs: 20,
      httpTimeoutMs: 200,
      ...options.queue,
    },
  })

  return buildApp(config, {
    fetchImpl: options.fetchImpl,
    logger: new Logger('error'),
  })
}

export async function waitFor(predicate: () => boolean, timeoutMs = 3000, what = 'condition'): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await Bun.sleep(10)
  }
  throw new Error(`Timed out waiting for ${what}`)
}

export async function readJson(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>
}

export function authorized(request: Request, token: string): Request {
  const headers = new Headers(request.headers)
  headers.set('authorization', `Bearer ${token}`)
  return new Request(request, { headers })
}

export function postJson(url: string, body: unknown, token?: string): Request {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (token !== undefined) headers['authorization'] = `Bearer ${token}`
  return new Request(url, { method: 'POST', headers, body: JSON.stringify(body) })
}

export function get(url: string, token?: string): Request {
  const headers: Record<string, string> = {}
  if (token !== undefined) headers['authorization'] = `Bearer ${token}`
  return new Request(url, { method: 'GET', headers })
}
