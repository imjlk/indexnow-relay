import type { tags } from 'typia'

// ---------------------------------------------------------------------------
// GET /v1/admin/overview
// ---------------------------------------------------------------------------

export interface AdminSiteStatus {
  host: string
  enabled: boolean
  paused: boolean
  pending: number
  dead: number
  nextDueAt: string | null
}

export interface AdminOverviewOutput {
  queue: {
    pending: number
    dead: number
    nextDueAt: string | null
  }
  batches: {
    succeeded: number
    retryScheduled: number
    dead: number
    inFlight: number
  }
  sites: AdminSiteStatus[]
}

// ---------------------------------------------------------------------------
// GET /v1/admin/batches
// ---------------------------------------------------------------------------

export type AdminBatchStatus = 'in_flight' | 'succeeded' | 'retry_scheduled' | 'dead'

export interface ListBatchesInput {
  site?: string
  limit?: number & tags.Minimum<1> & tags.Maximum<500>
}

export interface AdminBatchRecord {
  id: string
  site: string
  status: AdminBatchStatus
  urlCount: number
  attempt: number
  createdAt: string
  completedAt: string | null
  retryAt: string | null
  httpStatus: number | null
  errorCode: string | null
  errorMessage: string | null
}

export type ListBatchesOutput = AdminBatchRecord[]

// ---------------------------------------------------------------------------
// GET /v1/admin/dead-letters
// ---------------------------------------------------------------------------

export interface ListDeadLettersInput {
  site?: string
  limit?: number & tags.Minimum<1> & tags.Maximum<500>
}

export interface AdminDeadLetterRecord {
  site: string
  url: string
  attempts: number
  lastError: string | null
  lastSeenAt: string
}

export type ListDeadLettersOutput = AdminDeadLetterRecord[]

// ---------------------------------------------------------------------------
// POST /v1/admin/dead-letters/retry
// ---------------------------------------------------------------------------

export interface RetryDeadLettersInput {
  /** Restrict the retry to one site. */
  site?: string
  /** Restrict the retry to specific URLs. */
  urls?: string[] & tags.MinItems<1> & tags.MaxItems<10_000>
}

export interface RetryDeadLettersOutput {
  requeued: number
}

// ---------------------------------------------------------------------------
// POST /v1/admin/sites/{host}/pause | /resume
// ---------------------------------------------------------------------------

export interface SiteActionInput {
  host: string & tags.MinLength<1>
  reason?: string & tags.MaxLength<500>
}

export interface SiteActionOutput {
  host: string
  paused: boolean
}
