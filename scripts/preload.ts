import ttsc from '@ttsc/unplugin/bun'

/**
 * Registers the ttsc transform as a Bun runtime plugin so that typia
 * factories (`createValidateEquals`, `json.schema`) are compiled even when
 * Bun executes TypeScript directly (dev server, tests, scripts).
 */
Bun.plugin(ttsc({ project: './tsconfig.json' }) as never)
