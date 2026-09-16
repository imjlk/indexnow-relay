export type SubmissionOutcome =
  | { kind: 'success'; httpStatus: number; keyValidationPending: boolean }
  | { kind: 'retryable'; reason: string; httpStatus: number | undefined }
  | { kind: 'permanent'; reason: string; httpStatus: number | undefined }

export interface RawSubmitResult {
  /** True when the HTTP call itself completed. */
  completed: boolean
  httpStatus: number | undefined
  /** Raw `Retry-After` header value, when the response carried one. */
  retryAfter: string | null
  /** Network-level failure (DNS, timeout, reset). */
  networkError: boolean
}

/**
 * IndexNow response classification:
 *
 * - 200 OK             -> submitted
 * - 202 Accepted       -> submitted, but the key has not been validated yet
 * - 429 / 5xx / network -> retry with backoff
 * - 400 / 403 / 422 etc. -> permanent failure (bad request, invalid key,
 *                          URLs not matching the host); retrying cannot help
 *
 * Unexpected answers (1xx, 3xx) are never treated as success.
 *
 * @evidence docs/REQUIREMENTS.md#delivery-semantics Encodes the IndexNow
 *           response policy: 200/202 succeed, 429/5xx/network retry, other
 *           4xx fail permanently.
 */
export function classifySubmitResult(result: RawSubmitResult): SubmissionOutcome {
  if (result.networkError || !result.completed) {
    return { kind: 'retryable', reason: 'network_error', httpStatus: undefined }
  }

  const status = result.httpStatus ?? 0

  if (status === 200) {
    return { kind: 'success', httpStatus: status, keyValidationPending: false }
  }
  if (status === 202) {
    return { kind: 'success', httpStatus: status, keyValidationPending: true }
  }
  if (status === 429 || (status >= 500 && status <= 599)) {
    return { kind: 'retryable', reason: `http_${status}`, httpStatus: status }
  }
  return { kind: 'permanent', reason: `http_${status}`, httpStatus: status }
}
