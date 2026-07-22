<!--
  Every PR must fill out this template.
  See docs/CONTRIBUTING.md for the full contributor guide.
  Run scripts/verify-pr.sh before opening.
-->

## Summary

<!-- One or two sentences describing what this PR does. -->

## Issue

<!-- Link the issue this PR closes. Use "Closes #N". -->

Closes #

## Verification checklist

<!-- Check each box before marking ready for review. -->

- [ ] `npm run typecheck` passes (or `npx tsc --noEmit` per changed package)
- [ ] `npm run test` passes for all changed packages
- [ ] `npm run lint` passes (zero warnings)
- [ ] `scripts/verify-pr.sh` passes locally
- [ ] Changed files audit below is complete
- [ ] New code in `packages/cli` or `packages/core` follows TDD (test-first)
- [ ] If tests were skipped, the reason is noted below

## Changed files audit

<!-- List every file you touched and why. -->

```
packages/core/src/foo.ts — added bar() for issue #N
packages/core/src/foo.test.ts — unit tests for bar()
```

## Skipped tests

<!-- If any tests were skipped, explain why here. Leave blank if not applicable. -->

## Rollback plan

<!-- How do we revert this if it breaks? Pure git revert, or extra steps? -->

- [ ] Pure git revert — no side effects
- [ ] Also needs: (describe any schema migrations, config changes, etc.)
