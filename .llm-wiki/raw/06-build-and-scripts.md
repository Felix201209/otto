# Easy Code — Build System & Scripts Facts

> Auto-generated from codebase analysis on 2026-04-09. Immutable source document.

## Two Build Pipelines

1. **NPM Publication Path**: `tsc` transpiles packages individually into `dist/` directories
2. **Bundle Path** (GitHub npx): `esbuild` creates single `bundle/easycode.js`

## Build Flow (`npm run bundle:prod`)

```
1. npm run build           → scripts/build.js (tsc: core → cli → vscode)
2. node esbuild.config.js  → esbuild bundle → bundle/easycode.js
3. node scripts/copy_bundle_assets.js → .sb, .vsix, help, ripgrep binaries
```

## esbuild Configuration

| Setting | Value |
|---------|-------|
| Entry | `packages/cli/index.ts` |
| Output | `bundle/easycode.js` |
| Platform | `node` |
| Format | `esm` |
| Minify | `true` in production only |
| Externals | `@vscode/ripgrep`, `sharp` |
| Alias | `is-in-ci` → custom patch |
| Banner | CJS compatibility shim (creates `require`, `__filename`, `__dirname` in ESM) |
| Define | `CLI_VERSION`, `DEEPX_SERVER_URL` (default: `https://api-code.easycode-userlab.ai`), `NODE_ENV`, `DEV` |
| Env loading | `dotenv` from `packages/cli/.env.{production,development,test}` |

## CI/CD: GitLab CI

**Trigger**: Tag-based only
- `cli-release-vX.X.X` → CLI npm publish
- `vscode-release-vX.X.X` → VS Code extension publish
- `test-all-vX.X.X` → Test build only

**Stages**: `test-build` → `release` → `release-vscode`

| Stage | Action |
|-------|--------|
| `test-build` | `npm ci` (SKIP_PREPARE=1) → `npm run build` |
| `release` | Extract version from tag → `npm version` → `npm publish` to npmjs.org |
| `release-vscode` | Build core → build vscode → publish to VS Code Marketplace (`vsce`) AND Open VSX (`ovsx`) |

Runner: `easycodecode-docker-runner`, `node:20` image

## CI/CD: GitHub Actions

**Trigger**: Tag push `v*.*.*` or manual `workflow_dispatch`

Steps:
1. Checkout (full history)
2. Node.js 20.19.3 setup with npm cache
3. `npm install`
4. Build webview
5. Sync version across `package.json` files (in-memory, not committed)
6. `npm run pack:prod:ci` (cross-platform, `--no-version-bump`)
7. Create GitHub Release with `.tgz` attached
8. Upload artifact (90-day retention)

## NPM Package

- **Name**: `easycode-ai`
- **Binary**: `easycode` → `bundle/easycode.js`
- **Published files**: `bundle/`, `README.md`, `LICENSE`

### Lifecycle Scripts
| Hook | Script | Purpose |
|------|--------|---------|
| `prepare` | `scripts/prepare.js` | Auto-builds bundle (skip: `SKIP_PREPARE=1`) |
| `prepublishOnly` | `scripts/prepare-publish.js` + `bundle:prod` | Validates README, builds production |
| `postpublish` | `scripts/restore-after-publish.js` | Cleanup |
| `postinstall` | Inline node command | Fix binary permissions |

## TypeScript Configuration

| Setting | Value |
|---------|-------|
| `strict` | `true` |
| `target` | `es2022` |
| `module` | `NodeNext` |
| `moduleResolution` | `nodenext` |
| `lib` | `ES2023` |
| `composite` | `true` |
| `incremental` | `true` |
| `declaration` | `true` |
| `sourceMap` | `true` |
| `jsx` | `react-jsx` |

## Linting & Formatting

### ESLint (Flat config)
- Base: `eslint:recommended` + `typescript-eslint:recommended`
- React: `eslint-plugin-react` + `react-hooks`
- Import: `eslint-plugin-import` — no default exports (warn)
- License header: enforces Google LLC 2025 Apache 2.0 header
- `@typescript-eslint/no-explicit-any`: error
- `no-var`: error, `prefer-const`: error
- Bans `require()` calls and throwing non-Error literals
- Unused vars allowed with `_` prefix

### Prettier
```json
{ "semi": true, "trailingComma": "all", "singleQuote": true, "printWidth": 80, "tabWidth": 2 }
```

## Script Responsibilities

| Script | Purpose |
|--------|---------|
| `build.js` | Orchestrates workspace builds (core → cli → vscode) |
| `start.js` | Dev launcher with env loading, debug, silent mode |
| `newpack.js` | Full packaging: version bump → build → npm pack → optional install |
| `copy_bundle_assets.js` | Copies .sb, .vsix, help, ripgrep binaries into bundle/ |
| `prepare.js` | npm prepare hook — triggers bundle build |
| `prepare-publish.js` | Pre-publish README validation |
| `restore-after-publish.js` | Post-publish cleanup |
| `download_ripgrep_binaries.js` | Downloads platform-specific ripgrep binaries |
| `build_sandbox.js` | Builds Docker sandbox container |
| `build_vscode_companion.js` | Builds VS Code IDE companion |
| `clean.js` | Removes all build artifacts |
| `version.js` | Version management utility |
| `generate-git-commit-info.js` | Generates git commit metadata |
| `fix-binary-permissions.js` | Fixes binary exec permissions (postinstall) |
| `npm-publish-check.js` | Validates publish readiness |

## Key Build Commands

| Command | Purpose |
|---------|---------|
| `npm run dev` | Development mode with debug flags |
| `npm run build` | Build all packages (tsc) |
| `npm run bundle` | Build + esbuild bundle + copy assets |
| `npm run bundle:prod` | Production bundle (minified) |
| `npm run pack:prod` | Full cross-platform production packaging |
| `npm run pack:prod:ci` | CI packaging (no version bump) |
| `npm run preflight` | Clean → ci → format → lint → build → typecheck → test |
