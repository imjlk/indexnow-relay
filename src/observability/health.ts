import type { RelayApp } from '../api/context.ts'

const jsonResponse = (status: number, body: Record<string, unknown>): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  })

/** Liveness (`/health/live`, legacy alias `/healthz`): is the process up? */
export function livenessResponse(): Response {
  return jsonResponse(200, { status: 'ok' })
}

/**
 * Readiness (`/health/ready`, legacy alias `/readyz`): can the relay serve?
 * Checks that the scheduler is running and the database answers a trivial
 * query; config load and migrations are guaranteed by the time the server
 * accepts requests. Never calls the IndexNow API.
 *
 * @evidence docs/REQUIREMENTS.md#observability-and-secret-hygiene Owns the
 *           /health/live and /health/ready probes (process liveness;
 *           scheduler + database readiness).
 */
export async function readinessResponse(app: RelayApp): Promise<Response> {
  if (!app.scheduler.isRunning) {
    return jsonResponse(503, { status: 'unavailable', reason: 'scheduler not running' })
  }

  try {
    app.db.query<unknown, []>('SELECT 1').get()
  } catch (error) {
    return jsonResponse(503, {
      status: 'unavailable',
      reason: 'database unavailable',
      detail: error instanceof Error ? error.message : String(error),
    })
  }

  return jsonResponse(200, { status: 'ok' })
}
