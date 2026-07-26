# Otto Source Inventory

This decision log tracks the large and boundary-sensitive areas found by the 2026-07-23 source-diet issues. It is intentionally conservative: cleanup decisions are recorded before deleting or extracting production code.

## Packages

| Feature/module | Entry points | Tests | Runtime references | Owner package | Decision | Follow-up issue |
| --- | --- | --- | --- | --- | --- | --- |
| CLI/TUI agent | retired in the 1.9.5/1.9.6 LSTC line | none | desktop and server surfaces now own runtime entrypoints | n/a | removed from source tree; do not reintroduce as release payload | #86 |
| Runtime kernel | `packages/core/src/index.ts`, `packages/core/src/core/*` | `packages/core/src/**/*.test.ts` | `otto-core` workspace dependency | `packages/core` | keep, enforce kernel boundary | #90 |
| Enterprise/local server | `packages/server/src/index.ts`, `packages/server/src/server.ts`, `packages/server/src/enterprise/server.ts` | `packages/server/src/**/*.test.ts` | desktop server manager, enterprise one-click bundle | `packages/server` | keep, split enterprise DB/server modules | #85, #87, #91 |
| Desktop app | `packages/desktop/src/main/index.ts`, `packages/desktop/src/renderer/App.tsx` | `packages/desktop/src/**/*.test.ts*` | Electron app and desktop release artifacts | `packages/desktop` | keep, split IPC/CSS and keep installer lightweight | #88, #89 |
| A2A shared protocol | `packages/core/src/a2a/atoaProtocol.ts` | `packages/desktop/src/renderer/atoaProtocol.test.ts`, `packages/server/src/enterprise/server.test.ts` | desktop renderer A2A UI, enterprise A2A inbox/reply tests | `packages/core` | keep as pure shared protocol; no desktop/server deep import | #90 |
| Mem0 adapter | `packages/adapters/mem0/index.ts` | none in adapter package | optional memory adapter | `packages/adapters/mem0` | keep but move imports to public `otto-core` exports | #90 |
| VSCode UI plugin | `packages/vscode-ui-plugin` | plugin-local webview tests/build only | optional IDE companion surface | `packages/vscode-ui-plugin` | keep out of root workspaces until productized | #92 |
| Optional video editor | `resources/video-editor`, `packages/desktop/src/main/video-editor-resource.ts` | `packages/desktop/src/main/video-editor-resource.test.ts`, `packages/desktop/scripts/packaging-contract.test.mjs` | desktop IPC opens editor when installed or available in dev | `resources`, `packages/desktop` | retain source, do not bundle in default desktop release; packaged absence fails loudly | #89 |

## Large Text Files

| Feature/module | Entry points | Tests | Runtime references | Owner package | Decision | Follow-up issue |
| --- | --- | --- | --- | --- | --- | --- |
| Feishu CLI command | retired with `packages/cli` | none | none | n/a | removed from source tree | #86 |
| Feishu gateway | `packages/server/src/feishu/vendor/gateway.ts` | `feishuAdapter.test.ts` | server Feishu adapter | `packages/server` | keep server-owned vendor copy after CLI retirement | #84 |
| Enterprise DB | `packages/server/src/enterprise/db.ts` | `db.test.ts`, park/server tests | enterprise SQLite data path | `packages/server` | keep schema behavior, split by domain | #87 |
| Enterprise HTTP server | `packages/server/src/enterprise/server.ts` | `server.test.ts`, admin HTML tests | enterprise HTTP API and admin UI | `packages/server` | keep, extract pages/routes by domain | #85, #87 |
| Desktop CSS | `packages/desktop/src/renderer/styles/app.css` | renderer component tests | desktop renderer stylesheet import | `packages/desktop` | keep, split by surface | #89 |
| Core custom model adapter | `packages/core/src/core/customModelAdapter.ts` | `customModelAdapter.test.ts` | shared model routing | `packages/core` | keep, review during kernel boundary tightening | #92 |
| CLI App shell | retired with `packages/cli` | none | none | n/a | removed from source tree | #92 |
| CLI i18n catalog | retired with `packages/cli` | none | none | n/a | removed from source tree | #92 |

## Large Binary Assets

| Feature/module | Entry points | Tests | Runtime references | Owner package | Decision | Follow-up issue |
| --- | --- | --- | --- | --- | --- | --- |
| Desktop app icons | `packages/desktop/build/icon.icns`, `packages/desktop/build/icon.png` | packaging contract | Electron builder icon config | `packages/desktop` | keep for installer branding; excluded from extra runtime payload decisions | #89 |
| Otto pet atlas | `packages/desktop/src/renderer/assets/otto-pet-atlas.png` | visual smoke/manual | renderer pet/avatar surfaces | `packages/desktop` | keep pending compression audit | #89 |
| Otto avatar | `packages/desktop/src/renderer/assets/otto-avatar.png` | renderer tests/manual | renderer identity surfaces | `packages/desktop` | keep pending compression audit | #89 |
| Meeting room default image | `packages/desktop/src/renderer/assets/meeting-room-default.png` | park resource tests/manual | park resources UI | `packages/desktop` | keep because Hongchuang park module depends on it visually | #89 |
| CLI sounds | retired with `packages/cli` | none | none | n/a | removed from source tree | #92 |

## Current Guardrails

- `npm run size:source` reports source-like total size, package/root totals, top files, large text files, and large duplicate hashes.
- `npm run size:source:check` fails for new budget violations while keeping the 2026-07-23 cleanup backlog in a named baseline.
- `npm run validate:boundaries` fails new cross-package deep imports and reports the remaining baselined violations with issue IDs.
- `npm run benchmark:low-resource-agents` runs a local, credential-free synthetic multi-agent benchmark for 4GB/8GB/high profiles.
- CI and release workflows run boundary and source-size checks. Release verification checks desktop/enterprise assets, SHA-256, and complete `latest.json` metadata without enforcing installer size as a hard gate.
