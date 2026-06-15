# LLM Wiki Log

> Chronological record of wiki operations.

## [2026-06-05] update | feishu-integration.md & goal-driven-mode.md — 安全防护与飞书目标路由更新

更新 `.llm-wiki/wiki/feishu-integration.md` 与 `.llm-wiki/wiki/goal-driven-mode.md`：
- **安全日志截断**：新增 `safeTruncateForLog` 机制文档，说明如何通过换行符过滤和 150 字符字符限制来保证 TUI 显示整洁并防止敏感系统提示词/契约泄露。
- **飞书卡片宽度防护**：新增 `clampCodeBlock` 机制说明，说明大容量输出的双重约束（行数与字数限制）如何防止卡片渲染超限。
- **目标模式路由细节**：新增飞书信道中 `/goal` 卡片式交互流程、独立会话中延迟启动（Watchdog 和 YOLO）的核心路由原理。

## [2026-06-03] update | workflow-system.md — 魔法词门控机制文档

更新 `.llm-wiki/wiki/workflow-system.md`，新增「触发方式与魔法词门控」章节：
- 三层防御机制说明（工具描述、system prompt、per-request 硬过滤）
- `filterToolsByMessage()` 实现原理与代码位置
- 如何为其他工具添加魔法词门控的操作指南（含代码模板）

## [2026-06-02] feat | workflow-system.md — Dynamic Workflow 完整文档

新增 `.llm-wiki/wiki/workflow-system.md`，内容包括：
- 架构概览（调用链、核心文件、脚本 API）
- 超时保护链路（4层）、Agent 状态可视化、result.data 规范
- 今日修复的所有 bug 记录（上下文爆炸、脚本 JS 错误、Thinking 卡死、模型 fallback）
- Backlog：P1 Token 预算（含 Anthropic task_budget 调研结论和我们的工程实现方案）、P2 Micro Compact（详细设计）、P3 自定义 Agent 定义文件夹



### Pages Added
- `wiki/background-tasks.md` — Core background process management, CRC32 IDs, cross-platform tree termination, and shell integrations.
- `wiki/feishu-integration.md` — Secure Feishu WebSocket (WSClient) gateway, GCM credential encryption, media downloads, and SendFeishuFileTool sandboxing.
- `wiki/lark-cli-tool.md` — The `lark_cli` tool architecture, live output streams, Device-flow OAuth interception, and argument overflow guards.
- `wiki/goal-driven-mode.md` — Comprehensive guide to the `/goal` driven mode contract, idle watchdog loop, and auto-clear constraints.
- `wiki/context-compression.md` — Context compression pipeline (`CompressionService` and `MicroCompactService` triggers), role prefill safeguards, and state restorations.
- `wiki/adaptive-thinking.md` — Standardized reasoning effort mapping across OpenAI, Gemini, and Claude; Haiku exclusions, and webview BrainIcon indicators.

### Pages Updated
- `wiki/tools-system.md` — Promoted the built-in tool count from 27 to 31, introducing LarkCliTool, LocalTimeTool, GoalAchievedTool, and ImageReaderTool under the new "Workspace & Utilities" category.
- `index.md` — Registered background-tasks, feishu-integration, lark-cli-tool, goal-driven-mode, context-compression, and adaptive-thinking.

---

## [2026-05-30] fix | Corrected oral error in Release Process Guide

### Pages Updated
- `wiki/release-process.md` — 将步骤 5 中的口音错误字样“砸板”修改为规范词“发版”。

---

## [2026-05-29] feat | Release Process Guide

### Pages Added
- `wiki/release-process.md` — 详细记录了 Easy Code 项目的规范化发布流程和核心校验规则。
  - 核心限制：已推送的提交禁止 Amend 机制。
  - 核心红线：`package.json` 中的版本号必须严格低于 release tag 里的版本号，否则 CI/CD 编译发布必将失败。
  - 检索最新 Tag：使用 `git tag -l "cli-release-v*" --sort=-v:refname` 查询最新 tag 并以此计算递增下一个版本号。
  - 标准发版步骤：修改 -> 本地验证(单元测试+构建) -> Git Commit -> 检索计算新 tag -> 推送 ls-dev 分支 -> 打 tag 并推送触发 CI/CD 流程。

