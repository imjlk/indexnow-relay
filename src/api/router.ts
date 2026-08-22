import { implement } from '@orpc/server'

import { authenticate, authenticateAdmin } from './auth.middleware.ts'
import type { ApiContext, RelayApp } from './context.ts'
import { domainError } from '../core/errors.ts'
import { tokenAllowsSite } from '../core/site.ts'
import {
  adminListBatchesContract,
  adminListDeadLettersContract,
  adminOverviewContract,
  adminPauseSiteContract,
  adminResumeSiteContract,
  adminRetryDeadLettersContract,
} from './contracts/admin.contract.ts'
import { getReceiptContract } from './contracts/receipt.contract.ts'
import { submitUrlsContract } from './contracts/submit-urls.contract.ts'
import type {
  AdminBatchRecord,
  AdminDeadLetterRecord,
  AdminOverviewOutput,
  AdminSiteStatus,
} from './schemas/admin.types.ts'
import type { GetReceiptOutput } from './schemas/receipt.types.ts'
import type { SiteSubmissionSummary } from './schemas/submit-urls.types.ts'

const iso = (ms: number | null | undefined): string | null =>
  ms === null || ms === undefined ? null : new Date(ms).toISOString()

export function createRouter(app: RelayApp) {
  return {
    submitUrls: implement(submitUrlsContract).$context<ApiContext>().handler(async ({ input, context }) => {
      const token = authenticate(context)
      return app.enqueue.submit(token, input.urls, input.event)
    }),

    getReceipt: implement(getReceiptContract).$context<ApiContext>().handler(async ({ input, context }): Promise<GetReceiptOutput> => {
      const token = authenticate(context)
      const row = app.receipts.get(input.id)
      if (row === null) {
        throw domainError('NOT_FOUND', `Receipt ${input.id} does not exist.`)
      }

      const sites = JSON.parse(row.sites) as SiteSubmissionSummary[]
      // Scoped tokens must not learn that a receipt exists.
      const visible = sites.every((site) => tokenAllowsSite(token, site.host))
      if (!visible) {
        throw domainError('NOT_FOUND', `Receipt ${input.id} does not exist.`)
      }

      return {
        receiptId: row.id,
        createdAt: new Date(row.created_at).toISOString(),
        received: row.received,
        enqueued: row.enqueued,
        coalesced: row.coalesced,
        sites,
        stillPending: app.pendingUrls.countPendingByReceipt(row.id),
      }
    }),

    admin: {
      overview: implement(adminOverviewContract).$context<ApiContext>().handler(async ({ context }): Promise<AdminOverviewOutput> => {
        authenticateAdmin(context)

        const depths = app.pendingUrls.queueDepths()
        const batchCounts = app.batches.countsByStatus()

        const sites: AdminSiteStatus[] = app.registry.all().map((site) => {
          const pending = depths.find((d) => d.site_host === site.host && d.status === 'pending')
          const dead = depths.find((d) => d.site_host === site.host && d.status === 'dead')
          return {
            host: site.host,
            enabled: site.enabled,
            paused: app.siteState.isPaused(site.host),
            pending: pending?.count ?? 0,
            dead: dead?.count ?? 0,
            nextDueAt: iso(pending?.min_due_at ?? null),
          }
        })

        const sum = (status: string): number =>
          batchCounts.filter((b) => b.status === status).reduce((acc, b) => acc + b.count, 0)

        const pendingDepth = depths.filter((d) => d.status === 'pending')
        const minDue = pendingDepth.reduce<number | null>(
          (min, d) => (d.min_due_at === null ? min : min === null ? d.min_due_at : Math.min(min, d.min_due_at)),
          null,
        )

        return {
          queue: {
            pending: pendingDepth.reduce((acc, d) => acc + d.count, 0),
            dead: depths.filter((d) => d.status === 'dead').reduce((acc, d) => acc + d.count, 0),
            nextDueAt: iso(minDue),
          },
          batches: {
            succeeded: sum('succeeded'),
            retryScheduled: sum('retry_scheduled'),
            dead: sum('dead'),
            inFlight: sum('in_flight'),
          },
          sites,
        }
      }),

      listBatches: implement(adminListBatchesContract).$context<ApiContext>().handler(
        async ({ input, context }): Promise<AdminBatchRecord[]> => {
          authenticateAdmin(context)
          const limit = input.limit ?? 50
          const rows = app.batches.list(input.site, limit)
          return rows.map((row) => ({
            id: row.id,
            site: row.site_host,
            status: row.status,
            urlCount: row.url_count,
            attempt: row.attempt,
            createdAt: new Date(row.created_at).toISOString(),
            completedAt: iso(row.completed_at),
            retryAt: iso(row.retry_at),
            httpStatus: row.http_status,
            errorCode: row.error_code,
            errorMessage: row.error_message,
          }))
        },
      ),

      listDeadLetters: implement(adminListDeadLettersContract).$context<ApiContext>().handler(
        async ({ input, context }): Promise<AdminDeadLetterRecord[]> => {
          authenticateAdmin(context)
          const limit = input.limit ?? 50
          const rows = app.pendingUrls.listDead(input.site, limit)
          return rows.map((row) => ({
            site: row.site_host,
            url: row.url,
            attempts: row.attempts,
            lastError: row.last_error,
            lastSeenAt: new Date(row.last_seen_at).toISOString(),
          }))
        },
      ),

      retryDeadLetters: implement(adminRetryDeadLettersContract).$context<ApiContext>().handler(async ({ input, context }) => {
        authenticateAdmin(context)
        const now = Date.now()
        const requeued = app.pendingUrls.requeueDead(now, now + app.config.queue.batchWindowMs, input.site, input.urls)
        app.scheduler.wake()
        return { requeued }
      }),

      pauseSite: implement(adminPauseSiteContract).$context<ApiContext>().handler(async ({ input, context }) => {
        authenticateAdmin(context)
        requireKnownSite(app, input.host)
        app.siteState.setPaused(input.host, true, input.reason, Date.now())
        app.logger.warn('site paused', { site: input.host, reason: input.reason ?? 'unspecified' })
        return { host: input.host, paused: true }
      }),

      resumeSite: implement(adminResumeSiteContract).$context<ApiContext>().handler(async ({ input, context }) => {
        authenticateAdmin(context)
        requireKnownSite(app, input.host)
        app.siteState.setPaused(input.host, false, undefined, Date.now())
        app.logger.info('site resumed', { site: input.host })
        app.scheduler.wake()
        return { host: input.host, paused: false }
      }),
    },
  }
}

function requireKnownSite(app: RelayApp, host: string): void {
  if (app.registry.get(host) === undefined) {
    throw domainError('NOT_FOUND', `Site "${host}" is not configured on this relay.`)
  }
}

export type RelayRouter = ReturnType<typeof createRouter>
