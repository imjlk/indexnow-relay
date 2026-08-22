import { mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

import { buildOpenApiDocument } from '../src/api/openapi.ts'
import { createRouter } from '../src/api/router.ts'
import type { RelayApp } from '../src/api/context.ts'

/**
 * Regenerates docs/openapi.json. The test suite compares the live document
 * against this file, so run this whenever contracts change:
 *
 *   bun run generate:openapi
 */

// A router can be built without a live app: contracts are static and the
// OpenAPI generator only reads them. The app object is never touched during
// generation, so an untyped stand-in keeps the script dependency-free.
const router = createRouter({} as RelayApp)

const document = await buildOpenApiDocument(router)

const target = resolve(import.meta.dir, '../docs/openapi.json')
mkdirSync(dirname(target), { recursive: true })
await Bun.write(target, JSON.stringify(document, null, 2) + '\n')

console.log(`wrote ${target} (${document.info?.title} ${document.info?.version})`)
