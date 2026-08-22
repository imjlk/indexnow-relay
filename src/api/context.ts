import type { Database } from 'bun:sqlite'

import type { NormalizedRelayConfig } from '../config/config.types.ts'
import type { EnqueueService } from '../core/enqueue.service.ts'
import type { SiteRegistry } from '../core/site.ts'
import type { PendingUrlsRepository } from '../db/repositories/pending-urls.repo.ts'
import type { SubmissionStateRepository } from '../db/repositories/submission-state.repo.ts'
import type { ReceiptsRepository } from '../db/repositories/receipts.repo.ts'
import type { SubmissionBatchesRepository } from '../db/repositories/batches.repo.ts'
import type { SiteStateRepository } from '../db/repositories/site-state.repo.ts'
import type { Scheduler } from '../queue/scheduler.ts'
import type { Logger } from '../observability/logger.ts'
import type { OpenAPIHandler } from '@orpc/openapi/fetch'

/** Everything a procedure handler needs, built once per process. */
export interface RelayApp {
  config: NormalizedRelayConfig
  registry: SiteRegistry
  logger: Logger
  db: Database
  enqueue: EnqueueService
  pendingUrls: PendingUrlsRepository
  submissionState: SubmissionStateRepository
  receipts: ReceiptsRepository
  batches: SubmissionBatchesRepository
  siteState: SiteStateRepository
  scheduler: Scheduler
  handler: OpenAPIHandler<ApiContext>
}

/** Per-request context handed to oRPC handlers. */
export interface ApiContext {
  request: Request
  app: RelayApp
}
