import type { Database } from 'bun:sqlite'

import type { NormalizedRelayConfig } from '../config/config.types.ts'
import type { PendingUrlsRepository } from '../db/repositories/pending-urls.repo.ts'
import type { ReceiptsRepository } from '../db/repositories/receipts.repo.ts'
import type { SubmissionBatchesRepository } from '../db/repositories/batches.repo.ts'
import type { SubmissionStateRepository } from '../db/repositories/submission-state.repo.ts'
import type { SiteStateRepository } from '../db/repositories/site-state.repo.ts'
import { SiteRegistry } from '../core/site.ts'
import { IndexNowClient } from '../indexnow/client.ts'
import type { Logger } from '../observability/logger.ts'
import { recoverFromCrash } from './recovery.ts'
import { drainSite } from './worker.ts'

export interface SchedulerDeps {
  db: Database
  config: NormalizedRelayConfig
  registry: SiteRegistry
  pendingUrls: PendingUrlsRepository
  submissionState: SubmissionStateRepository
  batches: SubmissionBatchesRepository
  receipts: ReceiptsRepository
  siteState: SiteStateRepository
  client: IndexNowClient
  logger: Logger
}

const RETENTION_INTERVAL_MS = 60 * 60 * 1000

/**
 * Ticker that keeps at most `maxConcurrentSites` drains running and performs
 * periodic housekeeping: expired-lease sweeps and retention cleanup.
 */
export class Scheduler {
  readonly #deps: SchedulerDeps
  #pollTimer: ReturnType<typeof setInterval> | undefined
  #retentionTimer: ReturnType<typeof setInterval> | undefined
  #running = new Map<string, Promise<void>>()
  #stopped = false
  #ticking = false

  constructor(deps: SchedulerDeps) {
    this.#deps = deps
  }

  /** Recovers stale state from a previous process, then starts ticking. */
  start(): void {
    const recovery = recoverFromCrash(this.#deps.db, this.#deps.pendingUrls, this.#deps.batches)
    if (recovery.clearedLeases > 0 || recovery.closedBatches > 0) {
      this.#deps.logger.info('crash recovery complete', {
        clearedLeases: recovery.clearedLeases,
        closedBatches: recovery.closedBatches,
      })
    }

    this.#stopped = false
    this.#pollTimer = setInterval(() => void this.tick(), this.#deps.config.queue.pollIntervalMs)
    this.#retentionTimer = setInterval(() => this.runRetention(), RETENTION_INTERVAL_MS)
    void this.tick()
    this.runRetention()
  }

  /** Called by the enqueue service right after new work lands. */
  wake(): void {
    void this.tick()
  }

  async tick(): Promise<void> {
    if (this.#ticking || this.#stopped) return
    this.#ticking = true
    try {
      const now = Date.now()
      const cleared = this.#deps.pendingUrls.clearExpiredLeases(now)
      if (cleared > 0) {
        this.#deps.logger.warn('expired leases recovered', { count: cleared })
      }

      for (const site of this.#deps.registry.enabled()) {
        if (this.#running.size >= this.#deps.config.queue.maxConcurrentSites) break
        if (this.#running.has(site.host)) continue
        if (this.#deps.siteState.isPaused(site.host)) continue
        if (!this.#deps.pendingUrls.hasDueWork(site.host, now)) continue
        void this.#launchDrain(site)
      }
    } finally {
      this.#ticking = false
    }
  }

  readonly #drain = async (host: string): Promise<void> => {
    const site = this.#deps.registry.get(host)
    if (site === undefined) return
    await drainSite(site, {
      db: this.#deps.db,
      pendingUrls: this.#deps.pendingUrls,
      submissionState: this.#deps.submissionState,
      batches: this.#deps.batches,
      queue: this.#deps.config.queue,
      client: this.#deps.client,
      logger: this.#deps.logger,
    }, () => this.#stopped)
  }

  async #launchDrain(site: { host: string }): Promise<void> {
    const run = this.#drain(site.host)
      .catch((error: unknown) => {
        this.#deps.logger.error('site drain crashed', {
          site: site.host,
          error: error instanceof Error ? error.message : String(error),
        })
      })
      .finally(() => {
        this.#running.delete(site.host)
      })
    this.#running.set(site.host, run)
    await run
    if (!this.#stopped) void this.tick()
  }

  runRetention(): void {
    const now = Date.now()
    const { queue } = this.#deps.config
    const cutoff = now - queue.retentionDays * 24 * 60 * 60 * 1000

    const maxResubmitMs = Math.max(
      ...Object.values(this.#deps.config.sites).map((site) => site.minResubmitIntervalMs),
    )
    const stateCutoff = now - Math.max(24 * 60 * 60 * 1000, maxResubmitMs * 2)

    const purgedBatches = this.#deps.batches.purgeOlderThan(cutoff)
    const purgedReceipts = this.#deps.receipts.purgeOlderThan(cutoff)
    const purgedDead = this.#deps.pendingUrls.purgeOlderThan(cutoff)
    const purgedState = this.#deps.submissionState.purgeOlderThan(stateCutoff)

    if (purgedBatches + purgedReceipts + purgedDead + purgedState > 0) {
      this.#deps.logger.info('retention cleanup', {
        batches: purgedBatches,
        receipts: purgedReceipts,
        deadLetters: purgedDead,
        submissionState: purgedState,
      })
    }
  }

  get runningCount(): number {
    return this.#running.size
  }

  get isRunning(): boolean {
    return !this.#stopped && this.#pollTimer !== undefined
  }

  async stop(timeoutMs = 10_000): Promise<void> {
    this.#stopped = true
    if (this.#pollTimer !== undefined) clearInterval(this.#pollTimer)
    if (this.#retentionTimer !== undefined) clearInterval(this.#retentionTimer)
    this.#pollTimer = undefined
    this.#retentionTimer = undefined

    const inFlight = [...this.#running.values()]
    if (inFlight.length > 0) {
      await Promise.race([
        Promise.allSettled(inFlight),
        new Promise((resolve) => setTimeout(resolve, timeoutMs)),
      ])
    }
  }
}
