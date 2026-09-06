import { COMMON_ERROR_STATUS_MAP } from '@orpc/openapi'

import { ERROR_STATUS_MAP } from '../api/openapi.ts'
import type { RelayApp } from '../api/context.ts'
import { APP_VERSION } from '../version.ts'

const PROMETHEUS_CONTENT_TYPE = 'text/plain; version=0.0.4; charset=utf-8'

/**
 * Minimal Prometheus text exposition - no client library, no dependencies.
 *
 * Exposed series:
 * - `indexnow_relay_up` / `indexnow_relay_build_info{version}`
 * - `indexnow_relay_queue_urls{site,status}` gauges (pending / dead)
 * - `indexnow_relay_queue_next_due_timestamp_seconds{site}` (pending work)
 * - `indexnow_relay_batches_total{site,status}` counters
 *
 * The endpoint is gated behind an unrestricted token (site hostnames are
 * organizational information), which suits Prometheus scrape configs with
 * static authorization credentials.
 *
 * @evidence docs/REQUIREMENTS.md#observability-and-secret-hygiene Owns the
 *           Prometheus /metrics exposition (queue gauges, batch counters,
 *           build info); never includes keys or tokens.
 */
export function renderPrometheusMetrics(app: RelayApp): string {
  const lines: string[] = []

  lines.push('# HELP indexnow_relay_up Whether the relay is running.')
  lines.push('# TYPE indexnow_relay_up gauge')
  lines.push('indexnow_relay_up 1')

  lines.push('# HELP indexnow_relay_build_info Build information (version label).')
  lines.push('# TYPE indexnow_relay_build_info gauge')
  lines.push(`indexnow_relay_build_info{version="${escapeLabel(APP_VERSION)}"} 1`)

  const depths = app.pendingUrls.queueDepths()
  lines.push('# HELP indexnow_relay_queue_urls Queued URLs by site and status.')
  lines.push('# TYPE indexnow_relay_queue_urls gauge')
  for (const depth of depths) {
    lines.push(
      `indexnow_relay_queue_urls{site="${escapeLabel(depth.site_host)}",status="${depth.status}"} ${depth.count}`,
    )
  }

  lines.push(
    '# HELP indexnow_relay_queue_next_due_timestamp_seconds Earliest pending due time per site (Unix seconds).',
  )
  lines.push('# TYPE indexnow_relay_queue_next_due_timestamp_seconds gauge')
  for (const depth of depths) {
    if (depth.status !== 'pending' || depth.min_due_at === null) continue
    lines.push(
      `indexnow_relay_queue_next_due_timestamp_seconds{site="${escapeLabel(depth.site_host)}"} ${(
        depth.min_due_at / 1000
      ).toFixed(3)}`,
    )
  }

  lines.push('# HELP indexnow_relay_batches_total IndexNow submission batches by outcome.')
  lines.push('# TYPE indexnow_relay_batches_total counter')
  for (const batch of app.batches.countsByStatus()) {
    lines.push(
      `indexnow_relay_batches_total{site="${escapeLabel(batch.site_host)}",status="${batch.status}"} ${batch.count}`,
    )
  }

  return lines.join('\n') + '\n'
}

export function metricsResponse(app: RelayApp): Response {
  return new Response(renderPrometheusMetrics(app), {
    status: 200,
    headers: { 'content-type': PROMETHEUS_CONTENT_TYPE },
  })
}

/** Maps an ORPC error code to the HTTP status the API would use. */
export function statusForErrorCode(code: string): number {
  const common = COMMON_ERROR_STATUS_MAP as Record<string, number | undefined>
  return ERROR_STATUS_MAP[code] ?? common[code] ?? 500
}

function escapeLabel(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')
}
