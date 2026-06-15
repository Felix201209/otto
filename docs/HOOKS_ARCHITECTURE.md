# Otto Hooks 架构设计说明

> 本文档详细说明 Hooks 系统如何在 `packages/core` 中实现，以及它如何被所有客户端自动继承的架构设计。

## 🏗️ 核心架构

```
┌─────────────────────────────────────────────┐
│     packages/core (核心功能库)               │
│                                              │
│  ┌──────────────────────────────────────┐  │
│  │  AI Client & Model Interaction       │  │
│  └──────────────────────────────────────┘  │
│                                              │
│  ┌──────────────────────────────────────┐  │
│  │  Tool System & Execution Engine      │  │
│  └──────────────────────────────────────┘  │
│                                              │
│  ┌──────────────────────────────────────┐  │
│  │  MCP Engine (Context Management)     │  │
│  └──────────────────────────────────────┘  │
│                                              │
│  ┌──────────────────────────────────────┐  │
│  │  🎯 Hooks System (NEW)              │  │
│  │  ├─ HookRegistry                     │  │
│  │  ├─ HookPlanner                      │  │
│  │  ├─ HookRunner                       │  │
│  │  ├─ HookAggregator                   │  │
│  │  ├─ HookEventHandler (11 events)     │  │
│  │  └─ HookSystem (Coordinator)         │  │
│  └──────────────────────────────────────┘  │
│                                              │
└─────────────────────────────────────────────┘
        ↑                      ↑
        │ 依赖               │ 依赖
        │                      │
    ┌─────────┐          ┌──────────────────┐
    │ CLI     │          │ VSCode UI Plugin │
    │ Package │          │ Package          │
    └─────────┘          └──────────────────┘
        ↑                      ↑
        │ 自动享受            │ 自动享受
        │ Hooks 能力          │ Hooks 能力
        │                      │
        └──────┬──────────────┘
               │
           最终用户
```

## 📦 项目结构

```
Otto/
├── packages/
│   ├── core/
│   │   ├── src/
│   │   │   ├── hooks/                    ← Hooks 系统核心
│   │   │   │   ├── types.ts              (类型定义)
│   │   │   │   ├── hookRegistry.ts       (配置加载)
│   │   │   │   ├── hookPlanner.ts        (执行计划)
│   │   │   │   ├── hookRunner.ts         (脚本执行)
│   │   │   │   ├── hookAggregator.ts     (结果聚合)
│   │   │   │   ├── hookEventHandler.ts   (事件处理)
│   │   │   │   ├── hookSystem.ts         (协调器)
│   │   │   │   └── index.ts              (导出)
│   │   │   │
│   │   │   ├── config/
│   │   │   │   └── config.ts             ← 更新：支持 hooks getter
│   │   │   │
│   │   │   ├── utils/
│   │   │   │   └── debugLogger.ts        (日志工具)
│   │   │   │
│   │   │   ├── tools/                    (其他系统...)
│   │   │   ├── core/
│   │   │   └── ...
│   │   │
│   │   └── package.json
│   │
│   ├── cli/
│   │   ├── src/
│   │   │   ├── ...
│   │   │   └── services/
│   │   │
│   │   ├── package.json
│   │   │   └── dependencies: {
│   │   │       "easycode-core": "file:../core"  ← 依赖 core
│   │   │     }
│   │   └── dist/
│   │
│   └── vscode-ui-plugin/
│       ├── src/
│       │   ├── extension.ts               (导入 easycode-core)
│       │   ├── services/
│       │   │   ├── authManager.ts         (导入 core)
│       │   │   ├── aiService.ts           (导入 core)
│       │   │   └── ...
│       │   └── ...
│       │
│       ├── package.json
│       │   └── dependencies: {
│       │       没有显式的 easycode-core  ← 但通过 import 使用 core
│       │     }
│       └── dist/
│
└── docs/
    ├── hooks-user-guide.md               ← 用户指南
    ├── hooks-examples.md                 ← 示例库
    └── hooks-implementation.md           ← 实现细节
```

## 🔄 依赖流向

