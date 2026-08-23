import ttsc from '@ttsc/unplugin/bun'

/**
 * Docker-build warm-up: compiles the ttsc/typia native plugin through the
 * exact same path (Bun.build + @ttsc/unplugin/bun with the plugin list
 * pinned to typia) as scripts/build.ts, so the compiled plugin lands in
 * node_modules/.cache/ttsc and the real build gets a cache hit. Runs in a
 * lockfile-keyed Docker layer - see Dockerfile.
 */
const result = await Bun.build({
  entrypoints: ['./docker/warm.ts'],
  target: 'bun',
  outdir: './node_modules/.cache/warm-dist',
  plugins: [
    ttsc({
      project: './docker/tsconfig.warm.json',
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
console.log('warm build ok: plugin cache populated')
