import type { NormalizedQueueConfig } from '../config/config.types.ts'

/**
 * Exponential backoff with capped jitter.
 *
 * attempt 1 failed -> base * 2^0, attempt 2 -> base * 2^1, ... capped at
 * `backoffMaxMs`. A random 0-30% is added to de-synchronize sites that fail
 * together (e.g. after a network blip).
 *
 * @evidence docs/REQUIREMENTS.md#retries-and-dead-letters Computes the
 *           exponential backoff schedule for retryable failures.
 */
export function retryDelayMs(attempt: number, queue: NormalizedQueueConfig): number {
  const exp = Math.min(queue.backoffBaseMs * 2 ** Math.max(0, attempt - 1), queue.backoffMaxMs)
  const jitter = Math.floor(exp * 0.3 * Math.random())
  return Math.min(exp + jitter, queue.backoffMaxMs)
}