```
最终用户
  ↓
┌─────────────────────┬──────────────────────┐
│   CLI 命令行        │  VSCode UI 插件       │
├─────────────────────┼──────────────────────┤
│ 依赖 core           │  使用 core (import)  │
├─────────────────────┼──────────────────────┤
│ import {            │  import {            │
│   HookSystem,       │    HookSystem,       │
│   HookEventHandler, │    HookEventHandler, │
│   ...               │    ...               │
│ } from core         │  } from core         │
└─────────────────────┴──────────────────────┘
           ↓                    ↓
      ┌────────────────────────────┐
      │  packages/core/src/hooks/  │
      │  ├─ types.ts               │
      │  ├─ hookRegistry.ts        │
      │  ├─ hookPlanner.ts         │
      │  ├─ hookRunner.ts          │
      │  ├─ hookAggregator.ts      │
      │  ├─ hookEventHandler.ts    │
      │  ├─ hookSystem.ts          │
      │  └─ index.ts               │
      └────────────────────────────┘
           ↓
      11 个关键事件
      被触发和执行
           ↓
      用户的 Hook 脚本
      被执行和聚合
           ↓
      安全控制、审计、定制
      等功能生效
```

## ✨ 架构优势

### 1. 代码重用 - 零重复

```
不使用这个架构的情况：
┌─────────┐  ┌──────────────┐
│ CLI     │  │ VSCode UI    │
└────┬────┘  └────┬─────────┘
     │            │
     └─┬──────────┘
       │
    Hook 代码需要
    在两个地方实现
    导致重复代码

使用这个架构：
┌─────────┐  ┌──────────────┐
│ CLI     │  │ VSCode UI    │
└────┬────┘  └────┬─────────┘
     │            │
     └──────┬─────┘
            │
        packages/core
        Hook 代码
        只实现一次
        ✅ DRY 原则
```

### 2. 统一安全策略

```
一份 .easycode/settings.json 配置：

{
  "hooks": {
    "BeforeTool": [{
      "command": "bash ./hooks/security-gate.sh"
    }]
  }
}

↓ 对所有客户端生效 ↓

┌─────────────┐      ┌──────────────────┐
│ CLI 用户    │      │ VSCode UI 用户   │
├─────────────┤      ├──────────────────┤
│ 检查约束    │      │ 检查约束         │
│ 执行 Hooks  │      │ 执行 Hooks       │
│ 享受保护    │      │ 享受保护         │
└─────────────┘      └──────────────────┘

所有用户都受相同的安全约束！
```

### 3. 一致的用户体验

```
无论用户选择哪个客户端：
- 相同的 Hooks 配置格式
- 相同的事件模型（11 个事件）
- 相同的输入/输出格式
- 相同的安全策略

用户体验：
CLI: easycode → 享受 Hooks ✅
VSCode: VSCode 插件 → 享受 Hooks ✅
```

### 4. 维护成本低

```
新增 Hook 功能时：

修改范围：packages/core/src/hooks/

影响范围：
✅ CLI 自动获得
✅ VSCode UI 自动获得
✅ 无需修改两处代码

维护负担：只有 core
```

### 5. 扩展性强

```
将来可能的新客户端：

packages/other-client/
  ├── 依赖 core
  └── 自动享受 Hooks!

不需要重新实现 Hooks，
新客户端开箱即用！
```

## 🔧 实现细节

### Hooks 在 Core 中的位置

```
packages/core/
├── src/
│   ├── hooks/                  ← 5 层架构，2,800+ 行代码
│   │   ├── types.ts            (类型定义)
│   │   ├── hookRegistry.ts      (加载验证配置)
│   │   ├── hookPlanner.ts       (匹配和规划)
│   │   ├── hookRunner.ts        (执行脚本)
│   │   ├── hookAggregator.ts    (结果聚合)
│   │   ├── hookEventHandler.ts  (11 个事件)
│   │   ├── hookSystem.ts        (系统协调)
│   │   └── index.ts             (导出所有公共 API)
│   │
│   ├── config/config.ts         (Config 类更新)
│   │   └── 新增：
│   │       - getHooks(): HooksConfig
│   │       - getExtensions(): ExtensionsConfig
│   │
│   └── utils/debugLogger.ts     (日志工具)
```

