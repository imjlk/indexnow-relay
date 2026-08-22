import { evidence, type ITtscEvidenceGraphConfig } from '@ttsc/evidence'
import type { ITtscLintConfig } from '@ttsc/lint'

/**
 * Evidence graph: two claims.
 *
 * 1. The implementation answers for the requirements: every H2 section in
 *    docs/REQUIREMENTS.md must be cited (with a reason) by some exported
 *    symbol under src/, so a requirement cannot silently lose its owner.
 * 2. The API answers for its contract: every operation in docs/openapi.json
 *    must be cited by an exported symbol under src/api/, so an endpoint
 *    cannot exist without a declaration that owns it.
 *
 * `bun run generate:openapi` regenerates docs/openapi.json; the graph reads
 * the checked-in document, so contract and citations stay in lockstep.
 */
const graph: ITtscEvidenceGraphConfig = {
  claims: [
    {
      type: 'typescript',
      files: ['src/**'],
      reference: {
        type: 'markdown',
        files: ['docs/REQUIREMENTS.md'],
        symbol: ['h2'],
      },
    },
    {
      type: 'typescript',
      files: ['src/api/**'],
      reference: {
        type: 'swagger',
        file: 'docs/openapi.json',
      },
    },
  ],
}

export default {
  plugins: { evidence },
  rules: {
    // Core hygiene
    'no-var': 'error',
    'prefer-const': 'error',
    'eqeqeq': 'error',
    'no-throw-literal': 'error',

    // TypeScript hygiene
    'typescript/no-explicit-any': 'error',
    'typescript/no-floating-promises': 'error',
    'typescript/no-misused-promises': 'error',
    'typescript/consistent-type-imports': 'error',

    // Evidence: unacknowledged requirements and unowned API operations are
    // build errors; review fingerprints start as warnings for humans to burn
    // down.
    'evidence/graph': ['error', graph],
    'evidence/todo': 'error',
    'evidence/review': 'warning',
  },

  // `ttsc format` uses this block; it does not gate `ttsc --noEmit`.
  format: {
    printWidth: 100,
    singleQuote: true,
    trailingComma: 'all',
  },
} satisfies ITtscLintConfig
