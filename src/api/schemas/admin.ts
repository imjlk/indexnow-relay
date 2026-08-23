import typia from 'typia'
import type { tags } from 'typia'

import { defineTypiaSchema } from '../../schema/define-typia-schema.ts'

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

// ---------------------------------------------------------------------------
// Derived schemas
// ---------------------------------------------------------------------------

export const AdminOverviewOutputSchema = defineTypiaSchema({
  validator: typia.createValidateEquals<AdminOverviewOutput>(),
  unit31: typia.json.schema<AdminOverviewOutput, '3.1'>(),
})

export const ListBatchesInputSchema = defineTypiaSchema({
  validator: typia.createValidateEquals<ListBatchesInput>(),
  unit31: typia.json.schema<ListBatchesInput, '3.1'>(),
})

export const ListBatchesOutputSchema = defineTypiaSchema({
  validator: typia.createValidateEquals<ListBatchesOutput>(),
  unit31: typia.json.schema<ListBatchesOutput, '3.1'>(),
})

export const ListDeadLettersInputSchema = defineTypiaSchema({
  validator: typia.createValidateEquals<ListDeadLettersInput>(),
  unit31: typia.json.schema<ListDeadLettersInput, '3.1'>(),
})

export const ListDeadLettersOutputSchema = defineTypiaSchema({
  validator: typia.createValidateEquals<ListDeadLettersOutput>(),
  unit31: typia.json.schema<ListDeadLettersOutput, '3.1'>(),
})

export const RetryDeadLettersInputSchema = defineTypiaSchema({
  validator: typia.createValidateEquals<RetryDeadLettersInput>(),
  unit31: typia.json.schema<RetryDeadLettersInput, '3.1'>(),
})

export const RetryDeadLettersOutputSchema = defineTypiaSchema({
  validator: typia.createValidateEquals<RetryDeadLettersOutput>(),
  unit31: typia.json.schema<RetryDeadLettersOutput, '3.1'>(),
})

export const SiteActionInputSchema = defineTypiaSchema({
  validator: typia.createValidateEquals<SiteActionInput>(),
  unit31: typia.json.schema<SiteActionInput, '3.1'>(),
})

export const SiteActionOutputSchema = defineTypiaSchema({
  validator: typia.createValidateEquals<SiteActionOutput>(),
  unit31: typia.json.schema<SiteActionOutput, '3.1'>(),
})
