# Custom Rules Management (自定义规则管理)

## 📋 Overview (概述)

Otto 支持自定义规则管理，允许您为项目定义特定的编码约定、风格指南和最佳实践。这些规则会自动注入到 AI 助手的上下文中，确保生成的代码符合您的项目标准。

### 快速了解：哪些文件会被加载为规则？

| 文件/目录 | 是否自动加载 | 用途 |
|---------|-------------|------|
| `EASYCODE.md` | ✅ 是 | 主配置文件、全局规则 |
| `AGENTS.md` | ✅ 是 | AI 代理配置、编码规范 |
| `.easycode/rules/*.md` | ✅ 是 | 特定场景的规则文件 |

## 🎯 Features (功能特性)

### 1. 规则类型 (Rule Types)

- **Always Apply (始终应用)**: 规则会自动应用于每次 AI 对话
- **Manual Apply (手动应用)**: 需要手动选择才应用的规则
- **Context Aware (上下文感知)**: 根据文件类型、路径或编程语言自动应用

### 2. 优先级 (Priority)

- **High (高)**: 最重要的规则，优先级最高
- **Medium (中)**: 普通规则
- **Low (低)**: 可选规则

### 3. 触发条件 (Triggers) - 仅用于 Context Aware 类型

- **文件扩展名**: 如 `.ts`, `.tsx`, `.py`
- **路径模式**: 使用 glob 模式，如 `src/components/**`, `tests/**`
- **编程语言**: 如 `typescript`, `python`, `javascript`

## 📁 File Structure (文件结构)

### 规则文件位置

规则可以存储在以下位置：

```
project-root/
├── EASYCODE.md              # 主配置文件（全局规则）
├── AGENTS.md             # AI 代理配置文件
└── .easycode/
    └── rules/            # 规则目录
        ├── typescript.md
        ├── react.md
        └── testing.md
```

**重要说明**:
- ✅ **自动加载**: `EASYCODE.md`、`AGENTS.md` 和 `.easycode/rules/` 目录中的所有 `.md` 文件
- 💡 **用途建议**:
  - `EASYCODE.md` → 项目级全局规则
  - `AGENTS.md` → AI 代理特定配置
  - `.easycode/rules/*.md` → 特定场景规则

### 文件格式

规则文件使用 Markdown + YAML Frontmatter 格式：

```markdown
---
title: TypeScript 编码规范
type: context_aware
priority: high
description: TypeScript 项目的编码标准和最佳实践
enabled: true
tags:
  - typescript
  - coding-style
triggers:
  fileExtensions:
    - .ts
    - .tsx
  pathPatterns:
    - src/**
  languages:
    - typescript
---

# TypeScript 编码规范

## 代码风格

- 使用 2 空格缩进
- 函数名使用驼峰命名法
- 接口名以 `I` 开头（可选）

## 类型注解

- 总是为函数参数添加类型注解
- 优先使用接口而非类型别名
- 避免使用 `any` 类型

## 最佳实践

- 优先使用函数式编程
- 使用 `const` 和 `let`，避免 `var`
- 使用箭头函数代替普通函数（除非需要 `this` 绑定）
```

## 🚀 使用方法 (Usage)

### 方法 1: 通过 VSCode 命令面板

1. 按 `Ctrl+Shift+P` (Windows/Linux) 或 `Cmd+Shift+P` (macOS)
2. 输入 "Otto: Manage Custom Rules"
3. 在打开的对话框中管理规则

### 方法 2: 直接编辑文件

1. 在项目根目录创建 `.easycode/rules/` 目录
2. 创建 Markdown 文件（如 `typescript.md`）
3. 添加 YAML frontmatter 和规则内容
4. 保存文件，规则会自动重新加载

### 方法 3: 使用 EASYCODE.md

在项目根目录创建 `EASYCODE.md` 文件：

```markdown
---
type: always_apply
priority: high
---

# 项目全局规则

这是一个 React + TypeScript 项目，请遵循以下规则：

1. 使用函数组件和 Hooks
2. 组件文件使用 PascalCase 命名
3. 工具函数使用 camelCase 命名
```

## 💡 Examples (示例)

### 示例 1: React 组件规范

```markdown
---
title: React 组件规范
type: context_aware
priority: high
triggers:
  fileExtensions:
    - .tsx
  pathPatterns:
    - src/components/**
---

# React 组件规范

## 组件结构

```typescript
// ✅ 推荐
export const MyComponent: React.FC<Props> = ({ prop1, prop2 }) => {
  // Hooks
  const [state, setState] = useState();

  // 副作用
  useEffect(() => {}, []);

  // 渲染
  return <div>...</div>;
};
```

## Props 定义

- 使用 TypeScript 接口定义 Props
- Props 接口命名为 `{ComponentName}Props`
```