### Core 的导出

```typescript
// packages/core/src/hooks/index.ts

// 导出所有类型
export * from './types.js';

// 导出核心组件（5 层）
export { HookSystem } from './hookSystem.js';
export { HookRegistry } from './hookRegistry.js';
export { HookRunner } from './hookRunner.js';
export { HookAggregator } from './hookAggregator.js';
export { HookPlanner } from './hookPlanner.js';
export { HookEventHandler } from './hookEventHandler.js';
```

### CLI 如何使用

```typescript
// packages/cli/src/services/hookService.ts (假设位置)

import {
  HookSystem,
  HookEventHandler,
  type HooksConfig
} from 'easycode-core';

// 初始化 Hooks 系统
const hookSystem = new HookSystem(config);

// 使用 Hooks
await hookSystem.fireEvent('BeforeTool', toolInput);
```

### VSCode UI 插件如何使用

```typescript
// packages/vscode-ui-plugin/src/services/aiService.ts

import {
  HookSystem,
  HookEventHandler,
  type HooksConfig
} from 'easycode-core';

// 同样初始化和使用
const hookSystem = new HookSystem(config);
await hookSystem.fireEvent('BeforeAgent', agentInput);
```

## 📊 共享能力总结

| 能力 | 实现位置 | CLI | VSCode UI | 说明 |
|-----|--------|------|-----------|------|
| **HookSystem** | core | ✅ | ✅ | 系统协调器 |
| **HookRegistry** | core | ✅ | ✅ | 配置管理 |
| **HookRunner** | core | ✅ | ✅ | 脚本执行 |
| **11 个事件** | core | ✅ | ✅ | 事件模型 |
| **JSON 格式** | core | ✅ | ✅ | 输入输出 |
| **超时管理** | core | ✅ | ✅ | 子进程保护 |
| **错误处理** | core | ✅ | ✅ | 容错机制 |
| **审计日志** | 用户脚本 | ✅ | ✅ | 可选功能 |
| **权限控制** | 用户脚本 | ✅ | ✅ | 可选功能 |

**所有能力都在 core 实现，所以 CLI 和 VSCode UI 都能享受！**

## 🎯 配置统一性

```
使用场景：某公司同时使用 CLI 和 VSCode UI 插件

配置管理：
~/.easycode-user/settings.json (全局配置)
  ├── Hooks 配置
  ├── MCP 配置
  ├── 命令配置
  └── ...

.easycode/settings.json (项目配置)
  ├── Hooks 配置 ← 同一个！
  ├── MCP 配置
  ├── 命令配置
  └── ...

结果：
✅ CLI 读取这些配置，享受 Hooks 保护
✅ VSCode UI 读取同样的配置，享受 Hooks 保护
✅ 企业安全策略统一生效
✅ 无需维护多份配置
```

## 🔐 安全架构

```
企业安全管理员
  │
  └─→ 创建 Hooks 脚本和配置
      │
      ├─→ .easycode/hooks/security-gate.sh
      ├─→ .easycode/hooks/audit-logger.sh
      ├─→ .easycode/hooks/rbac.sh
      └─→ .easycode/settings.json
          │
          ├─→ 上传到项目 Git 仓库
          │
          ├─ 所有开发者 Pull 最新代码
          │
          └──────┬─────────────────┐
                 │                 │
         通过 CLI 工作     通过 VSCode UI 工作
                 │                 │
         core 加载 Hooks    core 加载 Hooks
                 │                 │
         自动享受保护        自动享受保护
                 │                 │
         ✅ 统一安全策略      ✅ 统一安全策略
```

## 💡 最佳实践

### DO：利用 Core 的共享特性

```typescript
// 好：在 core 中实现一次，两个客户端自动享受
packages/core/src/hooks/myCustomHook.ts
  ↓
  ├── CLI 自动使用
  └── VSCode UI 自动使用
```

### DON'T：重复实现

```typescript
// 不好：在两个地方都实现
packages/cli/src/hooks/... (❌ 避免)
packages/vscode-ui-plugin/src/hooks/... (❌ 避免)
```

### 配置文件位置

