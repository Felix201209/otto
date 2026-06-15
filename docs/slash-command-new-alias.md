## /new 快捷命令实现总结

### 🎯 功能概述

已成功为 Otto CLI 添加了一个新的隐藏快捷命令 `/new`，它直接触发创建新会话的功能，等价于 `/session new` 的操作。

### ✅ 实现细节

#### 1. 新建命令文件
**文件：** `packages/cli/src/ui/commands/newCommand.ts`

```typescript
export const newCommand: SlashCommand = {
  name: 'new',
  description: t('command.session.create.description'),
  kind: CommandKind.BUILT_IN,
  hidden: true,  // ← 关键：隐藏从菜单中，但完全可用
  action: async (context): Promise<SwitchSessionActionReturn> => {
    // 直接创建新会话，与 /session new 逻辑完全相同
  },
};
```

#### 2. 注册到命令加载器
**文件：** `packages/cli/src/services/BuiltinCommandLoader.ts`

- 导入新命令：`import { newCommand } from '../ui/commands/newCommand.js';`
- 在命令列表中添加：`newCommand, // 隐藏快捷命令：/new 直接创建新会话`

### 📋 特性

| 特性 | 说明 |
|------|------|
| 命令名称 | `/new` |
| 隐藏性 | ✅ 隐藏在帮助菜单中 |
| 可访问性 | ✅ 可直接输入使用 |
| 功能 | 直接创建新会话，无需通过菜单 |
| 兼容性 | ✅ 与 `/session new` 100% 等价 |
| 自动补全 | 不支持（因为是直接输入的快捷命令） |

### 🚀 使用方式

```bash
# 之前（还是可用）
/session new

# 之后（新增快捷方式）
/new            # ← 直接快捷创建新会话

# 验证命令是否在菜单中
/help           # 会看到 /session 但不会看到 /new
```

### 🔧 技术架构

```
用户输入: "/new"
    ↓
1. slashCommandProcessor 验证命令
    ↓
2. CommandService 查询已注册的命令
    ↓
3. 匹配到 newCommand（hidden: true）
    ↓
4. 执行 newCommand.action(context)
    ↓
5. 返回 SwitchSessionActionReturn
    ↓
6. UI 切换到新会话
```

### 📝 类型检查与编译

```bash
✅ TypeScript 类型检查：通过
✅ 项目构建：成功
✅ 所有包编译：完成
  • easycode-core
  • easycode-cli
  • easycode-ai-vscode-ui-plugin
```

### 💡 设计决策说明

**为什么使用 `hidden: true`？**
- ✅ 用户可以直接输入 `/new` 使用
- ✅ 不会在帮助菜单中显示，避免混淆（已有 `/session new`）
- ✅ 符合现有隐藏命令的设计模式（如 `/vim`, `/theme`, `/yolo`）
- ✅ 直观易用：`/new` 比 `/session new` 更短

**为什么不用 `altNames`？**
虽然可以为 `newSessionCommand` 添加别名：
```typescript
const newSessionCommand: SlashCommand = {
  name: 'new',
  altNames: ['create'],  // 可以添加别名
  // ...
};
```
但这样做会让 `/session new` 和 `/session create` 都出现在菜单中，显得冗余。

**我们选择了独立隐藏命令的方案，因为：**
- 更加干净：不会污染 `/session` 子命令列表
- 更符合用户期望：快速操作应该简洁
- 易于维护：逻辑清晰，易于理解

### 🎓 文件修改清单

| 文件 | 操作 | 行数 |
|------|------|------|
| `packages/cli/src/ui/commands/newCommand.ts` | ✨ 新建 | 58 |
| `packages/cli/src/services/BuiltinCommandLoader.ts` | ✏️ 修改 | +1 导入, +1 使用 |

### ✨ 后续可能的扩展

如果你想要更多快捷命令别名，可以按照相同模式继承：

```typescript
// 例如：/sel 作为 /session select 的快捷
export const selectSessionShortcutCommand: SlashCommand = {
  name: 'sel',
  description: '快速选择会话',
  kind: CommandKind.BUILT_IN,
  hidden: true,
  action: async (context, args) => {
    // 代理到 selectSessionCommand
  },
};
```

### 🔍 验证方法

```bash
# 1. 编译验证
npm run typecheck  # ✅ 类型检查通过
npm run build      # ✅ 构建成功

# 2. 运行时验证（启动应用后）
/help              # 查看菜单（不会显示 /new）
/new               # 直接执行创建新会话
```

### 📞 需要帮助？

- 确保运行了 `npm run build` 重新编译项目
- 检查没有其他命令与 `/new` 冲突
- 验证国际化文本 `command.session.create.description` 已正确翻译
