import type { FetchLike } from '../indexnow/client.ts'
import type { Logger } from './logger.ts'

export type WebhookDialect = 'generic' | 'slack' | 'discord'

export interface DeadLettersNotification {
  site: string
  batchId: string
  deadUrls: number
  reason: string
  httpStatus: number | undefined
}

const DELIVERY_ATTEMPTS = 3
const RETRY_DELAY_MS = 2_000
const REQUEST_TIMEOUT_MS = 10_000

const SLACK_HOST = 'hooks.slack.com'
const DISCORD_HOST_PATTERN = /(^|\.)discord(app)?\.com$/

/**
 * Best-effort dead-letter webhook notifications.
 *
 * Fires fire-and-forget whenever URLs become dead letters, so a broken
 * IndexNow key or a persistently failing site surfaces immediately instead
 * of days later. Payloads are dialect-adaptive (`generic` JSON, Slack
 * `{"text"}`, Discord `{"content"}`, auto-detected from the URL host) and
 * deliberately contain no secrets and no URL bodies - counts, reason, and
 * identifiers only; the full dead-letter list stays behind the admin API.
 *
 * @evidence docs/REQUIREMENTS.md#notifications Owns dead-letter webhook
 *           delivery: dialect adaptation, bounded retries, and
 *           secret-free payloads.
 */
export class WebhookNotifier {
  readonly #url: string | null
  readonly #format: 'auto' | WebhookDialect
  readonly #logger: Pick<Logger, 'info' | 'warn' | 'error'>
  readonly #fetch: FetchLike
  readonly #sleep: (ms: number) => Promise<void>

  constructor(options: {
    webhookUrl: string | null
    format: 'auto' | WebhookDialect
    logger: Pick<Logger, 'info' | 'warn' | 'error'>
    fetchImpl?: FetchLike
    sleep?: (ms: number) => Promise<void>
  }) {
    this.#url = options.webhookUrl
    this.#format = options.format
    this.#logger = options.logger
    this.#fetch = options.fetchImpl ?? ((input, init) => fetch(input, init))
    this.#sleep = options.sleep ?? ((ms) => Bun.sleep(ms))
  }

  get enabled(): boolean {
    return this.#url !== null
  }

  /** Never throws, never blocks the caller: delivery is fire-and-forget. */
  notifyDeadLetters(notification: DeadLettersNotification): void {
    if (this.#url === null) return
    void this.#deliver(this.#url, notification).catch(() => {
      // #deliver already logs; this catch only guards against rejections
      // escaping the retry loop itself.
    })
  }

  bodyFor(url: string, notification: DeadLettersNotification): string {
    return JSON.stringify(this.#payloadFor(this.#dialectFor(url), notification))
  }

  async #deliver(url: string, notification: DeadLettersNotification): Promise<void> {
    const body = this.bodyFor(url, notification)

    for (let attempt = 1; attempt <= DELIVERY_ATTEMPTS; attempt += 1) {
      try {
        const response = await this.#fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body,
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        })
        if (response.ok) return
        this.#logger.warn('webhook notification rejected', {
          site: notification.site,
          httpStatus: response.status,
          attempt,
        })
      } catch {
        this.#logger.warn('webhook notification failed', { site: notification.site, attempt })
      }
      if (attempt < DELIVERY_ATTEMPTS) await this.#sleep(RETRY_DELAY_MS)
    }

    this.#logger.error('webhook notification abandoned', {
      site: notification.site,
      batchId: notification.batchId,
      deadUrls: notification.deadUrls,
      attempts: DELIVERY_ATTEMPTS,
    })
  }

  #dialectFor(url: string): WebhookDialect {
    if (this.#format !== 'auto') return this.#format
    try {
      const host = new URL(url).hostname.toLowerCase()
      if (host === SLACK_HOST) return 'slack'
      if (DISCORD_HOST_PATTERN.test(host)) return 'discord'
    } catch {
      // Unparseable URL falls through to the generic dialect.
    }
    return 'generic'
  }

  #payloadFor(dialect: WebhookDialect, notification: DeadLettersNotification): Record<string, unknown> {
    const suffix =
      notification.httpStatus === undefined
        ? `(${notification.reason})`
        : `(${notification.reason}, HTTP ${notification.httpStatus})`
    const text =
      `indexnow-relay: ${notification.deadUrls} URL(s) for ${notification.site} ` +
      `moved to dead letters ${suffix}. Batch ${notification.batchId}.`

    if (dialect === 'slack') return { text }
    if (dialect === 'discord') return { content: text }
    return {
      event: 'dead_letters',
      site: notification.site,
      batchId: notification.batchId,
      deadUrls: notification.deadUrls,
      reason: notification.reason,
      httpStatus: notification.httpStatus ?? null,
      occurredAt: new Date().toISOString(),
    }
  }
}
