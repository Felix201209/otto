# Otto

Otto 是面向个人与企业的桌面优先 AI coworker / coding agent。它把模型接入、工具执行、技能、记忆、知识治理和桌面工作区放在同一套可审计的运行时中，而不是把聊天、自动化和企业数据拆成彼此孤立的产品。

当前工作分支：`internal` · 当前版本：`1.9.10`

## 现在能做什么

- **完成复杂任务**：支持流式对话、任务型子 agent、工作流编排、待办与检查点；子 agent 会按设备资源预算限制并发、历史和超时，避免无边界扩张。
- **读、改、查代码与文件**：内置文件读写、搜索、补丁/批量编辑、Shell、LSP、代码搜索、网页抓取和网页搜索，并可连接 MCP 工具与资源。
- **使用不同模型而不绑死单一供应商**：模型路由、场景化选择、自定义模型和代理配置都由 core/server 的统一契约处理。
- **把成果变成可复用能力**：Skill 可以被调用、管理和分享；自动生成只会基于稳定的个人知识与可追溯证据给出候选，仍需要用户确认后才会落盘。
- **沉淀个人与企业知识**：个人记忆可在新会话按相关性注入；企业知识有候选、审核、版本与保留策略，普通聊天记录不会直接被当成企业知识。
- **交付可打开的产物**：对话中生成的本地文件可直接在桌面端打开；内置数据分析与可视化 Skill 用于生成可交付的分析结果。
- **支持企业协作**：桌面端内嵌本地/企业服务，提供组织、权限、审计、工作日志、企业知识、Skill 市场与排行、园区服务等模块；飞书是当前已接入的协作通道之一。

## 产品边界

Otto 是一个 npm workspaces monorepo，正式桌面入口是 Electron；服务端既支持本地会话服务，也承载企业 HTTP/WebSocket 能力。

| 包 | 职责 |
| --- | --- |
| `packages/core` | Agent runtime、模型与提示词、工具、MCP、技能、记忆、策略、会话和子 agent 生命周期 |
| `packages/server` | 本地/企业服务、HTTP/WebSocket 协议、企业数据与鉴权、模型配置、飞书桥接 |
| `packages/desktop` | Electron main/preload/renderer、桌面交互、设置与诊断、文档工作区 |
| `otto-native` | Rust 原生热路径绑定：agent pool、tokenizer、session store 与加密相关能力 |

内核只拥有回合生命周期、工具调度、确认与策略、审计事件、模型路由、内存接口和检查点协调。UI、企业业务、供应商适配器、连接器和长期存储实现必须留在边界之外。完整规则见 [runtime kernel boundary](docs/runtime-kernel-boundary.md)。

### 原生热路径的真实状态

Otto 不是 Rust-only 产品。`agent_pool` 已接入 Task 子 agent 生命周期；`tokenizer` 与 `session_store` 有原生 wrapper，但仍保留经过测试的 TypeScript 兼容路径。不要把存在 Rust 目录误读成所有运行路径已经迁移完成。

`OTTO_NATIVE_CORE` 控制运行方式：

- `auto`（默认）：发现可用原生二进制时优先使用，否则安全回退。
- `required`：找不到原生二进制或调用失败即报错，适合锁定的企业发行环境。
- `off`：禁用原生 bridge，用于开发对照。

可通过 `OTTO_NATIVE_CORE_BINARY=/path/to/otto-native` 指定签名后的二进制。

## 快速开始（源码开发）

前置条件：Node.js `>= 22.13.0`；若要构建原生核心，还需要 Rust 工具链。首次安装会编译部分原生依赖，macOS 需要 Xcode Command Line Tools。

```bash
git clone <your-fork-or-remote>
cd otto
npm install
npm run build
npm run start
```

`npm run start` 会启动 `packages/desktop` 的 Electron 应用。开发前先运行环境诊断：

```bash
npm run doctor
```

常用命令：

```bash
# 分包构建与类型检查
npm run build --workspace=packages/core
npm run build --workspace=packages/server
npm run build --workspace=packages/desktop
npm run typecheck

# 运行测试
npm run test --workspace=packages/core
npm run test --workspace=packages/server
npm run test --workspace=packages/desktop

# 发行前检查
npm run doctor
git diff --check
```

构建或发布流程以 [build workflow](docs/build-workflow.md) 和 [release preflight](docs/release-preflight.md) 为准；README 不替代发行门禁。

## 可扩展性与安全

- 新工具、技能、连接器和 GUI 壳通过显式接口/manifest 接入；组件不能覆盖 kernel-owned 路径。
- 高风险工具必须经过确认、策略和审计路径；拒绝与取消是可见结果，不是静默失败。
- MCP 工具、资源和项目自发现工具可接入 registry；工具名和响应会经过防护与校验。
- 企业侧按模块、租户、身份和授权做边界控制；关键持久化操作以 fail-closed 为默认。
- 记忆与知识保留来源信息，便于检索、审核和修订，而不是把整段聊天记录无差别塞进上下文。

## 文档导航

- [架构概览](docs/architecture.md)
- [产品模块边界](docs/product-modules.md)
- [核心运行时与工具 API](docs/core/index.md) / [工具目录](docs/tools/index.md)
- [Skills 使用说明](docs/skills-usage.md)
- [MCP 响应防护](docs/mcp-response-guard.md)
- [自定义模型快速开始](docs/custom-models-quickstart.md)
- [贡献指南](docs/CONTRIBUTING.md)

## 维护原则

1. 先证明真实运行路径改变，再宣称能力已完成；只有 helper 或 UI 入口不算完成。
2. 每次改动保持小、可回滚，并优先补足受影响的聚焦测试。
3. 对 `core`、`server` 和 `desktop` 的状态、转换和业务规则采用 TDD；无法合理测试时说明原因。
4. 不在内核塞产品定制逻辑，也不以日志代替用户可见状态或类型化事件。
5. 发布、升级与安全承诺必须以实际产物、健康检查和回滚路径为准。

## License

See [LICENSE](LICENSE).
