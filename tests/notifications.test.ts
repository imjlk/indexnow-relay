import { describe, expect, test } from 'bun:test'

import { routeRequest, closeApp } from '../src/app.ts'
import type { RelayApp } from '../src/api/context.ts'
import type { FetchLike } from '../src/indexnow/client.ts'
import { WebhookNotifier } from '../src/observability/notifier.ts'
import { normalizeRelayConfig } from '../src/config/index.ts'
import { ADMIN_TOKEN, WWW_HOST, createTestApp, waitFor } from './helpers/app.ts'
import type { RelayConfigInput } from '../src/config/index.ts'

const notification = {
  site: 'www.example.com',
  batchId: '01ABC',
  deadUrls: 3,
  reason: 'http_403',
  httpStatus: 403,
}

const silentLogger = { info: () => {}, warn: () => {}, error: () => {} }

describe('WebhookNotifier', () => {
  const build = (fetchImpl: FetchLike, url = 'https://hooks.example.com/hook') =>
    new WebhookNotifier({ webhookUrl: url, format: 'auto', logger: silentLogger, fetchImpl, sleep: async () => {} })

  test('disabled notifier is a no-op', async () => {
    let calls = 0
    const notifier = new WebhookNotifier({
      webhookUrl: null,
      format: 'auto',
      logger: silentLogger,
      fetchImpl: async () => {
        calls += 1
        throw new Error('must not be called')
      },
    })
    expect(notifier.enabled).toBe(false)
    notifier.notifyDeadLetters(notification)
    await Bun.sleep(10)
    expect(calls).toBe(0)
  })

  test('auto-detects Slack and Discord payloads; generic otherwise', async () => {
    const bodies: Array<{ url: string; body: string }> = []
    const fetchImpl: FetchLike = async (url, init) => {
      bodies.push({ url, body: String(init.body) })
      return new Response('', { status: 200 })
    }

    build(fetchImpl, 'https://hooks.slack.com/services/T00/B00/xx').notifyDeadLetters(notification)
    build(fetchImpl, 'https://discord.com/api/webhooks/123/abc').notifyDeadLetters(notification)
    build(fetchImpl, 'https://ntfy.example.com/my-topic').notifyDeadLetters(notification)
    await waitFor(() => bodies.length === 3, 2000, 'webhook deliveries')

    expect(JSON.parse(bodies[0]!.body)).toEqual({ text: expect.stringContaining('dead letters') })
    expect(JSON.parse(bodies[1]!.body)).toEqual({ content: expect.stringContaining('dead letters') })
    const generic = JSON.parse(bodies[2]!.body) as Record<string, unknown>
    expect(generic['event']).toBe('dead_letters')
    expect(generic['deadUrls']).toBe(3)
    expect(generic['httpStatus']).toBe(403)
    // counts and reasons only - never the affected URLs
    expect(generic['urls']).toBeUndefined()
    expect(JSON.stringify(generic)).not.toContain('/doomed')
  })

  test('format override beats auto-detection', () => {
    const notifier = new WebhookNotifier({
      webhookUrl: 'https://hooks.slack.com/services/x',
      format: 'generic',
      logger: silentLogger,
    })
    const body = notifier.bodyFor('https://hooks.slack.com/services/x', notification)
    expect((JSON.parse(body) as Record<string, unknown>)['event']).toBe('dead_letters')
  })

  test('retries rejected deliveries, then succeeds', async () => {
    let calls = 0
    const fetchImpl: FetchLike = async () => {
      calls += 1
      return new Response('', { status: calls === 1 ? 500 : 200 })
    }
    build(fetchImpl).notifyDeadLetters(notification)
    await waitFor(() => calls === 2, 2000, 'retry')
    expect(calls).toBe(2)
  })

  test('gives up after three attempts without throwing', async () => {
    let calls = 0
    const fetchImpl: FetchLike = async () => {
      calls += 1
      return new Response('', { status: 500 })
    }
    build(fetchImpl).notifyDeadLetters(notification)
    await waitFor(() => calls === 3, 3000, 'three attempts')
    await Bun.sleep(20)
    expect(calls).toBe(3)
  })
})

describe('notifications configuration', () => {
  const base = (overrides: Partial<RelayConfigInput> = {}): RelayConfigInput => ({
    auth: 'operator-token-000000000001',
    sites: { 'www.example.com': 'a1b2c3d4e5f60718' },
    ...overrides,
  })

  test('unset means disabled', () => {
    const saved = process.env['INDEXNOW_WEBHOOK_URL']
    delete process.env['INDEXNOW_WEBHOOK_URL']
    expect(normalizeRelayConfig(base()).notifications).toEqual({ webhookUrl: null, format: 'auto' })
    if (saved !== undefined) process.env['INDEXNOW_WEBHOOK_URL'] = saved
  })

  test('falls back to INDEXNOW_WEBHOOK_URL and honors config + format', () => {
    const saved = process.env['INDEXNOW_WEBHOOK_URL']
    process.env['INDEXNOW_WEBHOOK_URL'] = 'https://hooks.example.com/env'
    expect(normalizeRelayConfig(base()).notifications.webhookUrl).toBe('https://hooks.example.com/env')

    const config = normalizeRelayConfig(
      base({
        notifications: { webhookUrl: 'https://hooks.slack.com/services/x', format: 'slack' },
      }),
    )
    expect(config.notifications).toEqual({ webhookUrl: 'https://hooks.slack.com/services/x', format: 'slack' })
    if (saved === undefined) delete process.env['INDEXNOW_WEBHOOK_URL']
    else process.env['INDEXNOW_WEBHOOK_URL'] = saved
  })
})

describe('worker fires webhooks on dead letters', () => {
  test('permanent IndexNow failure delivers a notification', async () => {
    const webhookBodies: string[] = []
    const webhookFetch: FetchLike = async (_url, init) => {
      webhookBodies.push(String(init.body))
      return new Response('', { status: 200 })
    }
    // IndexNow always 403 -> immediate dead letters; webhook never called by IndexNow client
    const indexNowFetch: FetchLike = async (url) => {
      if (url.includes('api.indexnow.org')) return new Response('', { status: 403 })
      return new Response('', { status: 200 })
    }

    const app: RelayApp = createTestApp({
      fetchImpl: indexNowFetch,
      webhookFetch,
      webhookUrl: 'https://hooks.example.com/dead',
      queue: { batchWindowMs: 0, maxAttempts: 1 },
    })
    app.scheduler.start()

    await routeRequest(
      app,
      new Request('http://relay.test/v1/urls', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${ADMIN_TOKEN}` },
        body: JSON.stringify({ urls: [`https://${WWW_HOST}/doomed`] }),
      }),
    )

    await waitFor(() => webhookBodies.length === 1, 3000, 'webhook notification')
    const payload = JSON.parse(webhookBodies[0]!) as Record<string, unknown>
    expect(payload['event']).toBe('dead_letters')
    expect(payload['site']).toBe(WWW_HOST)
    expect(payload['deadUrls']).toBe(1)
    expect(payload['httpStatus']).toBe(403)

    await closeApp(app)
  })
})
