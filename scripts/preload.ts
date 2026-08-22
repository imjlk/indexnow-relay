import ttsc from '@ttsc/unplugin/bun'

/**
 * Registers the ttsc transform as a Bun runtime plugin so that typia
 * factories (`createValidateEquals`, `json.schema`) are compiled even when
 * Bun executes TypeScript directly (dev server, tests, scripts).
 *
 * The plugin list is pinned to typia only: without an explicit list the
 * unplugin auto-discovers installed @ttsc packages, and @ttsc/lint's config
 * evaluator cannot load under the Bun runtime (it needs Node's
 * module.registerHooks). Lint and the evidence graph run through the native
 * `ttsc` CLI instead (`bun run lint` -> tsconfig.lint.json).
 */
Bun.plugin(
  ttsc({
    project: './tsconfig.json',
    plugins: [{ transform: 'typia/lib/transform' }],
  }) as never,
)
