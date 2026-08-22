import type { Database } from 'bun:sqlite'

import type { NormalizedRelayConfig, NormalizedToken } from '../config/config.types.ts'
import { domainError } from './errors.ts'
import { SiteRegistry, tokenAllowsSite } from './site.ts'
import { normalizeSubmitUrl, type NormalizedSubmitUrl } from './url.ts'
import { createUlid } from './ulid.ts'
import type { PendingUrlsRepository } from '../db/repositories/pending-urls.repo.ts'
import type { ReceiptsRepository } from '../db/repositories/receipts.repo.ts'
import type { SubmissionStateRepository } from '../db/repositories/submission-state.repo.ts'

export interface SiteSubmissionSummary {
  host: string
  enqueued: number
  coalesced: number
}

export interface EnqueueReceipt {
  receiptId: string
  received: number
  enqueued: number
  coalesced: number
  sites: SiteSubmissionSummary[]
}

export type WakeScheduler = () => void

export interface EnqueueServiceDeps {
  db: Database
  pendingUrls: PendingUrlsRepository
  submissionState: SubmissionStateRepository
  receipts: ReceiptsRepository
  config: NormalizedRelayConfig
  registry: SiteRegistry
}

/**
 * Implements `POST /v1/urls` semantics with all-or-nothing validation:
 * every URL is parsed and authorized BEFORE any write happens, then all
 * writes land in a single SQLite transaction.
 *
 * @evidence docs/REQUIREMENTS.md#url-submission Owns submission semantics:
 *           normalization, all-or-nothing validation, host grouping,
 *           coalescing, resubmit suppression, and dead-URL revival, with the
 *           receipt written in the same transaction.
 */
export class EnqueueService {
  readonly #deps: EnqueueServiceDeps
  #wake: WakeScheduler | undefined

  constructor(deps: EnqueueServiceDeps) {
    this.#deps = deps
  }

  onEnqueued(wake: WakeScheduler): void {
    this.#wake = wake
  }

  submit(token: NormalizedToken, urls: readonly string[], event: 'created' | 'updated' | 'deleted' | undefined): EnqueueReceipt {
    // 1. Parse and normalize every URL first.
    const invalid: Array<{ url: string; reason: string }> = []
    const normalized: NormalizedSubmitUrl[] = []
    for (const raw of urls) {
      try {
        normalized.push(normalizeSubmitUrl(raw))
      } catch (error) {
        if (invalid.length < 10) {
          invalid.push({ url: String(raw), reason: error instanceof Error ? error.message : 'invalid' })
        }
      }
    }
    if (invalid.length > 0) {
      throw domainError('INVALID_URL', 'One or more URLs are invalid.', { urls: invalid })
    }

    // 2. Group unique URLs by host; duplicates within the request coalesce.
    const groups = new Map<string, Map<string, number>>()
    for (const item of normalized) {
      let urls = groups.get(item.host)
      if (urls === undefined) {
        urls = new Map()
        groups.set(item.host, urls)
      }
      urls.set(item.url, (urls.get(item.url) ?? 0) + 1)
    }

    const duplicatesOf = (urls: Map<string, number>): number =>
      [...urls.values()].reduce((sum, count) => sum + (count - 1), 0)

    // 3. Every host must be a configured site.
    const unknownHosts = [...groups.keys()].filter((host) => this.#deps.registry.get(host) === undefined)
    if (unknownHosts.length > 0) {
      throw domainError('UNKNOWN_SITE', 'One or more URLs belong to hosts that are not configured.', {
        hosts: unknownHosts,
      })
    }

    // 4. The token must be allowed to touch every host.
    const forbiddenHosts = [...groups.keys()].filter((host) => !tokenAllowsSite(token, host))
    if (forbiddenHosts.length > 0) {
      throw domainError(
        'FORBIDDEN_SITE',
        'This token is not allowed to submit URLs for one or more hosts.',
        { hosts: forbiddenHosts },
      )
    }

    // 5. Atomic enqueue.
    const now = Date.now()
    const receiptId = createUlid(now)
    const { queue } = this.#deps.config
    const siteSummaries: SiteSubmissionSummary[] = []

    this.#deps.db.transaction(() => {
      for (const [host, urls] of groups) {
        const site = this.#deps.registry.get(host)!
        const uniqueUrls = [...urls.keys()]
        const sentAt = this.#deps.submissionState.getSentAt(host, uniqueUrls)
        let enqueued = 0
        let coalesced = duplicatesOf(urls)

        for (const url of uniqueUrls) {
          const lastSent = sentAt.get(url)
          if (lastSent !== undefined && now - lastSent < site.minResubmitIntervalMs) {
            coalesced += 1
            continue
          }

          const existing = this.#deps.pendingUrls.get(host, url)
          if (existing === null) {
            this.#deps.pendingUrls.insertNew(
              host,
              url,
              event,
              now,
              now + queue.batchWindowMs,
              receiptId,
            )
            enqueued += 1
          } else if (existing.status === 'pending') {
            this.#deps.pendingUrls.coalesceTouch(
              host,
              url,
              now,
              queue.batchWindowMs,
              queue.maxCoalesceDelayMs,
              receiptId,
            )
            coalesced += 1
          } else {
            // dead -> operator resubmitted it; give it a fresh attempt budget
            this.#deps.pendingUrls.reviveDead(host, url, now, now + queue.batchWindowMs, receiptId)
            enqueued += 1
          }
        }

        siteSummaries.push({ host, enqueued, coalesced })
      }

      const received = normalized.length
      const enqueued = siteSummaries.reduce((sum, s) => sum + s.enqueued, 0)
      const coalesced = siteSummaries.reduce((sum, s) => sum + s.coalesced, 0)

      this.#deps.receipts.insert({
        id: receiptId,
        created_at: now,
        received,
        enqueued,
        coalesced,
        sites: JSON.stringify(siteSummaries),
      })
    })()

    this.#wake?.()

    const received = normalized.length
    return {
      receiptId,
      received,
      enqueued: siteSummaries.reduce((sum, s) => sum + s.enqueued, 0),
      coalesced: siteSummaries.reduce((sum, s) => sum + s.coalesced, 0),
      sites: siteSummaries,
    }
  }
}