```
✅ 推荐：单一配置文件
.easycode/settings.json
  └─ 同时被 CLI 和 VSCode UI 加载

❌ 避免：多份配置
.easycode/cli-settings.json
.easycode/vscode-settings.json
  └─ 维护成本高，容易不一致
```

## 📈 扩展路径

如果将来需要添加新客户端：

```
packages/new-client/
  ├── package.json
  │   └── dependencies: {
  │       "easycode-core": "file:../core" ← 依赖 core
  │     }
  │
  ├── src/
  │   ├── main.ts
  │   └── services/
  │       └── hookService.ts
  │           └── import from 'easycode-core'
  │
  └── dist/

新客户端自动享受：
✅ Hooks 系统
✅ 所有 11 个事件
✅ 完整的安全和定制能力
✅ 统一配置管理

无需重新实现任何 Hooks 代码！
```

## 🎓 理解关键点

### 关键点 1：Core 是共享库

```
packages/core 不是可执行程序，而是一个 Node.js 库。
它被 CLI 和 VSCode UI 作为依赖导入使用。
```

### 关键点 2：Hooks 在 Core 中实现

```
Hooks 系统（HookSystem、HookRegistry、HookRunner 等）
在 packages/core 中实现。
这确保了所有使用 core 的客户端都能使用 Hooks。
```

### 关键点 3：一份配置，多个客户端

```
.easycode/settings.json 中的 Hooks 配置
被 CLI 加载时：享受 Hooks 保护
被 VSCode UI 加载时：也享受 Hooks 保护
```

### 关键点 4：无需额外工作

```
CLI 开发者：只需在 CLI 中导入和使用 core 的 Hooks
VSCode UI 开发者：只需在插件中导入和使用 core 的 Hooks
新增客户端：同样只需导入和使用，无需重新实现
```

## 📞 如何在客户端中集成 Hooks

### 在 CLI 中（假设位置）

```typescript
// packages/cli/src/core/agent.ts

import { HookEventHandler } from 'easycode-core';

export class Agent {
  private hookHandler: HookEventHandler;

  async executeTool(toolName: string, input: any) {
    // 触发 BeforeTool 事件
    const beforeResult = await this.hookHandler.fireBeforeTool({
      tool_name: toolName,
      tool_input: input,
      // ... 其他字段
    });

    if (beforeResult.decision === 'deny') {
      throw new Error(`Tool blocked: ${beforeResult.reason}`);
    }

    // 执行工具
    const result = await tool.execute(input);

    // 触发 AfterTool 事件
    await this.hookHandler.fireAfterTool({
      tool_name: toolName,
      tool_output: result,
      // ... 其他字段
    });

    return result;
  }
}
```

### 在 VSCode UI 中

```typescript
// packages/vscode-ui-plugin/src/services/aiService.ts

import { HookEventHandler } from 'easycode-core';

export class AIService {
  private hookHandler: HookEventHandler;

  async sendPrompt(prompt: string) {
    // 触发 BeforeAgent 事件
    await this.hookHandler.fireBeforeAgent({
      prompt,
      // ... 其他字段
    });

    // 发送提示给 LLM
    const response = await this.geminiClient.generateContent(prompt);

    // 触发 AfterAgent 事件
    await this.hookHandler.fireAfterAgent({
      response,
      // ... 其他字段
    });

    return response;
  }
}
```

---

## 总结

| 方面 | 描述 |
|-----|------|
| **实现位置** | `packages/core/src/hooks/` (2,800+ 行) |
| **共享方式** | Core 是库，被 CLI 和 VSCode UI 作为依赖导入 |
| **配置位置** | `.easycode/settings.json` (单一配置) |
| **享受客户端** | CLI ✅、VSCode UI ✅、未来的新客户端 ✅ |
| **代码重用** | 100% - Hooks 代码只实现一次 |
| **维护成本** | 最低 - 改一处影响所有客户端 |
| **扩展性** | 最高 - 新客户端开箱即用 |

**设计理念：一份代码，多个客户端，统一体验！**

---

**版本**：1.0
**创建日期**：2025-01-15
**重点**：理解为什么 Hooks 在 core，以及它如何被所有客户端自动继承
