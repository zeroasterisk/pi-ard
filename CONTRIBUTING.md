# Contributing

Thanks for helping. pi-ard keeps a small surface on purpose, so please open an issue before adding a tool, a config key or a dependency.

## Setup
```
npm ci
npm run check        # typecheck + offline tests; must pass before a PR
npm run test:live    # optional: hits real Hugging Face / GitHub registries
node --experimental-strip-types examples/rpc-smoke.ts   # real pi CLI, confirm over RPC
```
Requires Node ≥ 22.18. TypeScript runs directly, with no build step.

## How changes are made (ADLC)
1. **Spec.** Behavior changes start in `docs/SPEC.md` as a rule with an id (R#). Spec changes go in their own PR, separate from implementation.
2. **Design.** Non-obvious choices get a short entry in `docs/DESIGN.md`.
3. **Test first.** Add a failing test that names the rule. Offline tests use local servers and recorded fixtures (`test/fixtures/live/`), never live calls.
4. **Implement.** Keep `src/core` free of Pi imports.
5. **Evaluate.** Paste the `npm run check` output in the PR. For install or confirm changes, also paste `examples/rpc-smoke.ts` output (both default and `--decline`).
6. **Release.** Maintainers bump `version`, update `CHANGELOG.md` and push a `vX.Y.Z` tag.

## Rules that will block a PR
- Any path that writes, registers or executes without `confirm`.
- Claiming verification the code does not perform (signatures, attestations).
- Guessing URLs (for example, deriving a raw file path from a GitHub `tree/` page).
- Reading config or trust from the project directory.

## Re-recording live fixtures
Registry responses drift. To refresh, re-run the curl commands in `test/fixtures/live/README.md`, keep the old file names and note the date in the PR.

## Code of conduct
See [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).
