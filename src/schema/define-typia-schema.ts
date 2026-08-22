/**
 * The typia <-> oRPC bridge.
 *
 * oRPC v2 validates through Standard Schema V1 but derives OpenAPI documents
 * through Standard JSON Schema V1 (`~standard.jsonSchema`). typia provides
 * both halves at compile time:
 *
 *   - `typia.createValidateEquals<T>()` implements `StandardSchemaV1<T, T>`
 *   - `typia.json.schema<T>()` produces the matching JSON Schema + components
 *
 * `defineTypiaSchema()` only combines the two already-compiled artifacts. It
 * must NOT wrap the typia factory calls themselves: the typia transformer
 * resolves concrete generic arguments at compile time, so calling
 * `typia.createValidateEquals<T>()` inside an unresolved generic helper is
 * unsupported. Call sites always spell out the concrete type:
 *
 *   defineTypiaSchema({
 *     validator: typia.createValidateEquals<SubmitUrlsInput>(),
 *     unit31: typia.json.schema<SubmitUrlsInput, '3.1'>(),
 *     unit30: typia.json.schema<SubmitUrlsInput, '3.0'>(),
 *   })
 */

import type { StandardJSONSchemaV1, StandardSchemaV1 } from '@standard-schema/spec'
import type { IJsonSchemaUnit } from 'typia'

import type { JsonSchemaNode } from './schema-ref-rewriter.ts'
import { toStandaloneJsonSchema } from './typia-json-schema.ts'

export interface TypiaSchemaArtifacts<T> {
  /** Strict validator: rejects unknown properties on both input and output. */
  readonly validator: StandardSchemaV1<T, T>
  /** JSON Schema unit for draft-2020-12 / OpenAPI 3.1 targets. */
  readonly unit31: IJsonSchemaUnit<'3.1', T>
  /** Optional unit for openapi-3.0 / draft-07 targets. */
  readonly unit30?: IJsonSchemaUnit<'3.0', T>
}

export interface TypiaStandardSchemaProps<T> extends StandardSchemaV1.Props<T> {
  readonly jsonSchema: StandardJSONSchemaV1.Converter
}

/**
 * A Standard Schema V1 validator that additionally implements Standard JSON
 * Schema V1, so oRPC can generate real OpenAPI schemas instead of falling
 * back to an empty `{}`.
 */
export interface TypiaStandardSchema<T> {
  readonly '~standard': TypiaStandardSchemaProps<T>
}

export function defineTypiaSchema<T>(artifacts: TypiaSchemaArtifacts<T>): TypiaStandardSchema<T> {
  const draft202012 = toStandaloneJsonSchema(artifacts.unit31)
  const draft7 = artifacts.unit30 === undefined ? undefined : toStandaloneJsonSchema(artifacts.unit30)

  const schemaFor = (target: string): JsonSchemaNode => {
    if (target === 'draft-2020-12') return draft202012
    if (target === 'openapi-3.0' || target === 'draft-07') {
      if (draft7 !== undefined) return draft7
      throw new Error(`typia schema does not support target "${target}" (no 3.0 unit provided)`)
    }
    throw new Error(`typia schema does not support target "${target}"`)
  }

  const standardProps = artifacts.validator['~standard']

  return {
    '~standard': {
      version: 1,
      vendor: 'typia',
      validate: (value) => standardProps.validate(value),
      jsonSchema: {
        input: (options) => schemaFor(options.target),
        output: (options) => schemaFor(options.target),
      },
    },
  }
}
