import { describe, expect, test } from 'bun:test'

import { createRouter } from '../src/api/router.ts'
import type { RelayApp } from '../src/api/context.ts'
import { buildOpenApiDocument } from '../src/api/openapi.ts'
import { collectUnresolvedRefs } from '../src/schema/typia-json-schema.ts'

// The OpenAPI generator only reads contracts, so a placeholder app is safe.
const router = createRouter({} as RelayApp)
const document = await buildOpenApiDocument(router)

describe('OpenAPI document', () => {
  test('matches the checked-in snapshot (run `bun run generate:openapi` after contract changes)', async () => {
    const snapshot = await Bun.file('docs/openapi.json').json()
    // `info.version` tracks package.json and is bumped by release PRs
    // without regenerating this file; the served spec always carries the
    // live version, so only the shape is snapshotted.
    const stripVersion = (doc: Record<string, unknown>): Record<string, unknown> => {
      const info = { ...((doc['info'] as Record<string, unknown>) ?? {}) }
      delete info['version']
      return { ...doc, info }
    }
    expect(stripVersion(document as unknown as Record<string, unknown>)).toEqual(
      stripVersion(snapshot as Record<string, unknown>),
    )
  })

  test('has no dangling $refs anywhere in the document', () => {
    expect(collectUnresolvedRefs(document as unknown as Record<string, unknown>)).toEqual([])
  })

  test('describes POST /v1/urls with a real (non-empty) request schema', () => {
    const paths = document.paths as Record<string, Record<string, { requestBody?: { content: Record<string, { schema: unknown }> } }>>
    const post = paths['/v1/urls']!.post!
    const schema = post.requestBody!.content['application/json']!.schema as Record<string, unknown>

    // The request schema itself is concrete (not an empty `{}` fallback)...
    expect(Object.keys(schema).length).toBeGreaterThan(0)
    expect(schema['additionalProperties']).toBe(false)
    // ...and its constraints live in hoisted components.
    const wholeDocument = JSON.stringify(document)
    expect(wholeDocument).toContain('"minItems"')
    expect(wholeDocument).toContain('"maxItems"')
  })

  test('maps domain error codes to HTTP statuses', () => {
    const paths = document.paths as Record<string, Record<string, { responses: Record<string, unknown> }>>
    const post = paths['/v1/urls']!.post!
    expect(post.responses['401']).toBeDefined()
    expect(post.responses['403']).toBeDefined()
    expect(post.responses['400']).toBeDefined()
  })

  test('describes the receipt path parameter', () => {
    type WithParams = { parameters?: Array<{ name: string; in: string }> }
    const paths = document.paths as Record<string, Record<string, WithParams>>
    const get = paths['/v1/receipts/{id}']!.get!
    const pathParam = get.parameters!.find((p) => p.in === 'path')
    expect(pathParam!.name).toBe('id')
  })
})
