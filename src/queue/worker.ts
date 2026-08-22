import type { Database } from 'bun:sqlite'

import type { NormalizedQueueConfig, NormalizedSite } from '../config/config.types.ts'
import type { PendingUrlsRepository } from '../db/repositories/pending-urls.repo.ts'
import type { SubmissionBatchesRepository } from '../db/repositories/batches.repo.ts'
import type { SubmissionStateRepository } from '../db/repositories/submission-state.repo.ts'
import type { IndexNowClient } from '../indexnow/client.ts'
import { buildPayload } from '../indexnow/payload.ts'
import { classifySubmitResult } from '../indexnow/response-policy.ts'
import type { Logger } from '../observability/logger.ts'
import { createUlid } from '../core/ulid.ts'
import { createLeaseId, leaseUntil } from './lease.ts'
import { retryDelayMs } from './retry-policy.ts'

export interface QueueWorkerDeps {
  db: Database
  pendingUrls: PendingUrlsRepository
  submissionState: SubmissionStateRepository
  batches: SubmissionBatchesRepository
  queue: NormalizedQueueConfig
  client: IndexNowClient
  logger: Logger
}

export interface DrainResult {
  host: string
  batchesSucceeded: number
  batchesRetried: number
  batchesDead: number
  urlsSubmitted: number
}

/**
 * Drains one site: repeatedly claims due URLs, sends one IndexNow batch per
 * claim, and applies the outcome to the leased rows. Runs at most
 * `maxConcurrentSites` drains at a time (enforced by the scheduler).
 *
 * @evidence docs/REQUIREMENTS.md#persistent-queue-and-recovery Owns the
 *           lease-claim-drain loop over the persistent SQLite queue.
 */
export async function drainSite(
  site: NormalizedSite,
  deps: QueueWorkerDeps,
  isStopped: () => boolean,
): Promise<DrainResult> {
  const result: DrainResult = { host: site.host, batchesSucceeded: 0, batchesRetried: 0, batchesDead: 0, urlsSubmitted: 0 }

  while (!isStopped()) {
    const now = Date.now()
    if (!deps.pendingUrls.hasDueWork(site.host, now)) break

    const leaseId = createLeaseId()
    const claimed = deps.pendingUrls.claimDue(
      site.host,
      now,
      site.batchSize,
      leaseId,
      leaseUntil(now, deps.queue),
    )
    if (claimed.length === 0) break

    const attempt = Math.max(...claimed.map((row) => row.attempts)) + 1
    const batchId = createUlid(now)
    deps.batches.insertInFlight(batchId, site.host, claimed.length, attempt, now)

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
      deps.pendingUrls.deleteLeased(site.host, leaseId)
      deps.submissionState.recordSent(site.host, claimed.map((row) => row.url), Date.now())
      deps.batches.markSucceeded(batchId, outcome.httpStatus, Date.now())
      result.batchesSucceeded += 1
      result.urlsSubmitted += claimed.length
      deps.logger.info('indexnow batch submitted', {
        site: site.host,
        batchId,
        urls: claimed.length,
        httpStatus: outcome.httpStatus,
        ...(outcome.keyValidationPending ? { keyValidationPending: true } : {}),
      })
      continue
    }

    const errorMessage = `${outcome.reason}${outcome.httpStatus === undefined ? '' : ` (HTTP ${outcome.httpStatus})`}`

    if (outcome.kind === 'retryable') {
      const retryAt = Date.now() + retryDelayMs(attempt, deps.queue)
      const { retried, dead } = deps.pendingUrls.failLeased(
        site.host,
        leaseId,
        Date.now(),
        retryAt,
        errorMessage,
        deps.queue.maxAttempts,
      )
      deps.batches.markRetry(batchId, retryAt, outcome.httpStatus, errorMessage, Date.now())
      result.batchesRetried += 1
      if (dead > 0) result.batchesDead += 1
      deps.logger.warn('indexnow batch failed; will retry', {
        site: site.host,
        batchId,
        urls: claimed.length,
        retried,
        dead,
        reason: outcome.reason,
        retryInMs: retryAt - Date.now(),
      })
    } else {
      const dead = deps.pendingUrls.deadLeased(site.host, leaseId, Date.now(), errorMessage)
      deps.batches.markDead(batchId, outcome.httpStatus, errorMessage, Date.now())
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
