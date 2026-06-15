# 🏗️ /new 命令架构与流程

## 系统架构图

```
┌─────────────────────────────────────────────────────────────────────┐
│                         Otto CLI                              │
└─────────────────────────────────────────────────────────────────────┘
                                 ▲
                                 │ 用户输入
                                 │
┌────────────────────────────────▼───────────────────────────────────┐
│                   SlashCommandProcessor (React Hook)               │
│  - 接收用户输入 "/new"                                             │
│  - 验证斜杠命令格式                                                │
│  - 路由命令到正确的处理器                                          │
└────────────────────────────────▼───────────────────────────────────┘
                                 │
                                 ▼
┌────────────────────────────────────────────────────────────────────┐
│                        CommandService                              │
│  - 查询已注册的命令                                                │
│  - 在多个加载器中查找匹配命令                                      │
│  - 加载顺序：McpPrompt → Builtin → Inline → Extension →           │
│             File → Plugin                                          │
└────────────────────────────────▼───────────────────────────────────┘
                                 │
                                 ▼
┌────────────────────────────────────────────────────────────────────┐
│                 BuiltinCommandLoader                               │
│  ┌──────────────────────────────────────────────────────────────┐ │
│  │ 已注册命令列表：                                             │ │
│  │  • aboutCommand                                              │ │
│  │  • authCommand                                               │ │
│  │  • clearCommand                                              │ │
│  │  • ... (更多命令)                                            │ │
│  │  • newCommand ← 我们的新命令！ 🆕                           │ │
│  │  • sessionCommand                                            │ │
│  │  • ... (更多命令)                                            │ │
│  └──────────────────────────────────────────────────────────────┘ │
└────────────────────────────────▼───────────────────────────────────┘
                                 │
              ┌──────────────────┴──────────────────┐
              │                                     │
              ▼                                     ▼
     ┌─────────────────┐            ┌─────────────────────────┐
     │  /session new   │            │  /new (隐藏)           │
     │  (菜单命令)     │            │  (快捷命令)   ← 推荐    │
     │                 │            │                         │
     │ name: 'new'     │            │ name: 'new'             │
     │ hidden: false   │            │ hidden: true ← 关键     │
     └────────┬────────┘            └──────────┬──────────────┘
              │                                │
              └────────────────┬───────────────┘
                               │
                               ▼
                ┌──────────────────────────────┐
                │  newCommand.action(context)  │
                │                              │
                │  1. 获取 SessionManager      │
                │  2. 创建新会话              │
                │  3. 准备成功消息            │
                │  4. 返回切换会话结果        │
                └──────────────────┬───────────┘
                                   │
                                   ▼
                ┌──────────────────────────────────┐
                │  SwitchSessionActionReturn       │
                │  {                               │
                │    type: 'switch_session',       │
                │    sessionId: '...',             │
                │    history: [...],               │
                │    clientHistory: []             │
                │  }                               │
                └──────────────────┬───────────────┘
                                   │
                                   ▼
                    ┌──────────────────────────┐
                    │  UI 更新                 │
                    │  • 切换到新会话          │
                    │  • 清空历史              │
                    │  • 显示成功消息          │
                    │  • 准备接收新对话        │
                    └──────────────────────────┘
```

## 命令执行流程

### 场景 1：用户输入 `/new`

```
时间轴
────────────────────────────────────────────────────────────

T0: 用户按下 / 并输入 "new"
    └─→ 输入框显示: "/new"

T1: useSlashCommandProcessor 检测到斜杠命令
    └─→ 验证: 这是一个有效的斜杠命令

T2: CommandService 查询命令
    ├─→ 检查 McpPromptLoader（没找到）
    ├─→ 检查 BuiltinCommandLoader ✓ 找到！
    └─→ 获取 newCommand

T3: 执行 newCommand.action()
    ├─→ 初始化 SessionManager
    ├─→ 调用 sessionManager.createNewSession()
    │   ├─→ 生成新的 sessionId
    │   ├─→ 创建会话文件
    │   ├─→ 保存元数据
    │   └─→ 返回 newSession 对象
    ├─→ 构建成功消息
    │   ├─→ Session ID
    │   ├─→ 创建时间
    │   └─→ 提示信息
    └─→ 返回 SwitchSessionActionReturn

T4: UI 组件处理返回值
    ├─→ 识别 type: 'switch_session'
    ├─→ 调用 config.setSessionId(newSessionId)
    ├─→ 清空历史记录 (clearHistory)
    ├─→ 加载新会话历史 (loadHistory with new history)
    └─→ 刷新 UI

T5: 用户看到新会话
    ├─→ 输入框获得焦点
    ├─→ 历史记录显示成功消息
    ├─→ 状态栏显示新的 Session ID
    └─→ 准备接收用户输入
```

### 场景 2：对比 `/new` vs `/session new`

```
─────────────────────────────────────────────────────────

用户输入方式对比：

/new
└─→ 1 次命令执行 ✨
    └─→ 直接触发创建新会话

/session new
└─→ 2 级命令结构
    ├─→ 查找 "session" 命令
    ├─→ 在 subCommands 中查找 "new"
    └─→ 执行创建新会话

结果完全相同，但 /new 更直接！
```

