import { describe, expect, test } from 'bun:test'
import type { tags } from 'typia'
import typia from 'typia'

import { defineTypiaSchema } from '../src/schema/define-typia-schema.ts'
import { collectUnresolvedRefs } from '../src/schema/typia-json-schema.ts'

interface PayloadItem {
  host: string
  count: number & tags.Minimum<0>
}

interface Payload {
  urls: string[] & tags.MinItems<1> & tags.MaxItems<10>
  items: PayloadItem[]
}

const schema = defineTypiaSchema({
  validator: typia.createValidateEquals<Payload>(),
  unit31: typia.json.schema<Payload, '3.1'>(),
  unit30: typia.json.schema<Payload, '3.0'>(),
})

describe('defineTypiaSchema', () => {
  test('validates through Standard Schema V1', () => {
    const ok = schema['~standard'].validate({ urls: ['https://example.com/'], items: [{ host: 'a', count: 1 }] })
    expect('issues' in ok).toBe(false)
  })

  test('rejects unknown properties (createValidateEquals semantics)', () => {
    const result = schema['~standard'].validate({ urls: [], items: [], extra: true })
    expect('issues' in result).toBe(true)
  })

  test('rejects constraint violations', () => {
    const empty = schema['~standard'].validate({ urls: [], items: [] })
    expect('issues' in empty).toBe(true)

    const negative = schema['~standard'].validate({ urls: ['https://a/'], items: [{ host: 'a', count: -1 }] })
    expect('issues' in negative).toBe(true)
  })

  test('serves draft-2020-12 JSON Schema with resolvable refs', () => {
    const json = schema['~standard'].jsonSchema.input({ target: 'draft-2020-12' })
    expect((json as { type?: string }).type).toBe('object')
    expect((json as { [k: string]: unknown })['$defs']).toBeDefined()
    expect(collectUnresolvedRefs(json as Record<string, unknown>)).toEqual([])
  })

  test('serves openapi-3.0 JSON Schema', () => {
    const json = schema['~standard'].jsonSchema.output({ target: 'openapi-3.0' })
    expect(collectUnresolvedRefs(json as Record<string, unknown>)).toEqual([])
  })

  test('throws for unsupported targets', () => {
    expect(() => schema['~standard'].jsonSchema.input({ target: 'draft-04' })).toThrow(/draft-04/)
  })

  test('carries array constraints into the JSON Schema', () => {
    const json = schema['~standard'].jsonSchema.input({ target: 'draft-2020-12' }) as {
      properties: { urls: { minItems?: number; maxItems?: number } }
    }
    expect(json.properties.urls.minItems).toBe(1)
    expect(json.properties.urls.maxItems).toBe(10)
  })
})
