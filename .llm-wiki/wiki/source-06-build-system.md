---
type: source-summary
date: 2026-04-09
tags: [build, esbuild, ci-cd, npm, typescript, eslint, prettier]
source: raw/06-build-and-scripts.md
---

# Source Summary: Build System & Scripts

> Summary of [raw/06-build-and-scripts.md](../raw/06-build-and-scripts.md)

## Two Build Pipelines

1. **NPM Publication**: `tsc` transpiles packages individually → `dist/` directories
2. **Bundle Path** (GitHub npx): `esbuild` → single `bundle/easycode.js`

## Bundle Flow (`npm run bundle:prod`)

1. `npm run build` → `scripts/build.js` (tsc: core → cli → vscode)
2. `node esbuild.config.js` → esbuild → `bundle/easycode.js`
3. `node scripts/copy_bundle_assets.js` → .sb, .vsix, help, ripgrep binaries

## esbuild Configuration

| Setting | Value |
|---------|-------|
| Entry | `packages/cli/index.ts` |
| Output | `bundle/easycode.js` |
| Platform | `node`, Format `esm`, Minify in production |
| Externals | `@vscode/ripgrep`, `sharp` |
| Banner | CJS compatibility shim (creates `require`, `__filename`, `__dirname` in ESM) |
| Define | `CLI_VERSION`, `DEEPX_SERVER_URL` (default: `https://api-code.easycode-userlab.ai`), `NODE_ENV`, `DEV` |

## CI/CD: GitLab CI

Tag-based triggers:
- `cli-release-vX.X.X` → CLI npm publish
- `vscode-release-vX.X.X` → VS Code extension publish
- `test-all-vX.X.X` → Test build only

Stages: `test-build` → `release` → `release-vscode`

Runner: `easycodecode-docker-runner`, `node:20` image

## CI/CD: GitHub Actions

Trigger: Tag push `v*.*.*` or manual `workflow_dispatch`

Steps: Checkout → Node.js 20.19.3 → npm install → Build webview → Sync versions → `npm run pack:prod:ci` → GitHub Release with `.tgz`

## NPM Package

- **Name**: `easycode-ai`, Binary: `easycode` → `bundle/easycode.js`
- **Published files**: `bundle/`, `README.md`, `LICENSE`

## TypeScript Configuration

`strict: true`, `target: es2022`, `module: NodeNext`, `jsx: react-jsx`, `composite: true`, `incremental: true`

## Linting & Formatting

- **ESLint** (flat config): `eslint:recommended` + `typescript-eslint`, React + React Hooks, import plugin, license header enforcement, `@typescript-eslint/no-explicit-any: error`
- **Prettier**: `semi: true`, `singleQuote: true`, `printWidth: 80`, `tabWidth: 2`, `trailingComma: all`

## Key Scripts

| Script | Purpose |
|--------|---------|
| `build.js` | Orchestrates workspace builds |
| `start.js` | Dev launcher |
| `newpack.js` | Full packaging with version bump |
| `copy_bundle_assets.js` | Copies assets into bundle/ |
| `download_ripgrep_binaries.js` | Platform-specific ripgrep |
| `build_sandbox.js` | Docker sandbox |
| `clean.js` | Removes build artifacts |

## Key Commands

| Command | Purpose |
|---------|---------|
| `npm run dev` | Development mode |
| `npm run build` | Build all (tsc) |
| `npm run bundle:prod` | Production bundle |
| `npm run pack:prod` | Cross-platform packaging |
| `npm run preflight` | Clean → ci → format → lint → build → typecheck → test |

## Related Pages

- [[source-01-architecture]]
- [[core-module]]
- [[cli-module]]
