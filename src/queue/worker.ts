import type { Database } from 'bun:sqlite'

import type { NormalizedQueueConfig, NormalizedSite } from '../config/config.types.ts'
import type { PendingUrlsRepository } from '../db/repositories/pending-urls.repo.ts'
import type { SubmissionBatchesRepository } from '../db/repositories/batches.repo.ts'
import type { SubmissionStateRepository } from '../db/repositories/submission-state.repo.ts'
import type { SiteStateRepository } from '../db/repositories/site-state.repo.ts'
import type { IndexNowClient } from '../indexnow/client.ts'
import { buildPayload } from '../indexnow/payload.ts'
import { classifySubmitResult } from '../indexnow/response-policy.ts'
import type { Logger } from '../observability/logger.ts'
import type { WebhookNotifier } from '../observability/notifier.ts'
import { createUlid } from '../core/ulid.ts'
import { createLeaseId, leaseUntil } from './lease.ts'
import { parseRetryAfterMs, retryDelayMs } from './retry-policy.ts'

export interface QueueWorkerDeps {
  db: Database
  pendingUrls: PendingUrlsRepository
  submissionState: SubmissionStateRepository
  batches: SubmissionBatchesRepository
  siteState: SiteStateRepository
  queue: NormalizedQueueConfig
  client: IndexNowClient
  logger: Logger
  notifier: WebhookNotifier
}

export interface DrainResult {
  host: string
  batchesSucceeded: number
  batchesRetried: number
  batchesDead: number
  urlsSubmitted: number
  /** Rows kept pending because they were resubmitted mid-delivery. */
  followUpsPreserved: number
}

/**
 * Drains one site: repeatedly claims due URLs, sends one IndexNow batch per
 * claim, and applies the outcome to the leased rows. Runs at most
 * `maxConcurrentSites` drains at a time (enforced by the scheduler).
 *
 * Every queue-state transition (claim, success, failure) is one SQLite
 * transaction; the HTTP call happens between transactions, and logging plus
 * webhook notifications fire only after the state change has committed.
 *
 * @evidence docs/REQUIREMENTS.md#persistent-queue-and-recovery Owns the
 *           lease-claim-drain loop over the persistent SQLite queue.
 */
