import typia from 'typia'
import type { tags } from 'typia'

import { defineTypiaSchema } from '../../schema/define-typia-schema.ts'

/** `POST /v1/sitemap` DTO - bulk ingest via a remote sitemap. */
export interface SitemapSubmitInput {
  /** Absolute http(s) URL of a sitemap.xml or sitemap index. */
  url: string & tags.MinLength<1> & tags.MaxLength<2048>
}

export const SitemapSubmitInputSchema = defineTypiaSchema({
  validator: typia.createValidateEquals<SitemapSubmitInput>(),
  unit31: typia.json.schema<SitemapSubmitInput, '3.1'>(),
})
