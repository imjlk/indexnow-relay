# Contributing

Thanks for considering a contribution!

## Development setup

```bash
git clone https://github.com/imjlk/indexnow-relay.git
cd indexnow-relay
bun install          # Bun >= 1.4 required
```

## Everyday commands

```bash
bun run dev            # dev server with watch + typia transform
bun run typecheck      # ttsc --noEmit (TypeScript 7)
bun test               # full test suite
bun run build          # production bundle into dist/
bun run generate:openapi   # regenerate docs/openapi.json after contract changes
```

## Ground rules

- **Pure TypeScript types are the schema.** API inputs and outputs are plain
  interfaces validated by `typia.createValidateEquals` and exposed to oRPC
  through the Standard Schema bridge in `src/schema/`. Do not introduce
  another validation library.
- **The typia transformer must stay active in every execution path.** Dev and
  tests run through `scripts/preload.ts`; production runs the bundled
  `dist/server.js`. If you add an entry point, keep both paths working.
- If you change any API contract, run `bun run generate:openapi` and commit
  the updated `docs/openapi.json` (the test suite enforces this).
- Keep secrets out of code, logs, and the database. Use the `env()` helper in
  config files.

## Pull requests

1. Fork / branch from `main`.
2. Make your change with tests.
3. Ensure `bun run typecheck`, `bun test`, and `bun run build` all pass.
4. Open a PR describing what changed and why.
