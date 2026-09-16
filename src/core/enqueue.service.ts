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

    // 2. Every host must be a configured site before scope checks can run.
    const hosts = [...new Set(normalized.map((item) => item.host))]
    const unknownHosts = hosts.filter((host) => this.#deps.registry.get(host) === undefined)
    if (unknownHosts.length > 0) {
      throw domainError('UNKNOWN_SITE', 'One or more URLs belong to hosts that are not configured.', {
        hosts: unknownHosts,
      })
    }

    // 3. A key file below a subdirectory only authorizes URLs under it
    // (IndexNow key-location scope). The prefix comparison includes the
    // path separator: /catalog/ is in scope under /catalog; /catalogue and
    // a bare /catalog are not. Encoded separators are rejected outright -
    // URL.pathname keeps them encoded, but origin servers may decode them
    // into real directory traversal.
    for (const item of normalized) {
      if (/%2f|%5c/i.test(item.path) && invalid.length < 10) {
        invalid.push({ url: item.url, reason: 'encoded path separators are not accepted' })
        continue
      }
      const scope = this.#deps.registry.get(item.host)!.keyScopeDir
      // both operands in RFC 3986 canonical form: escape hex casing must
      // not decide whether a URL is inside the key file's directory
      const path = canonicalizeEscapes(item.path)
      const inScope = scope === '' || path.startsWith(`${scope}/`)
      if (!inScope && invalid.length < 10) {
        invalid.push({
          url: item.url,
          reason: `outside the key file's path scope for this site (key file lives under "${scope}")`,
        })
      }
    }
    if (invalid.length > 0) {
      throw domainError('INVALID_URL', 'One or more URLs are invalid.', { urls: invalid })
    }

    // 4. Group unique URLs by host; duplicates within the request coalesce.
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

    // 5. The token must be allowed to touch every host.
    const forbiddenHosts = [...groups.keys()].filter((host) => !tokenAllowsSite(token, host))
    if (forbiddenHosts.length > 0) {
      throw domainError(
        'FORBIDDEN_SITE',
        'This token is not allowed to submit URLs for one or more hosts.',
        { hosts: forbiddenHosts },
      )
    }

    // 6. Atomic enqueue.
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
          const existing = this.#deps.pendingUrls.get(host, url)

          // An existing pending row (leased or not) always absorbs the
          // resubmission. Its delivery floor (retry wait or an earlier
          // deferred reservation) is untouched, so repeated resubmissions
          // never postpone or bypass the scheduled delivery.
          if (existing !== null && existing.status === 'pending') {
            this.#deps.pendingUrls.coalesceTouch(
              host,
              url,
              now,
              queue.batchWindowMs,
              queue.maxCoalesceDelayMs,
              receiptId,
              event,
            )
            coalesced += 1
            continue
          }

          const lastSent = sentAt.get(url)
          const deliveryFloor = lastSent !== undefined ? lastSent + site.minResubmitIntervalMs : 0

          if (existing !== null) {
            // dead -> operator resubmitted it; give it a fresh attempt
            // budget, still respecting the resubmit interval
            this.#deps.pendingUrls.reviveDead(
              host,
              url,
              now,
              now + queue.batchWindowMs,
              receiptId,
              event,
              deliveryFloor,
            )
            enqueued += 1
            continue
          }

          if (deliveryFloor > now) {
            // Recently sent and no queue row: instead of dropping the
            // change, reserve one more delivery once the interval passes.
            const scheduled = this.#deps.pendingUrls.scheduleDeferred(
              host,
              url,
              event,
              now,
              deliveryFloor,
              queue.batchWindowMs,
              receiptId,
            )
            if (scheduled) {
              enqueued += 1
            } else {
              coalesced += 1
            }
            continue
          }

          this.#deps.pendingUrls.insertNew(
            host,
            url,
            event,
            now,
            now + queue.batchWindowMs,
            receiptId,
          )
          enqueued += 1
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

/** Upper-cases the hex digits of every percent escape (RFC 3986 canonical form). */
function canonicalizeEscapes(path: string): string {
  return path.replace(/%[0-9a-fA-F]{2}/g, (escape) => escape.toUpperCase())
}
