import type { tags } from 'typia'

import type { SiteSubmissionSummary } from './submit-urls.types.ts'

/** ULID (26 Crockford base32 characters). */
export type ReceiptId = string & tags.MinLength<26> & tags.MaxLength<26>

export interface GetReceiptInput {
  id: ReceiptId
}

export interface GetReceiptOutput {
  receiptId: string
  createdAt: string
  received: number
  enqueued: number
  coalesced: number
  sites: SiteSubmissionSummary[]
  /** URLs from this receipt that are still waiting to be submitted. */
  stillPending: number
}
