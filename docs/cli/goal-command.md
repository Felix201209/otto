# /goal — 目标驱动模式

让 AI 自主、持续地朝一个目标推进，直到任务**客观完成**或达到最低工作时长。

## 设计动机

普通对话模式下，模型容易因"上下文焦虑"或"差不多就好"在任务还没真正完成前提前收尾。`/goal` 给模型注入一份强约束 prompt + 自动开启 YOLO，并要求它通过 `local_time` 工具持续自检"已工作了多久"，从而**在充足时间预算内持续动脑筋、自我对抗、不停摆**。

## 入口

| 端 | 触发方式 |
|---|---|
| **CLI** | 在交互模式输入 `/goal` |
| **VSCode UI 插件** | ① 聊天工具栏的 🎯 按钮 ② 命令面板：`Otto: Goal-Driven Mode` |

## 6 步交互

| 步骤 | 字段 | 必填 | 说明 |
|---|---|---|---|
| 1 | 任务描述 | ✅ | 让 AI 自主完成的目标，多行 |
| 2 | 禁止事项 | — | AI 不可触碰的红线，多行 |
| 3 | 达标特征 | ✅ | "算作完成"的客观判据 |
| 4 | 持续小时 | ✅ | 0.5–24，默认 2 |
| 5 | 强度档位 | ✅ | 平稳 / 标准 / 高强度 |
| 6 | Prompt 预览 | — | 检查后启动 |

CLI 端多行字段使用"按 Enter 提交一行，空行结束本步"的收集模式（兼容单行 `SimpleTextInput`）。VSCode 端使用标准 `<textarea>`。

## 强度档位 — 行为差异

| 档位 | 工作纪律（注入 prompt） |
|---|---|
| **平稳** | 每完成 1 项 todo 就调用一次 `local_time` 自检 elapsed；允许等待较长的工具调用结果。 |
| **标准（默认）** | 每完成 3 项或里程碑自检；汇报已用时间，必要时重新规划。 |
| **高强度** | 禁止"等待用户"措辞；遇阻立即换路线、绝不停摆；每个里程碑都要大声汇报 elapsed。 |

## 自动行为

启动 `/goal` 时会**自动开启 YOLO 模式**（如果未开），让模型可以连续调用工具不被打断。会有一条 INFO 行明确告知用户。退出后用 `/yolo` 切回。

## 拼装出的 Prompt（节选）

```
你现在开启【目标驱动模式】(/goal)。本模式具有以下不可违反的契约：

# 契约
1. 你无需向用户提任何问题，完全自主决策与执行。
2. YOLO 模式已自动开启 ...
3. 你的运行时足够稳定、上下文足够大，禁止"上下文焦虑"...
4. 你必须先用 todo_write 制定一份详尽的任务清单 ...
5. 持续工作时间硬性下限：{HOURS} 小时 ...
6. 你必须随时调用 local_time 工具核对当前时间 ...

# 任务描述
{TASK}

# 禁止事项
{FORBIDDEN}

# 达标特征
{CRITERIA}

# 工作纪律
{INTENSITY_DISCIPLINE}

# 立即启动（按顺序执行）
1. 调用一次 local_time，记作"起始时间 T0"...
2. 调用 todo_write，写出第一版任务清单。
3. 进入执行循环；每完成一项就调用 local_time 自检 elapsed。
4. 只有当 (a) 全部"达标特征"客观满足 且 (b) elapsed >= {HOURS} 小时同时为真时，才允许收尾。

现在开始。
```

## 配套工具：`local_time`

新增内置工具，让模型查询当前时间并算时间差：

| 字段 | 类型 | 说明 |
|---|---|---|
| `iso` | string | ISO 8601 UTC 时间戳 |
| `unix_ms` | number | 毫秒级 epoch |
| `unix_s` | number | 秒级 epoch |
| `timezone` | string | 使用的 IANA 时区 |
| `local` | string | 人类可读 "YYYY-MM-DD HH:MM:SS" |
| `weekday` | string | 英文星期名 |

可选参数 `timezone` 接受 IANA 时区名（如 `Asia/Shanghai`）。

工具实现：`packages/core/src/tools/local-time.ts`，CLI 与 VSCode 插件**自动共享**（都通过 `easycode-core` 包引用）。

## 文件清单

### 新增
- `packages/core/src/tools/local-time.ts`
- `packages/cli/src/ui/commands/goalCommand.ts`
- `packages/cli/src/ui/components/GoalWizard.tsx`
- `packages/cli/src/ui/hooks/useGoalWizard.ts`
- `packages/vscode-ui-plugin/webview/src/components/GoalWizardDialog.tsx`
- `packages/vscode-ui-plugin/webview/src/components/GoalWizardDialog.css`

### 修改
- `packages/core/src/config/config.ts` — 注册 `LocalTimeTool`
- `packages/core/src/index.ts` — 导出 `LocalTimeTool`
- `packages/cli/src/ui/commands/types.ts` — `OpenDialogActionReturn.dialog` 增加 `'goal-wizard'`
- `packages/cli/src/services/BuiltinCommandLoader.ts` — 注册 `goalCommand`
- `packages/cli/src/ui/hooks/slashCommandProcessor.ts` — 增加 `openGoalWizard?` 参数 + dialog case
- `packages/cli/src/ui/App.tsx` — 实例化 `useGoalWizard` + 渲染分支 + `isModalOpen`
- `packages/vscode-ui-plugin/package.json` — 增加 `easycode.openGoalWizard` 命令贡献
- `packages/vscode-ui-plugin/src/extension.ts` — 注册命令 + 发送 `open_goal_wizard` 消息
- `packages/vscode-ui-plugin/src/types/messages.ts` — 增加 `open_goal_wizard` 消息类型
- `packages/vscode-ui-plugin/webview/src/services/multiSessionMessageService.ts` — 增加 `onOpenGoalWizard` 监听器
- `packages/vscode-ui-plugin/webview/src/components/MultiSessionApp.tsx` — 增加按钮 + 状态 + Dialog 挂载 + 监听 IPC

## Prompt 一致性

CLI 与 VSCode 端的 `buildGoalPrompt()` 是**完全镜像**的两份独立实现（一份在 `GoalWizard.tsx`，一份在 `GoalWizardDialog.tsx`）。任何修改都必须**两边同步**，否则两端体验会漂移。

> 未来优化：把 prompt 模板拎出去放到 `packages/core/src/utils/goalPrompt.ts`，两端共用。当前为简单起见保持镜像。
