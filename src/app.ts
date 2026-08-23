import { OpenAPIHandler } from '@orpc/openapi/fetch'
import { OpenAPIReferenceHandlerPlugin } from '@orpc/openapi/plugins'

import { createRouter } from './api/router.ts'
import { buildOpenApiDocument, ERROR_STATUS_MAP } from './api/openapi.ts'
import type { ApiContext, RelayApp } from './api/context.ts'
import type { NormalizedRelayConfig } from './config/config.types.ts'
import { loadRelayConfig } from './config/index.ts'
import { EnqueueService } from './core/enqueue.service.ts'
import { SiteRegistry } from './core/site.ts'
import { openDatabase, type RelayDatabase } from './db/database.ts'
import { migrate } from './db/migrate.ts'
import { SubmissionBatchesRepository } from './db/repositories/batches.repo.ts'
import { PendingUrlsRepository } from './db/repositories/pending-urls.repo.ts'
import { ReceiptsRepository } from './db/repositories/receipts.repo.ts'
import { SiteStateRepository } from './db/repositories/site-state.repo.ts'
import { SubmissionStateRepository } from './db/repositories/submission-state.repo.ts'
import { IndexNowClient, type FetchLike } from './indexnow/client.ts'
import { Scheduler } from './queue/scheduler.ts'
import { Logger } from './observability/logger.ts'
import { livenessResponse, readinessResponse } from './observability/health.ts'
import { APP_NAME, APP_VERSION, USER_AGENT } from './version.ts'

export interface CreateAppOptions {
  configPath?: string
}

export async function createApp(options: CreateAppOptions = {}): Promise<RelayApp> {
  const { config } = await loadRelayConfig(options.configPath)
  const app = buildApp(config, { logger: Logger.fromEnv() })
  app.scheduler.start()
  app.logger.info('relay initialized', {
    // Hostnames only - never keys or tokens.
    sites: Object.keys(config.sites),
    database: config.databasePath,
    endpoint: config.indexnowEndpoint,
  })
  return app
}

export interface BuildAppOptions {
  logger?: Logger
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: FetchLike
}

/**
 * Wires the full application from a normalized config. Does NOT start the
 * scheduler - callers (server entry, tests) decide when ticking begins.
 */
export function buildApp(config: NormalizedRelayConfig, options: BuildAppOptions = {}): RelayApp {
  const logger = (options.logger ?? new Logger('error')).child({ app: APP_NAME, version: APP_VERSION })

  const db = openDatabase(config.databasePath)
  migrate(db)

  const pendingUrls = new PendingUrlsRepository(db)
  const submissionState = new SubmissionStateRepository(db)
  const batches = new SubmissionBatchesRepository(db)
  const receipts = new ReceiptsRepository(db)
  const siteState = new SiteStateRepository(db)

  const registry = new SiteRegistry(config)
  const client = new IndexNowClient({
    endpoint: config.indexnowEndpoint,
    timeoutMs: config.queue.httpTimeoutMs,
    userAgent: USER_AGENT,
    ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
  })

  const enqueue = new EnqueueService({
    db,
    pendingUrls,
    submissionState,
    receipts,
    config,
    registry,
  })

  const scheduler = new Scheduler({
    db,
    config,
    registry,
    pendingUrls,
    submissionState,
    batches,
    receipts,
    siteState,
    client,
    logger,
  })
  enqueue.onEnqueued(() => scheduler.wake())

  const router = createRouter({ config, registry, logger, db, enqueue, pendingUrls, submissionState, receipts, batches, siteState, scheduler } as RelayApp)
  const handler = new OpenAPIHandler<ApiContext>(router, {
    errorStatusMap: ERROR_STATUS_MAP,
    plugins: [
      new OpenAPIReferenceHandlerPlugin({
        spec: async () => await buildOpenApiDocument(router),
        specPath: '/openapi.json',
        docsPath: '/',
        docsTitle: 'IndexNow Relay API',
      }),
    ],
  })

  return { config, registry, logger, db, enqueue, pendingUrls, submissionState, receipts, batches, siteState, scheduler, handler }
}

/** Routes one HTTP request: health probes first, then the oRPC handler. */
export async function routeRequest(app: RelayApp, request: Request): Promise<Response> {
  const { pathname } = new URL(request.url)

  if (pathname === '/health/live' || pathname === '/healthz') return livenessResponse()
  if (pathname === '/health/ready' || pathname === '/readyz') return await readinessResponse(app)

  try {
    const result = await app.handler.handle(request, { context: { request, app } })
    if (result.response !== undefined) return result.response
  } catch (error) {
    app.logger.error('unhandled request error', {
      path: pathname,
      error: error instanceof Error ? error.message : String(error),
    })
    return new Response(JSON.stringify({ code: 'INTERNAL_SERVER_ERROR', message: 'Unhandled error.' }), {
      status: 500,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    })
  }

  return new Response(JSON.stringify({ code: 'NOT_FOUND', message: `No route for ${pathname}.` }), {
    status: 404,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  })
}

export async function closeApp(app: RelayApp): Promise<void> {
  await app.scheduler.stop()
  app.db.close()
}
