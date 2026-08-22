/**
 * Converts a `typia.json.schema<T>()` unit into a standalone JSON Schema
 * document with a single root `$defs` object.
 *
 * typia returns `{ schema, components }` where named types live in
 * `components.schemas` and are referenced via `#/components/schemas/<Name>`.
 * oRPC's Standard JSON Schema consumer assumes one root-level `$defs` object
 * with absolute JSON pointers, so we hoist the components and rewrite refs.
 */

import { isPlainObject, rewriteComponentRefs, type JsonSchemaNode } from './schema-ref-rewriter.ts'

/** Structural view of typia's `IJsonSchemaUnit` runtime value. */
export interface TypiaSchemaUnitLike {
  schema: unknown
  components?: { schemas?: Record<string, unknown> | null } | null
}

export function toStandaloneJsonSchema(unit: TypiaSchemaUnitLike): JsonSchemaNode {
  const schema = rewriteComponentRefs(unit.schema) as JsonSchemaNode
  const defs = unit.components?.schemas
  if (defs === undefined || defs === null || Object.keys(defs).length === 0) {
    return schema
  }

  const existingDefs = isPlainObject(schema.$defs) ? (schema.$defs as JsonSchemaNode) : undefined
  return {
    ...schema,
    $defs: {
      ...existingDefs,
      ...rewriteComponentRefs(defs),
    },
  }
}

/**
 * Verifies that every `$ref` in a standalone schema resolves to a definition
 * that actually exists. Used by tests to guarantee no dangling references leak
 * into the generated OpenAPI document.
 */
export function collectUnresolvedRefs(schema: JsonSchemaNode, root: JsonSchemaNode = schema): string[] {
  const unresolved: string[] = []
  walk(schema)
  return unresolved

  function walk(node: unknown): void {
    if (Array.isArray(node)) {
      for (const item of node) walk(item)
      return
    }

    if (!isPlainObject(node)) return

    for (const [key, value] of Object.entries(node)) {
      if (key === '$ref' && typeof value === 'string') {
        if (!refExists(value, root)) unresolved.push(value)
        continue
      }
      walk(value)
    }
  }
}

function refExists(ref: string, root: JsonSchemaNode): boolean {
  if (!ref.startsWith('#/')) return false
  const segments = ref.slice(2).split('/')
  let current: unknown = root
  for (const segment of segments) {
    if (!isPlainObject(current) || !(segment in current)) return false
    current = current[segment]
  }
  return true
}
