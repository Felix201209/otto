# Otto 架构概览

> 本文档反映 Otto 项目的真实架构（2026-07 更新），替代原 Gemini CLI 遗留文档。

## 顶层包结构

Otto 采用 Monorepo（npm workspaces）管理，包含以下包：

| 包 | 职责 |
|---|---|
| **otto-core** (`packages/core`) | 后端引擎：AI 客户端、工具系统（40+工具）、Prompt 构建、会话管理、记忆系统、技能系统、企业编排（orchestration）、鉴权、遥测 |
| **otto-server** (`packages/server`) | 本地 HTTP+WS 服务：唯一会话真相源、飞书网关桥、自定义模型管理、企业仪表盘 |
| **otto-desktop** (`packages/desktop`) | Electron 应用（main/preload/renderer）：内嵌 server，承载企业 UI、右侧文档工作区和更新入口 |
| **skills/native** (`packages/core/skills-seed`, `otto-native`) | 可插拔办公 Skill、文档运行时脚本与原生热路径；通过 component/kernel manifest 进入 LSTC 更新链路 |

## 包间依赖

```
otto-core（无下游依赖）
  ↑
  ├── otto-server（依赖 core）
  │     ↑
  │     └── otto-desktop（依赖 server → core）
  └── skills/native（由 core 加载、由 manifest 分发）
```

## 运行时数据流

```
用户输入（桌面端 / 飞书 / CLI）
  ↓
otto-server（WS 消息分发 + 会话管理）
  ↓
otto-core（OttoChat → 模型 API → 工具执行 → 流式回复）
  ↓
broadcast 帧 → 所有订阅者（桌面端渲染 / 飞书卡片 / CLI 渲染）
```

`SessionStore.publish()` 是广播中枢，core 驱动与展示层彻底解耦。

## 飞书集成

两条路径，共享 `vendor/gateway.ts`：

- **server 内嵌**：桌面端启动时 `FeishuGateway` → WS 长连接 → `FeishuAdapter` → core
- **CLI daemon**：`otto feishu daemon start` → 独立进程 → 同一 Gateway

## 企业组织架构

```
otto enterprise setup → 绑定飞书企业（appSecret AES-256-GCM 加密）
  ↓
otto enterprise sync → 拉取部门树 + 人员 → OrgMemoryStore
  ↓
自动生成权限许可（4 级角色：admin/manager/hr/employee）
  ↓
定时同步（1h 增量 / 24h 全量）→ 离职自动撤销权限
```

## orchestration 层（10 个模块）

| 模块 | 职责 | 接入状态 |
|---|---|---|
| workLog | 工作日志自动记录 | ✅ 已接入 |
| auditLog | 审计日志 | ✅ 已接入 |
| skillShare | Skill 分享/打分/评论/市场/排行榜 | ✅ 已接入 |
| enterpriseSync | 飞书组织架构同步 + RBAC | ✅ 已接入 |
| taskOrchestrator | LangGraph 任务编排状态机 | ✅ 可用 |
| knowledgeTransfer | 离职交接/记忆导出 | ✅ 可用 |
| proactiveService | 主动服务（周报提醒/晨间简报） | ✅ 飞书通道已注入 |
| multiAgent | 多 Otto 协作 | ✅ 飞书通道已注入 |
| autoSkillGenerator | 从日志自动生成 Skill | ✅ 扫描器已就绪 |
| ortoolsClient | OR-Tools 任务优化 | ⚠️ 需 Python 服务 |

## 存储层

| 数据 | 路径 | 格式 |
|---|---|---|
| 会话历史 | `~/.otto-user/sessions/*.json` | JSON（原子写入） |
| 飞书凭证 | `~/.otto-user/feishu-credentials.json` | JSON（AES-256-GCM） |
| 企业配置 | `~/.otto-user/enterprise.json` | JSON（appSecret 加密） |
| 工作日志 | `~/.otto-user/memory/worklog/daily/*.jsonl` | JSONL |
| 审计日志 | `~/.otto-user/audit/audit-*.jsonl` | JSONL |
| 组织记忆 | `.otto/org/memory-store.json` | JSON（文件锁互斥） |
| Skill 分享 | `.otto/org/skill-shares.json` | JSON |
| 个人技能 | `~/.otto-user/skills/*/SKILL.md` | Markdown |

## 桌面端（Electron 三层）

| 层 | 职责 |
|---|---|
| **Main** | 窗口管理、内嵌 server、IPC handlers（9 个企业 API）、安全基线 |
| **Preload** | WS 连接管理、contextBridge 桥接、退避重连 |
| **Renderer** | React 18 DOM UI、7 个右侧面板 Tab、部门标签、智能体列表 |

右侧面板 7 个 Tab：`记忆 | 浏览器 | 笔记 | 排行榜 | 工作日志 | 审计 | Skill 市场`

## 技术栈

- TypeScript 5.x + Node.js 20+
- React 18（桌面端）
- esbuild（构建）/ Vitest（测试）
- Electron 33（桌面端）
- @larksuiteoapi/node-sdk（飞书）
- @langchain/langgraph（任务编排）
- mem0ai（结构化记忆，可选）
