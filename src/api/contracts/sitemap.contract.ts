import { oc } from '@orpc/contract'
import { openapi } from '@orpc/openapi'

import { SubmitUrlsOutputSchema } from '../schemas/submit-urls.ts'
import { SitemapSubmitInputSchema } from '../schemas/sitemap.ts'

/**
 * `POST /v1/sitemap` - submit every URL from a remote sitemap (or sitemap
 * index). The relay fetches and parses it, then feeds the normal submission
 * pipeline: all-or-nothing validation, host grouping, one receipt.
 *
 * @evidence POST:/v1/sitemap Declares this operation's route, schemas, and
 *           error codes.
 */
export const submitSitemapContract = oc
  .meta(
    openapi({
      method: 'POST',
      path: '/v1/sitemap',
      tags: ['urls'],
      summary: 'Submit every URL from a sitemap for IndexNow notification',
    }),
  )
  .input(SitemapSubmitInputSchema)
  .output(SubmitUrlsOutputSchema)
  .errors({
    UNAUTHORIZED: { message: 'Missing or invalid bearer token.' },
    FORBIDDEN_SITE: { message: 'Token is not allowed to submit for one or more hosts.' },
    UNKNOWN_SITE: { message: 'One or more hosts are not configured on this relay.' },
    SITEMAP_FETCH_FAILED: { message: 'The sitemap could not be fetched.' },
    SITEMAP_INVALID: { message: 'The sitemap is not a usable sitemap document.' },
    SITEMAP_TOO_LARGE: { message: 'The sitemap exceeds the relay ingestion limits.' },
  })
