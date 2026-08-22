/** IndexNow request body. */
export interface IndexNowPayload {
  host: string
  key: string
  keyLocation: string
  urlList: string[]
}

export function buildPayload(input: IndexNowPayload): IndexNowPayload {
  if (input.urlList.length === 0) {
    throw new Error('buildPayload: urlList must not be empty')
  }
  if (input.urlList.length > 10_000) {
    throw new Error('buildPayload: urlList exceeds the IndexNow limit of 10,000 URLs')
  }
  return { host: input.host, key: input.key, keyLocation: input.keyLocation, urlList: input.urlList }
}
