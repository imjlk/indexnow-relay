import { oc } from '@orpc/contract'
import { openapi } from '@orpc/openapi'

import {
  AdminOverviewOutputSchema,
  ListBatchesInputSchema,
  ListBatchesOutputSchema,
  ListDeadLettersInputSchema,
  ListDeadLettersOutputSchema,
  RetryDeadLettersInputSchema,
  RetryDeadLettersOutputSchema,
  SiteActionInputSchema,
  SiteActionOutputSchema,
} from '../schemas/admin.ts'

/**
 * Operator endpoints. All of them require a token with unrestricted site
 * access (`sites: '*'`).
 *
 * @evidence docs/REQUIREMENTS.md#operations-api Owns the operator surface
 *           (overview, batches, dead letters, requeue, pause/resume).
 * @evidence GET:/v1/admin/overview Declares this operation's route, schemas,
 *           and error codes.
 */
export const adminOverviewContract = oc
  .meta(openapi({ method: 'GET', path: '/v1/admin/overview', tags: ['admin'], summary: 'Queue overview' }))
  .output(AdminOverviewOutputSchema)
  .errors({
    UNAUTHORIZED: { message: 'Missing or invalid bearer token.' },
    FORBIDDEN: { message: 'Requires an unrestricted token.' },
  })

/**
 * @evidence GET:/v1/admin/batches Declares this operation's route, schemas,
 *           and error codes.
 */
export const adminListBatchesContract = oc
  .meta(
    openapi({
      method: 'GET',
      path: '/v1/admin/batches',
      tags: ['admin'],
      summary: 'List recent IndexNow submission batches',
      queryStyles: { limit: 'json' },
    }),
  )
  .input(ListBatchesInputSchema)
  .output(ListBatchesOutputSchema)
  .errors({
    UNAUTHORIZED: { message: 'Missing or invalid bearer token.' },
    FORBIDDEN: { message: 'Requires an unrestricted token.' },
  })

/**
 * @evidence GET:/v1/admin/dead-letters Declares this operation's route,
 *           schemas, and error codes.
 */
export const adminListDeadLettersContract = oc
  .meta(
    openapi({
      method: 'GET',
      path: '/v1/admin/dead-letters',
      tags: ['admin'],
      summary: 'List dead-lettered URLs',
      queryStyles: { limit: 'json' },
    }),
  )
  .input(ListDeadLettersInputSchema)
  .output(ListDeadLettersOutputSchema)
  .errors({
    UNAUTHORIZED: { message: 'Missing or invalid bearer token.' },
    FORBIDDEN: { message: 'Requires an unrestricted token.' },
  })

/**
 * @evidence POST:/v1/admin/dead-letters/retry Declares this operation's
 *           route, schemas, and error codes.
 */
export const adminRetryDeadLettersContract = oc
  .meta(
    openapi({
      method: 'POST',
      path: '/v1/admin/dead-letters/retry',
      tags: ['admin'],
      summary: 'Requeue dead-lettered URLs',
    }),
  )
  .input(RetryDeadLettersInputSchema)
  .output(RetryDeadLettersOutputSchema)
  .errors({
    UNAUTHORIZED: { message: 'Missing or invalid bearer token.' },
    FORBIDDEN: { message: 'Requires an unrestricted token.' },
  })

/**
 * @evidence POST:/v1/admin/sites/{host}/pause Declares this operation's
 *           route, schemas, and error codes.
 */
export const adminPauseSiteContract = oc
  .meta(
    openapi({
      method: 'POST',
      path: '/v1/admin/sites/{host}/pause',
      tags: ['admin'],
      summary: 'Pause submissions for a site',
    }),
  )
  .input(SiteActionInputSchema)
  .output(SiteActionOutputSchema)
  .errors({
    UNAUTHORIZED: { message: 'Missing or invalid bearer token.' },
    FORBIDDEN: { message: 'Requires an unrestricted token.' },
    NOT_FOUND: { message: 'Unknown site.' },
  })

/**
 * @evidence POST:/v1/admin/sites/{host}/resume Declares this operation's
 *           route, schemas, and error codes.
 */
export const adminResumeSiteContract = oc
  .meta(
    openapi({
      method: 'POST',
      path: '/v1/admin/sites/{host}/resume',
      tags: ['admin'],
      summary: 'Resume submissions for a site',
    }),
  )
  .input(SiteActionInputSchema)
  .output(SiteActionOutputSchema)
  .errors({
    UNAUTHORIZED: { message: 'Missing or invalid bearer token.' },
    FORBIDDEN: { message: 'Requires an unrestricted token.' },
    NOT_FOUND: { message: 'Unknown site.' },
  })
