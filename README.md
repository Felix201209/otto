# Otto

Otto 是一个正在走向成熟形态的 agent 产品：核心要轻、边界要稳、组件要独立、低资源设备也要能开多个子 agent。

这份 README 优先给维护者和后续 agent 看。先说清楚当前状态，避免任何模型一上来就误判架构。

## 当前内核状态

当前 `1.9.9` 是 LSTC（Long-term Stable Channel）目标版本，正式产品入口是 Electron 桌面端与独立企业服务端：

- 桌面端: `packages/desktop`
- 企业服务端: `packages/server`
- 核心 TypeScript 包: `packages/core`
- Rust 原生核心目录: `otto-native`

旧 CLI/TUI 已退出桌面发布路径。Otto 仍不是完全 Rust-only：Rust 已经成为热路径接管方向，并且已有 core bridge 和 runtime wrapper；部分 TypeScript 调用点继续作为经过测试的兼容 fallback。

当前 Rust 接管进度：

| 热路径 | 当前状态 | 主要文件 |
| --- | --- | --- |
| `agent_pool` | 已接入真实 Task 子 agent 生命周期 | `packages/core/src/native/nativeAgentPoolRuntime.ts`, `packages/core/src/tools/task.ts`, `otto-native/src/agent_pool.rs` |
| `tokenizer` | 已有 native runtime wrapper，旧 token fallback 调用点待迁移 | `packages/core/src/native/nativeTokenizerRuntime.ts`, `otto-native/src/tokenizer.rs` |
| `session_store` | 已有 native runtime wrapper，旧会话持久化调用点待格式兼容测试后迁移 | `packages/core/src/native/nativeSessionStoreRuntime.ts`, `otto-native/src/session_store.rs` |

`agent_pool` 现在已经会在 Task 子 agent 启动时注册到 Rust 原生池，结束时上报最终 RSS 内存并注销。`tokenizer` 和 `session_store` 的 Rust wrapper 已准备好，但不能粗暴替换旧调用点：token 计数会影响压缩边界，会话存储会影响用户历史数据，必须先补兼容测试。

## 原生核心策略

Rust 原生核心由 `OTTO_NATIVE_CORE` 控制：

- `auto`：默认模式。有 `otto-native` 二进制就优先使用 Rust；没有就安全回退到 TypeScript。
- `required`：企业/发行模式。找不到 Rust 二进制或 Rust 调用失败时直接报错，禁止悄悄退回旧内核。
- `off`：开发对照模式。禁用 Rust bridge，只走 TypeScript fallback。

如需指定签名后的原生核心二进制：

```bash
OTTO_NATIVE_CORE_BINARY=/path/to/otto-native
```

企业发行版应该使用：

```bash
OTTO_NATIVE_CORE=required
```

这样可以保证发行包实际运行的是被锁定的 native hot-path core，而不是“看起来有 Rust、实际又回到旧 JS”的混合状态。

## 内存保护策略

Otto 的目标不是无限堆功能，而是在普通设备上稳定运行多个 agent。因此默认策略偏保守：

- 根据设备内存和 CPU 自动选择 `low / standard / high` 资源 profile。
- 限制 Task 子 agent 并发数，避免多个模型循环同时撑爆内存。
- 子 agent 有最大运行时长，超时会取消并返回已有部分结果。
- 子 agent 历史会按字符预算截断，避免长对话无限膨胀。
- 工具结果、执行日志、pending result 都有上限或清理路径。
- Task 子 agent 会向 native `agent_pool` 上报最终 RSS，用于后续更精确的淘汰和预算控制。

常用环境变量：

```bash
OTTO_AGENT_PROFILE=low
OTTO_TASK_MAX_CONCURRENCY=1
OTTO_SUBAGENT_HISTORY_MAX_CHARS=60000
OTTO_SUBAGENT_TIMEOUT_MS=1200000
```

维护原则：优先让 95% 的设备流畅运行，再给高端机器打开更高并发。不要把高配开发机上的体验当成默认产品预算。

## 易维护组件边界

Otto 的成熟方向是“轻内核 + 独立组件”，而不是把所有功能塞进 core。

| 层级 | 应该放什么 | 不应该做什么 |
| --- | --- | --- |
| Kernel | turn lifecycle、tool execution、policy gate、model routing、资源预算、native bridge | 放组织定制逻辑、GUI 品牌代码、私有连接器 |
| Components | 私有工具包、内网连接器、知识源、审批流、文档运行时 | 修改 kernel 状态机或抢占 kernel-owned path |
| GUI shell | 路由、主题 token、布局、品牌、政府/企业入口 | 把业务策略写死进 core |
| Native core | agent pool、session store、tokenizer 等低层热路径 | 承担产品编排、用户体验、外部集成 |

