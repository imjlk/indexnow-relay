import ttsc from '@ttsc/unplugin/bun'

/**
 * Production build. Bundles the server AND a small `dist/config.js` library
 * entry so mounted `relay.config.ts` files can self-reference the package:
 *
 *   import { defineConfig, env } from 'indexnow-relay/config'
 *
 * Everything is bundled (typia runtime included) - the runtime image needs
 * no node_modules. The plugin list is pinned to typia (see preload.ts for
 * why @ttsc/lint stays out of transform paths; it gates via `bun run lint`).
 */
const result = await Bun.build({
  entrypoints: ['./src/server.ts', './src/config/index.ts'],
  target: 'bun',
  outdir: './dist',
  sourcemap: 'external',
  splitting: true,
  plugins: [
    ttsc({
      project: './tsconfig.json',
      plugins: [{ transform: 'typia/lib/transform' }],
    }) as never,
  ],
})

if (!result.success) {
  for (const log of result.logs) {
    console.error(log)
  }
  process.exit(1)
}

for (const output of result.outputs) {
  console.log(`built ${output.path} (${output.kind})`)
}
