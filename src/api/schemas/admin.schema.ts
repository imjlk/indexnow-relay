import typia from 'typia'

import { defineTypiaSchema } from '../../schema/define-typia-schema.ts'
import type {
  AdminOverviewOutput,
  ListBatchesInput,
  ListBatchesOutput,
  ListDeadLettersInput,
  ListDeadLettersOutput,
  RetryDeadLettersInput,
  RetryDeadLettersOutput,
  SiteActionInput,
  SiteActionOutput,
} from './admin.types.ts'

export const AdminOverviewOutputSchema = defineTypiaSchema({
  validator: typia.createValidateEquals<AdminOverviewOutput>(),
  unit31: typia.json.schema<AdminOverviewOutput, '3.1'>(),
  unit30: typia.json.schema<AdminOverviewOutput, '3.0'>(),
})

export const ListBatchesInputSchema = defineTypiaSchema({
  validator: typia.createValidateEquals<ListBatchesInput>(),
  unit31: typia.json.schema<ListBatchesInput, '3.1'>(),
  unit30: typia.json.schema<ListBatchesInput, '3.0'>(),
})

export const ListBatchesOutputSchema = defineTypiaSchema({
  validator: typia.createValidateEquals<ListBatchesOutput>(),
  unit31: typia.json.schema<ListBatchesOutput, '3.1'>(),
  unit30: typia.json.schema<ListBatchesOutput, '3.0'>(),
})

export const ListDeadLettersInputSchema = defineTypiaSchema({
  validator: typia.createValidateEquals<ListDeadLettersInput>(),
  unit31: typia.json.schema<ListDeadLettersInput, '3.1'>(),
  unit30: typia.json.schema<ListDeadLettersInput, '3.0'>(),
})

export const ListDeadLettersOutputSchema = defineTypiaSchema({
  validator: typia.createValidateEquals<ListDeadLettersOutput>(),
  unit31: typia.json.schema<ListDeadLettersOutput, '3.1'>(),
  unit30: typia.json.schema<ListDeadLettersOutput, '3.0'>(),
})

export const RetryDeadLettersInputSchema = defineTypiaSchema({
  validator: typia.createValidateEquals<RetryDeadLettersInput>(),
  unit31: typia.json.schema<RetryDeadLettersInput, '3.1'>(),
  unit30: typia.json.schema<RetryDeadLettersInput, '3.0'>(),
})

export const RetryDeadLettersOutputSchema = defineTypiaSchema({
  validator: typia.createValidateEquals<RetryDeadLettersOutput>(),
  unit31: typia.json.schema<RetryDeadLettersOutput, '3.1'>(),
  unit30: typia.json.schema<RetryDeadLettersOutput, '3.0'>(),
})

export const SiteActionInputSchema = defineTypiaSchema({
  validator: typia.createValidateEquals<SiteActionInput>(),
  unit31: typia.json.schema<SiteActionInput, '3.1'>(),
  unit30: typia.json.schema<SiteActionInput, '3.0'>(),
})

export const SiteActionOutputSchema = defineTypiaSchema({
  validator: typia.createValidateEquals<SiteActionOutput>(),
  unit31: typia.json.schema<SiteActionOutput, '3.1'>(),
  unit30: typia.json.schema<SiteActionOutput, '3.0'>(),
})
