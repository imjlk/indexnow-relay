import typia from 'typia'

import { defineTypiaSchema } from '../../schema/define-typia-schema.ts'
import type { SubmitUrlsInput, SubmitUrlsOutput } from './submit-urls.types.ts'

export const SubmitUrlsInputSchema = defineTypiaSchema({
  validator: typia.createValidateEquals<SubmitUrlsInput>(),
  unit31: typia.json.schema<SubmitUrlsInput, '3.1'>(),
  unit30: typia.json.schema<SubmitUrlsInput, '3.0'>(),
})

export const SubmitUrlsOutputSchema = defineTypiaSchema({
  validator: typia.createValidateEquals<SubmitUrlsOutput>(),
  unit31: typia.json.schema<SubmitUrlsOutput, '3.1'>(),
  unit30: typia.json.schema<SubmitUrlsOutput, '3.0'>(),
})
