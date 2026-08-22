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
bun run dev                # dev server with watch + typia transform
bun run typecheck          # ttsc --noEmit (TypeScript 7 + typia)
bun run lint               # ttsc + @ttsc/lint + the evidence graph (the full gate)
bun test                   # full test suite
bun run build              # production bundle into dist/
bun run generate:openapi   # regenerate docs/openapi.json after contract changes
```

## Ground rules

- **Pure TypeScript types are the schema.** API inputs and outputs are plain
  interfaces validated by `typia.createValidateEquals` and exposed to oRPC
  through the Standard Schema bridge in `src/schema/`. Do not introduce
  another validation library.
- **The typia transformer must stay active in every execution path.** Dev and
  tests run through `scripts/preload.ts`; production runs the bundled
  `dist/server.js`; lint runs through the native `ttsc` CLI
  (`tsconfig.lint.json`). If you add an entry point, keep those paths
  working. `@ttsc/lint` cannot load under the Bun runtime (it needs Node's
  `module.registerHooks`), so it stays CLI-only.
- **Every user-facing change needs a changeset.** Add a file under
  `.sampo/changesets/` (see `.sampo/changeset.md.example`, or run `sampo
  add`). Merging to `main` with pending changesets opens a release PR that
  bumps the version and regenerates `CHANGELOG.md`; merging that PR tags
  `vX.Y.Z` and publishes the GHCR image.
- **Keep the evidence graph true.** Every H2 section in
  `docs/REQUIREMENTS.md` must be cited by an exported symbol in `src/` with
  an `@evidence <target> <reason>` tag, and every operation in
  `docs/openapi.json` must be cited by its contract declaration. If you add a
  requirement or an endpoint, add the citation; if you remove one, remove the
  citation. `bun run lint` fails otherwise — never leave an untrue tag
  standing just to pass.
- If you change any API contract, run `bun run generate:openapi` and commit
  the updated `docs/openapi.json` (the test suite enforces this).
- Keep secrets out of code, logs, and the database. Use the `env()` helper in
  config files.

## Pull requests

1. Fork / branch from `main`.
2. Make your change with tests and a changeset.
3. Ensure `bun run lint`, `bun test`, and `bun run build` all pass.
4. Open a PR describing what changed and why.