### Index Updated
- 在 "Guides & Checklists" 区域追加了 `release-process` 的索引，指向 `wiki/release-process.md`。

---

## [2026-05-22] feat | Built-in Tool Checklist (from local_time debugging)

### Pages Added
- `wiki/adding-builtin-tool-checklist.md` — Checklist & pitfalls for adding
  a new built-in tool to `packages/core/src/tools/`. Captures lessons from
  the `local_time` bug where the tool registered correctly but Anthropic/
  proxy parsed `functionCalls=0` from a `FUNCTION_CALL` finishReason because
  of schema/description format drift from canonical tools.

### Key Lessons Captured
- Description strings must not start with `\n` or contain em-dashes / smart
  quotes / embedded ISO-format quotes
- Constructor should not over-specify the 4 boolean flags; rely on
  [[BaseTool]] defaults like `web-search.ts` does
- `validateToolParams` must call `SchemaValidator.validate` first
- `displayName` should be a single PascalCase word
- Avoid emoji in `returnDisplay` for cross-context safety
- Always `summary` field for UI history collapse
- Bundle must be rebuilt for source changes to take effect
- Reference tools by complexity: `web-search.ts`, `read-lints.ts`,
  `local-time.ts`, `ask-user-question.ts`

### Index Updated
- Added "Guides & Checklists" section with link to the new page

---

## [2026-01-23] feat | Debate UI Enhancement Documentation

### Pages Added
- `wiki/debate-i18n-enhancement.md` — Comprehensive documentation of multilingual debate mode
  - I18n support for Chinese/English UI
  - Language selection workflow
  - Dual-language prompt phrases
  - Settings integration with `preferredLanguage`
  - Implementation details for all 9 modified files

### Index Updated
- Added "Features & Enhancements" section to `index.md`
- Listed new `debate-i18n-enhancement` page

---

## [2026-04-10] lint | Health Check

### Scan Results (32 pages)
- **Dead links:** 0 — all wikilink targets resolve to existing pages
- **Orphan pages:** 0 — all wiki files listed in index.md
- **Incomplete frontmatter:** 1 — `overview.md` used `source:` (string) instead of `sources:` (array)
- **Contradictions:** 0 — tool counts, architecture descriptions consistent across pages
- **Stale content:** 0 — all pages dated 2026-04-09, no outdated references found

### Fixes Applied
1. `wiki/overview.md` — Standardized frontmatter: `source: README.md, package.json` → `sources: [README.md, package.json]` to match convention used by all other pages

### Recommendations (not auto-fixed)
- **Missing entity pages:** Several components mentioned across multiple pages lack dedicated pages:
  - `CompressionService` — referenced in GeminiClient, source-02
  - `LoopDetectionService` — referenced in GeminiClient, source-02
  - `HookPlanner`, `HookRunner`, `HookAggregator`, `HookEventHandler` — 4 of 5 hook layers have no pages
  - `HookTranslator` — version isolation layer mentioned in source-05
- **Thin content pages:** `SkillLoader.md`, `MarketplaceManager.md`, `ProxyAuthManager.md`, `SessionManager.md` have minimal detail (~5-8 lines each)

## [2026-04-09] init | Wiki Initialized
- Created wiki directory structure
- Ready for source ingestion

