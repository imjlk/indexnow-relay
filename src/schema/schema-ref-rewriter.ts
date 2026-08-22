/**
 * Generic JSON-Schema `$ref` rewriting.
 *
 * typia emits component references as `#/components/schemas/<Name>`.
 * Standalone JSON Schema (and oRPC's Standard JSON Schema consumer) expects
 * definitions under a single root `$defs` object with `#/$defs/<Name>` refs.
 */

export type JsonSchemaNode = Record<string, unknown>

const COMPONENT_REF_PREFIX = '#/components/schemas/'
const DEFS_REF_PREFIX = '#/$defs/'

export function rewriteComponentRefs<T>(node: T): T {
  return deepRewrite(node) as T
}

function deepRewrite(node: unknown): unknown {
  if (Array.isArray(node)) {
    return node.map((item) => deepRewrite(item))
  }

  if (isPlainObject(node)) {
    const out: JsonSchemaNode = {}
    for (const [key, value] of Object.entries(node)) {
      out[key] =
        key === '$ref' && typeof value === 'string' && value.startsWith(COMPONENT_REF_PREFIX)
          ? DEFS_REF_PREFIX + value.slice(COMPONENT_REF_PREFIX.length)
          : deepRewrite(value)
    }
    return out
  }

  return node
}

export function isPlainObject(value: unknown): value is JsonSchemaNode {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
