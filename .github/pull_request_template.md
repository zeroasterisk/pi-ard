## What and why

<!-- Link the issue. Name the SPEC rule (R#) this touches, or the new rule proposed in a separate docs PR. -->

## Evidence

<details><summary>npm run check</summary>

```
paste output
```
</details>

<!-- If install/confirm behavior changed: paste examples/rpc-smoke.ts output, default and --decline. -->

## Checklist
- [ ] No path writes, registers or executes without `confirm`
- [ ] No verification is claimed that the code does not do
- [ ] `src/core` has no Pi imports
- [ ] CHANGELOG `[Unreleased]` updated (user-visible changes)