## [2026-04-09] ingest | Bulk Source Generation from Codebase Analysis
- Analyzed project architecture via docs/architecture.md, package.json, README.md
- Analyzed packages/core/src/ directory structure and key classes
- Analyzed packages/cli/src/ directory structure and entry point
- Analyzed tools system: 27 built-in tools, tool patterns, execution engine
- Analyzed hooks system: 5-layer architecture, 11 event types
- Analyzed build system: esbuild, CI/CD pipelines, npm publishing
- Analyzed MCP system: transports, OAuth, two-phase loading
- Generated 7 raw source documents:
  - raw/01-architecture.md
  - raw/02-core-module.md
  - raw/03-cli-module.md
  - raw/04-tools-system.md
  - raw/05-hooks-system.md
  - raw/06-build-and-scripts.md
  - raw/07-mcp-system.md
- Updated index.md with source listing

## [2026-04-09] lint | Health Check

### Scan Results (32 pages)
- **Dead links:** 0 — all 31 unique wikilink targets resolve correctly
- **Orphan pages (filesystem):** 0 — all wiki files listed in index.md
- **Orphan pages (graph):** 1 — `overview.md` had no incoming `[[overview]]` links
- **Incomplete frontmatter:** 1 — `overview.md` missing `type` field
- **Missing cross-references:** 2 — `overview.md` (0 outgoing wikilinks), `build-system.md` (1 outgoing, missing module links)
- **Thin content:** 4 pages — `SkillLoader.md`, `MarketplaceManager.md`, `ProxyAuthManager.md`, `SessionManager.md`
- **Contradictions:** 0
- **Stale content:** Not applicable (all pages dated 2026-04-09, same-day generation)

### Fixes Applied
1. `wiki/overview.md` — Added missing `type: overview` field to frontmatter
2. `wiki/overview.md` — Added "Related Pages" section with 7 wikilinks to all major system modules; added inline wikilinks in Core Capabilities list
3. `wiki/build-system.md` — Added `[[core-module]]` and `[[cli-module]]` wikilinks in Pipelines section

### Remaining Recommendations (manual)
- Enrich thin entity pages: `SkillLoader.md`, `MarketplaceManager.md`, `ProxyAuthManager.md`, `SessionManager.md`
- Standardize or document `source` (string) vs `sources` (array) convention across page types
- Add `[[overview]]` link from at least one other page to eliminate graph orphan status
- Update individual page dates when content is modified in future edits

## [2026-04-09] ingest | Full Ingestion of All 7 Raw Sources
- Processed all 7 raw source documents into wiki pages
- Created 7 source summary pages:
  - wiki/source-01-architecture.md — Architecture, monorepo, design patterns, dependencies
  - wiki/source-02-core-module.md — Core module structure, 16 directories, key classes
  - wiki/source-03-cli-module.md — CLI module, Ink/React UI, bootstrap sequence, two modes
  - wiki/source-04-tools-system.md — 27 built-in tools, execution state machine, confirmation types
  - wiki/source-05-hooks-system.md — 5-layer pipeline, 11 event types, I/O protocol
  - wiki/source-06-build-system.md — Two build pipelines, CI/CD, TypeScript/ESLint config
  - wiki/source-07-mcp-system.md — MCP transports, two-phase loading, OAuth, tool discovery
- Created 7 system/module entity pages:
  - wiki/core-module.md, wiki/cli-module.md, wiki/tools-system.md
  - wiki/hooks-system.md, wiki/mcp-system.md, wiki/build-system.md, wiki/skills-system.md
- Created 10 class/component entity pages:
  - wiki/GeminiClient.md, wiki/ContentGenerator.md, wiki/EasyCodeServerAdapter.md
  - wiki/SceneManager.md, wiki/Turn.md, wiki/SubAgent.md
  - wiki/ToolRegistry.md, wiki/BaseTool.md, wiki/ToolExecutionEngine.md
  - wiki/DiscoveredMCPTool.md, wiki/mcp-client.md
  - wiki/HookSystem.md, wiki/HookRegistry.md
  - wiki/ProxyAuthManager.md, wiki/SessionManager.md
  - wiki/SkillLoader.md, wiki/MarketplaceManager.md
- All pages include YAML frontmatter (type, date, tags) and [[wikilink]] cross-references
- Updated index.md with full source summaries, entities, and classes
- No contradictions detected between sources
