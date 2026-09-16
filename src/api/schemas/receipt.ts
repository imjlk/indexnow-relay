import typia from 'typia'
import type { tags } from 'typia'

import { defineTypiaSchema } from '../../schema/define-typia-schema.ts'
import type { SiteSubmissionSummary } from './submit-urls.ts'

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
  /**
   * Pending queue rows (including rows currently leased for delivery) whose
   * latest receipt reference is this receipt. Zero does NOT mean the URLs
   * were delivered: references move to newer receipts and dead-lettered
   * URLs also leave the count. Check the admin queue/batch APIs for
   * delivery outcomes.
   */
  pendingLastReferenced: number
  /** Deprecated alias of `pendingLastReferenced`. */
  stillPending: number
}

export const GetReceiptInputSchema = defineTypiaSchema({
  validator: typia.createValidateEquals<GetReceiptInput>(),
  unit31: typia.json.schema<GetReceiptInput, '3.1'>(),
})

export const GetReceiptOutputSchema = defineTypiaSchema({
  validator: typia.createValidateEquals<GetReceiptOutput>(),
  unit31: typia.json.schema<GetReceiptOutput, '3.1'>(),
})