## 代码执行路径

### 文件树

```
packages/cli/src/
│
├── services/
│   └── BuiltinCommandLoader.ts ← 导入 newCommand
│       ├─ import { newCommand } from '../ui/commands/newCommand.js'
│       └─ allDefinitions: [..., newCommand, ...]
│
├── ui/
│   ├── commands/
│   │   ├── newCommand.ts ← 新建命令定义 🆕
│   │   │   └─ export const newCommand: SlashCommand
│   │   │
│   │   ├── sessionCommand.ts ← 原有会话命令
│   │   │   └─ newSessionCommand (子命令)
│   │   │
│   │   ├── types.ts
│   │   │   ├─ SlashCommand 接口定义
│   │   │   ├─ SwitchSessionActionReturn 类型
│   │   │   └─ CommandKind 枚举
│   │   │
│   │   └── slashCommandProcessor.ts
│   │       └─ useSlashCommandProcessor Hook
│   │           ├─ 解析用户输入
│   │           ├─ 路由命令
│   │           └─ 执行命令
│   │
│   └── types.ts
│       └─ CommandContext 接口
│
└── config/
    └─ Command 加载和管理
```

### 关键代码片段

#### 1. 命令定义（newCommand.ts）

```typescript
export const newCommand: SlashCommand = {
  name: 'new',                          // 命令名
  description: t('...'),                // 命令描述
  kind: CommandKind.BUILT_IN,          // 命令来源
  hidden: true,                         // 🔑 隐藏标记
  action: async (context) => {
    // 执行逻辑
    return {
      type: 'switch_session',
      sessionId,
      history,
      clientHistory,
    };
  },
};
```

#### 2. 命令注册（BuiltinCommandLoader.ts）

```typescript
import { newCommand } from '../ui/commands/newCommand.js';

async loadCommands(): Promise<SlashCommand[]> {
  const allDefinitions = [
    // ... 其他命令
    newCommand,  // ← 注册
    // ... 更多命令
  ];
  return allDefinitions.filter(cmd => cmd !== null);
}
```

#### 3. 命令处理（slashCommandProcessor.ts）

```typescript
// 伪代码
async function processSlashCommand(input: string) {
  if (!input.startsWith('/')) return;

  const parts = input.slice(1).split(' ');
  const commandName = parts[0];  // 'new'

  // 查询命令
  const command = commandService.findCommand(commandName);

  if (!command) {
    // 命令未找到
    return;
  }

  // 执行命令
  const result = await command.action(context, args);

  // 处理返回值
  handleCommandResult(result);
}
```

## 状态转换图

```
┌─────────────────┐
│  初始状态       │
│ (用户准备输入)  │
└────────┬────────┘
         │ 用户输入 "/new"
         ▼
┌─────────────────┐
│  验证阶段       │
│ (检查命令有效) │
└────────┬────────┘
         │ ✓ 有效
         ▼
┌─────────────────┐
│  查询阶段       │
│ (在命令库中查找)│
└────────┬────────┘
         │ ✓ 找到 newCommand
         ▼
┌─────────────────┐
│  执行阶段       │
│ (运行 action)   │
└────────┬────────┘
         │ ✓ 成功
         ▼
┌─────────────────┐
│  返回处理       │
│ (处理返回值)    │
└────────┬────────┘
         │ type='switch_session'
         ▼
┌─────────────────┐
│  UI 更新        │
│ (刷新界面)      │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│  新会话状态     │
│ (准备对话)      │
└─────────────────┘
```

## 与其他命令的关系

```
SlashCommand 家族

┌─────────────────────────────────────┐
│    所有内置命令 (BUILT_IN)           │
├─────────────────────────────────────┤
│                                     │
│  ├─ 菜单命令（hidden: false）       │
│  │  ├─ /help        帮助菜单        │
│  │  ├─ /session     会话管理        │
│  │  ├─ /config      配置            │
│  │  └─ ...          更多可见命令    │
│  │                                  │
│  └─ 隐藏命令（hidden: true）        │
│     ├─ /vim         Vim 模式        │
│     ├─ /theme       主题选择        │
│     ├─ /yolo        YOLO 模式       │
│     ├─ /new    ← 我们的新命令 🆕   │
│     └─ ...          更多隐藏命令    │
│                                     │
└─────────────────────────────────────┘
```

## 设计模式

### 快捷命令模式

```typescript
// 模式：创建隐藏快捷命令
export const quickCommand: SlashCommand = {
  name: 'shortname',
  description: '描述',
  kind: CommandKind.BUILT_IN,
  hidden: true,  // ← 隐藏的关键
  action: async (context, args) => {
    // 实现逻辑
    // 可以代理到其他命令
    // 或直接实现
  },
};
```

### 为什么这个模式好用？

✅ 菜单保持整洁
✅ 不会重复显示相似命令
✅ 用户可直接输入快速使用
✅ 易于扩展（添加更多快捷命令）
✅ 符合 Unix 风格（隐藏的辅助命令）

---

**架构清晰，代码简洁，用户体验优秀！** 🎯
