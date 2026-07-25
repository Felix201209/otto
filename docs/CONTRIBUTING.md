# Contributing to Otto

Every issue and pull request in this repo follows a **mechanical, checklist-driven process**. No judgement calls, no "looks good to me" — every gate is verifiable by a script or a human with zero context.

---

## Issue Template

Before filing a feature or bugfix issue, fill out every section. An issue missing any section will be closed or bounced back.

### Required sections

```markdown
### Scope
<!-- What this issue covers. One or two sentences. -->

### Out of scope
<!-- What this issue explicitly does NOT cover. If you're unsure, list it anyway. -->

### Acceptance criteria
<!-- A bullet list of observable, testable outcomes. Use "When … then …" form. -->
- [ ] When … then …

### Tests
<!-- What tests will prove this works? List test file paths or describe new test cases. -->

### Rollback notes
<!-- How do we revert this if it breaks? Is it a pure revert, or does it leave
     data/schema changes behind? -->
```

---

## Pull Request Checklist

Every PR description must include this checklist. Check each box before marking the PR as ready for review.

```markdown
### Verification checklist

- [ ] `npm run typecheck` passes (or `npx tsc --noEmit` per changed package)
- [ ] `npm run test` passes for all changed packages
- [ ] `npm run lint` passes (zero warnings in CI)
- [ ] Changed files audit: every modified file is intentional and listed below
- [ ] New code follows TDD (test first) for `packages/core`, `packages/server`, and `packages/desktop`
- [ ] If tests were skipped for a valid reason, the reason is noted in this PR
```

### Changed files audit

List every file you touched and why. This catches accidental edits (stray
whitespace, wrong file, leftover debug code).

```
packages/core/src/foo.ts — added bar() for issue #N
packages/core/src/foo.test.ts — unit tests for bar()
```

---

## Local verification script

Run `scripts/verify-pr.sh` before pushing. It will:

1. Detect which packages you changed (via `git diff`)
2. Run `npx tsc --noEmit` in each changed package
3. Run `npx vitest run` in each changed package
4. Print a clear PASS or FAIL summary

If it fails, fix the problem before opening a PR.

---

## Dependency installation problems

### `npm install` fails with SSL / certificate errors

```
npm config set strict-ssl false
npm install
npm config set strict-ssl true
```

### `node-gyp` fails (Python 3.12+ missing distutils)

Install Python 3.11 and tell node-gyp to use it:

```bash
# macOS (Homebrew)
brew install python@3.11
npm install --python=python3.11

# Or set it permanently
npm config set python python3.11
```

### `@vscode/ripgrep` postinstall 403 / rate-limited

Pass a GitHub token to avoid anonymous-IP rate limiting:

```bash
GITHUB_TOKEN=$(gh auth token) npm install
```

### `better-sqlite3` native compilation fails

The `mem0ai` dependency pulls in `better-sqlite3`. If it fails:

```bash
# macOS: make sure Xcode CLI tools are installed
xcode-select --install

# Then retry
npm install
```

### Still stuck?

Open an issue with:
- Full error output (redact secrets)
- `node --version`
- `npm --version`
- OS and architecture (`uname -a`)

---

## CI gates

The `.github/workflows/ci.yml` workflow runs on every PR to `internal` and `main`. It must pass before merge. The gate runs:

1. `npm install`
2. `npm run build`
3. `npm run typecheck --workspaces`
4. `npm run test --workspace=packages/core`
5. `npm run test --workspace=packages/server`
7. `npm run test --workspace=packages/desktop`

If CI is red, the PR cannot merge.

---

## Related documents

- [Architecture overview](./architecture.md)
- [Deployment guide](./deployment.md)
- [Troubleshooting](./troubleshooting.md)
- [AGENTS.md](../AGENTS.md) — rules for AI agents working in this repo