组件 manifest 使用：

- `packages/core/src/components/componentManifest.ts`
- `docs/enterprise-component-architecture.md`

组件不应声明或修改 kernel-owned 路径，例如：

- `packages/core/src/core/*`
- `packages/core/src/policy/*`
- `packages/core/src/config/config.ts`
- `packages/core/src/tools/tool-registry.ts`

判断一个改动该不该进内核，只问一句：所有 Otto 发行版都会受益吗？如果不是，它大概率应该是组件。

## 发行与 10MB 预算

企业内核发行应该是签名、可校验、source-free 的编译产物。这里的安全表述必须诚实：

- 可以说：防篡改、签名校验、不随包分发源码、提高逆向成本。
- 不要说：无法破解、无法查看、数学上不可逆。

发行 manifest 在这里：

- `packages/core/src/kernel/kernelDistributionManifest.ts`

当前企业发行预算：

- cold start: `<= 1200ms`
- registry ready: `<= 500ms`
- idle RSS: `<= 180MB`
- sub-agent RSS delta: `<= 80MB`
- tool schema chars: `<= 120000`
- release distribution size: `<= 10MB`

`npm run doctor` 会检查发行产物体积。如果当前开发检出没有 `bundle/` 或 `otto-native/bin/`，doctor 会显示“未发现发行产物，但 10MB 预算已生效”。

## 发布前门禁

所有正式发布先读并执行：

- `docs/release-preflight.md`

它是当前唯一的发布前硬门禁，覆盖源码状态、版本一致性、问题回归、安装包 `< 150MB`、企业服务器包 canary、GitHub Release、服务器升级、发布后验证和回滚。

LSTC 版本还必须满足：

- 企业一键包 `manifest.json.releaseChannel` 为 `lstc`。
- 企业包 `schemaTo` 与当前服务 `ENTERPRISE_SCHEMA_VERSION` 一致。
- 服务器 health 的 `apiVersion`、`schemaVersion`、`version` 和 `buildCommit` 与发布包一致。
- 桌面安装包仍受 `< 150MB` 正式发布门禁约束，超出只能作为内部测试资产。

发布规范的优先级：

1. `docs/release-preflight.md`
2. `.github/workflows/README.md`
3. `docs/RELEASE.md`

如果 GitHub Actions 没有真正启动 runner、服务器仍是旧 `apiVersion`、Release 资产不是实际部署包，均视为没有完成发布。

## 构建 Rust 原生核心

```bash
cd otto-native
cargo build --release
```

常见二进制位置：

- `otto-native/bin/otto-native`
- `otto-native/bin/otto-native.exe`
- `otto-native/target/release/otto-native`
- `otto-native/target/release/otto-native.exe`

注意：Windows GNU target 需要可用的 linker，例如 MinGW `gcc.exe`。如果本机没有工具链，Rust 测试会在链接阶段失败。

## 验证仓库

推荐最小验证：

```bash
npm run doctor
npm run test --workspace packages/core -- nativeCoreBridge.test.ts nativeAgentPoolRuntime.test.ts nativeTokenizerRuntime.test.ts nativeSessionStoreRuntime.test.ts
npm run typecheck --workspace packages/core
```

Rust 工具链齐全时再跑：

```bash
cd otto-native
cargo test
```

## 后续维护优先级

1. 给 `tokenizer` 的旧 token fallback 调用点补兼容测试，然后迁移到 `NativeTokenizerRuntime`。
2. 给 `session_store` 补旧会话格式兼容测试，再迁移到 `NativeSessionStoreRuntime`。
3. 保持 `agent_pool` 的 Rust 路径为 Task 子 agent 默认路径，并用 #74 的低资源 benchmark 验证多 agent 内存占用。
4. 清理陈年死代码、乱码文档和生成产物，但不要一次性大扫除到影响行为。
5. 所有新功能先问边界：属于 kernel、native core、component、GUI shell，还是外部连接器？

## 关键入口

- `packages/core/src/native/nativeCoreBridge.ts`
- `packages/core/src/native/nativeHotPaths.ts`
- `packages/core/src/native/nativeAgentPoolRuntime.ts`
- `packages/core/src/native/nativeTokenizerRuntime.ts`
- `packages/core/src/native/nativeSessionStoreRuntime.ts`
- `packages/core/src/kernel/kernelDistributionManifest.ts`
- `packages/core/src/components/componentManifest.ts`
- `docs/enterprise-component-architecture.md`
- `docs/product-ux-contracts.md`