export async function drainSite(
  site: NormalizedSite,
  deps: QueueWorkerDeps,
  isStopped: () => boolean,
): Promise<DrainResult> {
  const result: DrainResult = { host: site.host, batchesSucceeded: 0, batchesRetried: 0, batchesDead: 0, urlsSubmitted: 0, followUpsPreserved: 0 }

  while (!isStopped()) {
    const now = Date.now()
    if (!deps.pendingUrls.hasDueWork(site.host, now)) break
    // Re-checked before every claim: a pause or a server-asked cooldown that
    // arrived mid-drain stops the NEXT batch; an in-flight HTTP call still
    // finishes.
    if (deps.siteState.isPaused(site.host)) break
    if (deps.siteState.retryNotBefore(site.host) > now) break

    // Delivery start: claim and audit row land atomically.
    const leaseId = createLeaseId()
    const claim = deps.db.transaction(() => {
      const claimed = deps.pendingUrls.claimDue(
        site.host,
        now,
        site.batchSize,
        leaseId,
        leaseUntil(now, deps.queue),
      )
      if (claimed.length === 0) return undefined

      const attempt = Math.max(...claimed.map((row) => row.attempts)) + 1
      const batchId = createUlid(now)
      deps.batches.insertInFlight(batchId, site.host, claimed.length, attempt, now)
      return { claimed, attempt, batchId }
    })()
    if (claim === undefined) break
    const { claimed, attempt, batchId } = claim

    const raw = await deps.client.submitUrls(
      buildPayload({
        host: site.host,
        key: site.key,
        keyLocation: site.keyLocation,
        urlList: claimed.map((row) => row.url),
      }),
    )
    const outcome = classifySubmitResult(raw)

    if (outcome.kind === 'success') {
      const finishedAt = Date.now()
      // Success: delete delivered rows, keep mid-flight resubmissions,
      // record sent state, close the batch - atomically.
      const followUps = deps.db.transaction(() => {
        deps.pendingUrls.deleteLeased(site.host, leaseId, claimed)
        const kept = deps.pendingUrls.releaseFollowUps(
          site.host,
          leaseId,
          claimed,
          deps.queue.batchWindowMs,
        )
        deps.submissionState.recordSent(site.host, claimed.map((row) => row.url), finishedAt)
        deps.batches.markSucceeded(batchId, outcome.httpStatus, finishedAt)
        return kept
      })()

      result.batchesSucceeded += 1
      result.urlsSubmitted += claimed.length
      result.followUpsPreserved += followUps.length
      deps.logger.info('indexnow batch submitted', {
        site: site.host,
        batchId,
        urls: claimed.length,
        httpStatus: outcome.httpStatus,
        followUpsPreserved: followUps.length,
        ...(outcome.keyValidationPending ? { keyValidationPending: true } : {}),
      })
      continue
    }

    const errorMessage = `${outcome.reason}${outcome.httpStatus === undefined ? '' : ` (HTTP ${outcome.httpStatus})`}`

    if (outcome.kind === 'retryable') {
      const finishedAt = Date.now()
      // The server's Retry-After (when parseable) wins over our own backoff,
      // and backoffMaxMs never shortens it - it caps only our own delay.
      const serverWaitMs = parseRetryAfterMs(raw.retryAfter, finishedAt) ?? 0
      const retryAt = finishedAt + Math.max(retryDelayMs(attempt, deps.queue), serverWaitMs)
      const { retried, dead } = deps.db.transaction(() => {
        const applied = deps.pendingUrls.failLeased(
          site.host,
          leaseId,
          finishedAt,
          retryAt,
          errorMessage,
          deps.queue.maxAttempts,
        )
        // A retryable failure cools down the whole site, not just these
        // URLs: more batches to the same host would draw more 429/5xx.
        deps.siteState.extendRetryNotBefore(site.host, retryAt, finishedAt)
        if (applied.retried > 0) {
          deps.batches.markRetry(batchId, retryAt, outcome.httpStatus, errorMessage, finishedAt)
        } else if (applied.dead > 0) {
          // Every URL exhausted its budget: this batch produced dead
          // letters, not a scheduled retry.
          deps.batches.markDead(batchId, outcome.httpStatus, errorMessage, finishedAt)
        } else {
          // The lease expired mid-flight and the sweep already requeued the
          // rows: they are pending again, so record a retry - not deaths.
          // The effective wait is the one this transaction just persisted as
          // the site cooldown.
          deps.batches.markRetry(
            batchId,
            retryAt,
            outcome.httpStatus,
            `${errorMessage}; lease expired mid-flight, rows requeued`,
            finishedAt,
          )
        }
        return applied
      })()

      if (dead > 0) {
        deps.notifier.notifyDeadLetters({
          site: site.host,
          batchId,
          deadUrls: dead,
          reason: outcome.reason,
          httpStatus: outcome.httpStatus,
        })
      }
      if (retried > 0 || dead === 0) result.batchesRetried += 1
      if (dead > 0) result.batchesDead += 1
      deps.logger.warn('indexnow batch failed; site cooling down', {
        site: site.host,
        batchId,
        urls: claimed.length,
        retried,
        dead,
        reason: outcome.reason,
        retryInMs: retryAt - Date.now(),
        serverWaitMs,
      })
      // End this drain: the concurrency slot must not immediately start the
      // site's next batch against the cooldown.
      break
    } else {
      const finishedAt = Date.now()
      const dead = deps.db.transaction(() => {
        const applied = deps.pendingUrls.deadLeased(site.host, leaseId, finishedAt, errorMessage)
        deps.batches.markDead(batchId, outcome.httpStatus, errorMessage, finishedAt)
        return applied
      })()

      deps.notifier.notifyDeadLetters({
        site: site.host,
        batchId,
        deadUrls: dead,
        reason: outcome.reason,
        httpStatus: outcome.httpStatus,
      })
      result.batchesDead += 1
      deps.logger.error('indexnow batch failed permanently; URLs moved to dead letters', {
        site: site.host,
        batchId,
        urls: dead,
        reason: outcome.reason,
      })
    }
  }

  return result
}
