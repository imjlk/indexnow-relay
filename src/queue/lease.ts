import type { NormalizedQueueConfig } from '../config/config.types.ts'

/** Lease ids are random, not ULIDs: they never need ordering. */
export function createLeaseId(): string {
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  return Buffer.from(bytes).toString('hex')
}

/**
 * A lease must outlive the slowest possible IndexNow call plus headroom, so
 * a live worker is never robbed of its rows by the recovery sweep.
 */
export function leaseDurationMs(queue: NormalizedQueueConfig): number {
  return queue.httpTimeoutMs + 15_000
}

export function leaseUntil(now: number, queue: NormalizedQueueConfig): number {
  return now + leaseDurationMs(queue)
}
