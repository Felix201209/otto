# Custom Rules Examples (自定义规则示例)

这个目录包含了 Otto 自定义规则的示例文件，您可以将这些示例复制到您的项目中使用。

## 📁 示例文件

| 文件 | 说明 | 适用场景 |
|------|------|---------|
| `typescript-coding-standards.md` | TypeScript 编码规范 | TypeScript 项目 |
| `react-component-guidelines.md` | React 组件开发规范 | React 项目 |

## 🚀 快速开始

### 方法 1: 复制示例文件到项目

1. 在项目根目录创建规则目录：
   ```bash
   mkdir -p .easycode/rules
   ```

2. 复制示例文件：
   ```bash
   # TypeScript 规范
   cp docs/examples/rules/typescript-coding-standards.md .easycode/rules/

   # React 规范
   cp docs/examples/rules/react-component-guidelines.md .easycode/rules/
   ```

3. 根据项目需求编辑规则内容

4. Otto 会自动检测并加载规则

### 方法 2: 使用 VSCode 命令

1. 打开命令面板 (`Ctrl+Shift+P` 或 `Cmd+Shift+P`)
2. 输入并选择 "Otto: Manage Custom Rules"
3. 点击 "New Rule" 创建新规则
4. 参考示例文件填写规则内容

### 方法 3: 创建全局规则文件

在项目根目录创建 `EASYCODE.md` 文件：

```markdown
---
type: always_apply
priority: high
---

# 项目编码规范

## 通用规则

1. 代码必须通过 ESLint 检查
2. 提交前运行测试确保通过
3. 遵循项目的命名约定

## TypeScript 规则

- 使用严格模式 (`strict: true`)
- 避免使用 `any` 类型
- 为公共 API 添加 JSDoc 注释

## Git 提交规范

使用 Conventional Commits 格式：
- `feat:` 新功能
- `fix:` 修复 bug
- `docs:` 文档更新
- `refactor:` 重构代码
```

## 🎯 规则类型说明

### Always Apply (始终应用)

这类规则会自动应用于每次 AI 对话，适合项目的核心规范。

```yaml
type: always_apply
priority: high
```

### Manual Apply (手动应用)

需要手动选择才应用的规则，适合特定场景的规范。

```yaml
type: manual_apply
priority: medium
```

### Context Aware (上下文感知)

根据文件类型、路径或编程语言自动应用的规则，最灵活。

```yaml
type: context_aware
priority: high
triggers:
  fileExtensions:
    - .ts
    - .tsx
  pathPatterns:
    - src/**
  languages:
    - typescript
```

## 📝 自定义规则模板

### 基础模板

```markdown
---
title: 规则标题
type: context_aware
priority: medium
description: 规则描述
enabled: true
tags:
  - tag1
  - tag2
triggers:
  fileExtensions:
    - .ext
  pathPatterns:
    - path/**
---

# 规则标题

## 规则内容

在此处添加规则的详细说明...
```

### 编码风格模板

```markdown
---
title: [语言] 编码风格
type: context_aware
priority: high
triggers:
  languages:
    - [language]
---

# [语言] 编码风格

## 命名约定

- 变量: camelCase
- 函数: camelCase
- 类: PascalCase
- 常量: UPPER_SNAKE_CASE

## 代码格式

- 缩进: [2/4] 空格
- 引号: [单引号/双引号]
- 分号: [必须/可选]

## 最佳实践

1. ...
2. ...
```

### 框架规范模板

```markdown
---
title: [框架] 使用规范
type: context_aware
priority: high
triggers:
  fileExtensions:
    - .ext
  pathPatterns:
    - framework-specific/**
---

# [框架] 使用规范

## 项目结构

描述推荐的目录结构...

## 组件规范

描述组件开发规范...

## 状态管理

描述状态管理最佳实践...
```

## 💡 最佳实践

1. **从简单开始**: 先创建核心规范，逐步添加细节
2. **保持更新**: 随着项目发展更新规则
3. **团队协作**: 与团队成员讨论并达成共识
4. **示例优先**: 提供代码示例比纯文字描述更有效
5. **优先级管理**: 合理设置优先级，避免规则冲突
6. **测试验证**: 创建规则后测试 AI 生成的代码是否符合规范

## 🔧 高级用法

### 组合多个规则

为不同的代码区域创建不同的规则：

```bash
.easycode/rules/
├── general/
│   ├── coding-style.md      # 通用编码风格
│   └── git-commits.md       # Git 提交规范
├── frontend/
│   ├── react-components.md  # React 组件规范
│   └── css-styling.md       # CSS 样式规范
├── backend/
│   ├── api-design.md        # API 设计规范
│   └── database.md          # 数据库规范
└── testing/
    └── test-guidelines.md   # 测试规范
```

### 使用标签组织规则

使用标签方便管理和筛选：

```yaml
tags:
  - coding-style
  - typescript
  - frontend
  - performance
```

### 禁用规则

临时禁用某个规则：

```yaml
enabled: false
```

## 📚 相关文档

- [自定义规则管理完整文档](../../custom-rules-management.md)
- [项目架构说明](../../architecture.md)
- [VSCode 扩展文档](../../extension.md)

## 🤝 贡献

欢迎贡献更多规则示例！请遵循以下格式：

1. 使用清晰的标题和描述
2. 提供具体的代码示例
3. 包含正确和错误的示例对比
4. 添加适当的 YAML frontmatter
5. 使用中英文双语说明（可选）

---

**Happy Coding! 🎉**