### 示例 2: API 调用规范

```markdown
---
title: API 调用规范
type: context_aware
priority: medium
triggers:
  pathPatterns:
    - src/api/**
    - src/services/**
---

# API 调用规范

## 错误处理

所有 API 调用必须包含错误处理：

```typescript
try {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`HTTP error! status: ${response.status}`);
  }
  return await response.json();
} catch (error) {
  console.error('API call failed:', error);
  throw error;
}
```

## 重试机制

对于关键 API，实现重试逻辑。
```

### 示例 3: 测试规范

```markdown
---
title: 测试规范
type: context_aware
priority: high
triggers:
  fileExtensions:
    - .test.ts
    - .test.tsx
    - .spec.ts
  pathPatterns:
    - tests/**
    - **/__tests__/**
---

# 测试规范

## 测试结构

使用 AAA 模式（Arrange-Act-Assert）：

```typescript
describe('MyComponent', () => {
  it('should render correctly', () => {
    // Arrange
    const props = { ... };

    // Act
    const { getByText } = render(<MyComponent {...props} />);

    // Assert
    expect(getByText('...')).toBeInTheDocument();
  });
});
```
```

## ⚙️ Configuration (配置)

### YAML Frontmatter 字段

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `title` | string | 否 | 规则标题 |
| `type` | enum | 是 | 规则类型：`always_apply`、`manual_apply`、`context_aware` |
| `priority` | enum | 否 | 优先级：`high`、`medium`、`low` (默认: `medium`) |
| `description` | string | 否 | 规则描述 |
| `enabled` | boolean | 否 | 是否启用 (默认: `true`) |
| `tags` | string[] | 否 | 标签列表 |
| `triggers` | object | 否 | 触发条件（仅 `context_aware` 类型） |

### Triggers 对象

```yaml
triggers:
  fileExtensions:
    - .ts
    - .tsx
  pathPatterns:
    - src/**
    - tests/**
  languages:
    - typescript
    - javascript
```

## 🔧 API Reference

### RuleService

```typescript
class RuleService {
  // 初始化服务
  async initialize(workspaceRoot?: string): Promise<void>;

  // 加载所有规则
  async loadAllRules(): Promise<RuleLoadResult>;

  // 获取适用的规则
  async getApplicableRules(context: RuleMatchContext): Promise<RuleApplyResult>;

  // 保存规则
  async saveRule(rule: CustomRule): Promise<void>;

  // 删除规则
  async deleteRule(id: string): Promise<void>;

  // 获取所有规则
  getAllRules(): CustomRule[];
}
```

## 🎨 UI Components

规则管理对话框提供以下功能：

- ✏️ 创建新规则
- 📝 编辑现有规则
- 🗑️ 删除规则
- 👁️ 预览规则内容
- 🔍 按类型、优先级筛选
- 🏷️ 标签管理

## 📚 Best Practices (最佳实践)

1. **使用描述性标题**: 让规则易于识别
2. **合理设置优先级**: 确保重要规则优先应用
3. **避免规则冲突**: 检查规则之间是否有矛盾
4. **定期审查规则**: 确保规则与项目保持同步
5. **使用标签组织**: 方便管理和筛选规则
6. **文档化原因**: 在规则中说明为什么这样做

## 🔍 Troubleshooting (故障排除)

### 规则未应用

1. 检查规则是否启用 (`enabled: true`)
2. 检查规则类型是否正确
3. 对于 `context_aware` 规则，检查触发条件是否匹配
4. 查看 Otto 日志 (`Ctrl+Shift+P` -> "Otto: Open Log File")

### 规则冲突

1. 检查规则优先级设置
2. 审查规则内容是否有矛盾
3. 考虑禁用或删除冲突的规则

### 文件监听失败

1. 检查文件系统权限
2. 确认 `.easycode/rules/` 目录存在
3. 重新加载 VSCode 窗口

## 📖 Related Documentation

- [Architecture](./architecture.md)
- [VSCode Extension](./extension.md)
- [Tools API](./core/tools-api.md)

## 🤝 Contributing

欢迎贡献规则模板和示例！请参考项目的贡献指南。

---

**版权所有 © 2025 Otto**
根据 Apache-2.0 许可证授权
