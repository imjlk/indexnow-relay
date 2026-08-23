import { oc } from '@orpc/contract'
import { openapi } from '@orpc/openapi'

import { SubmitUrlsInputSchema, SubmitUrlsOutputSchema } from '../schemas/submit-urls.ts'

/**
 * `POST /v1/urls` - submit URLs across any number of configured sites in one
 * request. The relay groups URLs by host automatically; there is no target
 * id in the API because the hostname IS the identity.
 *
 * Validation is all-or-nothing: if any URL is invalid, any host is unknown,
 * or the token lacks access to any host, nothing is enqueued.
 *
 * @evidence POST:/v1/urls Declares this operation's route, schemas, and
 *           error codes.
 */
export const submitUrlsContract = oc
  .meta(
    openapi({
      method: 'POST',
      path: '/v1/urls',
      tags: ['urls'],
      summary: 'Submit URLs for IndexNow notification',
    }),
  )
  .input(SubmitUrlsInputSchema)
  .output(SubmitUrlsOutputSchema)
  .errors({
    UNAUTHORIZED: { message: 'Missing or invalid bearer token.' },
    FORBIDDEN_SITE: { message: 'Token is not allowed to submit for one or more hosts.' },
    INVALID_URL: { message: 'One or more URLs are invalid.' },
    UNKNOWN_SITE: { message: 'One or more hosts are not configured on this relay.' },
  })
