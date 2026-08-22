import type { tags } from 'typia'

/** Per-element length bounds mirror core/url.ts MAX_URL_LENGTH. */
export type SubmitUrlList = Array<string & tags.MinLength<1> & tags.MaxLength<2048>> &
  tags.MinItems<1> &
  tags.MaxItems<10_000>

/**
 * The IndexNow protocol itself ignores `event`; the relay keeps it for
 * operational context in logs and receipts.
 */
export type UrlEvent = 'created' | 'updated' | 'deleted'

export interface SubmitUrlsInput {
  /** Public URLs that were created, changed, or deleted. */
  urls: SubmitUrlList
  event?: UrlEvent
}

export interface SiteSubmissionSummary {
  host: string
  enqueued: number
  coalesced: number
}

export interface SubmitUrlsOutput {
  receiptId: string
  received: number
  enqueued: number
  coalesced: number
  sites: SiteSubmissionSummary[]
}
