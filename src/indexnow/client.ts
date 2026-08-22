import type { RawSubmitResult } from './response-policy.ts'
import type { IndexNowPayload } from './payload.ts'

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>

export interface IndexNowClientOptions {
  /** Shared endpoint by default; forwards to participating engines. */
  endpoint: string
  timeoutMs: number
  userAgent: string
  fetchImpl?: FetchLike
}

/**
 * Minimal IndexNow client: POST one JSON payload, classify nothing (that is
 * `response-policy.ts`'s job), and never throw for network problems.
 */
export class IndexNowClient {
  readonly #options: IndexNowClientOptions
  readonly #fetch: FetchLike

  constructor(options: IndexNowClientOptions) {
    this.#options = options
    this.#fetch = options.fetchImpl ?? ((input, init) => fetch(input, init))
  }

  async submitUrls(payload: IndexNowPayload): Promise<RawSubmitResult> {
    try {
      const response = await this.#fetch(this.#options.endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json; charset=utf-8',
          'user-agent': this.#options.userAgent,
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(this.#options.timeoutMs),
      })
      return { completed: true, httpStatus: response.status, networkError: false }
    } catch {
      return { completed: false, httpStatus: undefined, networkError: true }
    }
  }
}
