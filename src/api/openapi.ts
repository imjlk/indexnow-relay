import { COMMON_ERROR_STATUS_MAP, OpenAPIGenerator, type OpenAPIDocument } from '@orpc/openapi'

import { APP_VERSION } from '../version.ts'

/**
 * HTTP statuses for relay-specific error codes. Built-in codes (UNAUTHORIZED,
 * NOT_FOUND, ...) come from oRPC's map; domain codes are ours.
 */
export const ERROR_STATUS_MAP: Record<string, number> = {
  ...COMMON_ERROR_STATUS_MAP,
  FORBIDDEN_SITE: 403,
  INVALID_URL: 400,
  UNKNOWN_SITE: 400,
}

/** Builds the canonical OpenAPI document for this router. */
export async function buildOpenApiDocument(router: unknown): Promise<OpenAPIDocument> {
  const generator = new OpenAPIGenerator()
  return generator.generate(router as never, {
    base: {
      info: {
        title: 'IndexNow Relay API',
        version: APP_VERSION,
        description:
          'Submit URLs once and let the relay batch, coalesce, retry, and deliver them to IndexNow per site. ' +
          'Authenticate with `Authorization: Bearer <token>`.',
      },
    },
    errorStatusMap: ERROR_STATUS_MAP,
  })
}
