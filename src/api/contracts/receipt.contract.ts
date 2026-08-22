import { oc } from '@orpc/contract'
import { openapi } from '@orpc/openapi'

import { GetReceiptInputSchema, GetReceiptOutputSchema } from '../schemas/receipt.schema.ts'

/** `GET /v1/receipts/{id}` - inspect what happened to a submission. */
export const getReceiptContract = oc
  .meta(
    openapi({
      method: 'GET',
      path: '/v1/receipts/{id}',
      tags: ['receipts'],
      summary: 'Get the status of a submission receipt',
    }),
  )
  .input(GetReceiptInputSchema)
  .output(GetReceiptOutputSchema)
  .errors({
    UNAUTHORIZED: { message: 'Missing or invalid bearer token.' },
    NOT_FOUND: { message: 'Unknown receipt id.' },
  })
