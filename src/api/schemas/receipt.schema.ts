import typia from 'typia'

import { defineTypiaSchema } from '../../schema/define-typia-schema.ts'
import type { GetReceiptInput, GetReceiptOutput } from './receipt.types.ts'

export const GetReceiptInputSchema = defineTypiaSchema({
  validator: typia.createValidateEquals<GetReceiptInput>(),
  unit31: typia.json.schema<GetReceiptInput, '3.1'>(),
  unit30: typia.json.schema<GetReceiptInput, '3.0'>(),
})

export const GetReceiptOutputSchema = defineTypiaSchema({
  validator: typia.createValidateEquals<GetReceiptOutput>(),
  unit31: typia.json.schema<GetReceiptOutput, '3.1'>(),
  unit30: typia.json.schema<GetReceiptOutput, '3.0'>(),
})
