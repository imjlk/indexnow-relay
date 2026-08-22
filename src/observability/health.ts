import type { RelayApp } from '../api/context.ts'

const jsonResponse = (status: number, body: Record<string, unknown>): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  })

/** Liveness: is the process itself healthy? */
export function livenessResponse(): Response {
  return jsonResponse(200, { status: 'ok' })
}

/**
 * Readiness: can the relay actually serve? Checks that the scheduler is
 * running and the database answers a trivial query.
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
