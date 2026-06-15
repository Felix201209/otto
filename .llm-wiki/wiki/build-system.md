---
type: entity
date: 2026-04-09
tags: [build, esbuild, ci-cd, npm, typescript]
sources: [raw/06-build-and-scripts.md]
---

# Build System

> Two-pipeline build system: tsc for NPM, esbuild for bundling.

## Overview

Easy Code 使用两条构建管道：NPM 发布路径使用 `tsc` 逐包编译到 `dist/`，Bundle 路径使用 `esbuild` 打包为单一 `bundle/easycode.js` 文件。

## Pipelines

1. **NPM**: `tsc` → `dist/` per package ([[core-module]] → [[cli-module]] → vscode)
2. **Bundle**: `esbuild` → `bundle/easycode.js` (minified, ESM, node platform)

## CI/CD

- **GitLab CI**: Tag-based triggers (`cli-release-v*`, `vscode-release-v*`)
- **GitHub Actions**: Tag push `v*.*.*` or manual dispatch → GitHub Release with `.tgz`

## Key Commands

| Command | Purpose |
|---------|---------|
| `npm run build` | Build all packages (tsc) |
| `npm run bundle:prod` | Production bundle |
| `npm run pack:prod` | Cross-platform packaging |
| `npm run preflight` | Full validation pipeline |

## Code Quality

- **TypeScript**: strict mode, es2022 target, NodeNext modules
- **ESLint**: flat config, no-explicit-any error, license header enforcement
- **Prettier**: singleQuote, semi, 80 printWidth

## Sources

- [[source-06-build-system]]
