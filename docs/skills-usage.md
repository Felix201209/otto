# Otto Skills System User Guide / Otto Skills System 使用指南

[English Version](#english-version) | [中文版](#chinese-version)

<a id="english-version"></a>
## 🇬🇧 English Version

This document details the architecture and usage of the Skills system in Otto.

### 1. System Architecture Overview

The Skills system adopts a three-layer architecture designed to modularly extend AI capabilities:

1.  **Marketplace**: The top-level container, typically a Git repository or a local directory, containing multiple Plugins.
2.  **Plugin**: A logical grouping that contains a set of related Skills, Commands, or Agents.
3.  **Item**: The smallest functional unit, categorized into three types:
    *   **Skill**: A complex capability defined by `SKILL.md`, which can include executable scripts.
    *   **Command**: An instruction defined by a single Markdown file, usually for specific tasks.
    *   **Agent**: A Markdown file defining a specific persona or role to guide the AI's behavioral patterns.

### 2. CLI Command Usage

The Otto CLI introduces the `/skill` command family to manage the entire lifecycle.

#### 2.1 Marketplace Management

Manage skill sources (Marketplaces).

*   **List Marketplaces**:
    ```bash
    /skill marketplace list
    ```
*   **Add Marketplace**:
    Supports Git URLs or local paths.
    ```bash
    /skill marketplace add <git-url-or-local-path> [--name <custom-name>]
    # Example
    /skill marketplace add https://github.com/anthropics/skills.git
    ```
*   **Update Marketplace**:
    Pull the latest changes from Git.
    ```bash
    /skill marketplace update <marketplace-name>
    ```
*   **Browse Marketplace Content**:
    View available plugins in a marketplace. Supports searching by plugin name, description, or keywords.
    ```bash
    /skill marketplace browse <marketplace-name> [search-query]
    ```
*   **Remove Marketplace**:
    ```bash
    /skill marketplace remove <marketplace-name> [--delete-files]
    ```

#### 2.2 Plugin Management

Manage the installation, enabling, and disabling of specific plugins.

*   **List Plugins**:
    Lists installed plugins if no argument is provided; lists available plugins in a specific marketplace if a name is provided.
    ```bash
    /skill plugin list [marketplace-name]
    ```
*   **Install Plugin**:
    ```bash
    /skill plugin install <marketplace-name> <plugin-name>
    ```
*   **Uninstall Plugin**:
    ```bash
    /skill plugin uninstall <plugin-id>
    ```
*   **Enable/Disable Plugin**:
    ```bash
    /skill plugin enable <plugin-id>
    /skill plugin disable <plugin-id>
    ```
*   **View Plugin Info**:
    ```bash
    /skill plugin info <plugin-id>
    ```

#### 2.3 Skill Viewing

View specific loaded skills.

*   **List All Skills**:
    ```bash
    /skill list
    ```
*   **View Skill Details**:
    ```bash
    /skill info <skill-id>
    ```
*   **View Statistics**:
    ```bash
    /skill stats
    ```

### 3. Developing Custom Skills

To create a new Skill, you need to follow a specific directory structure and file format.

#### 3.1 Directory Structure

A standard Skill directory structure is as follows:

```text
my-plugin/
├── plugin.json           # Plugin metadata (Optional, required in Strict mode)
├── commands/             # Command type files
│   └── my-command.md
├── agents/               # Agent type files
│   └── my-agent.md
└── skills/               # Skill type directories
    └── my-skill/
        ├── SKILL.md      # Core definition file (Required)
        ├── scripts/      # Executable scripts directory (Optional)
        │   ├── script.py
        │   └── tool.js
        ├── LICENSE.txt   # License (Optional)
        └── README.md     # Supplementary documentation (Optional)
```

#### 3.2 Definition File Format

**SKILL.md (Skill Type)**

The `SKILL.md` file consists of YAML Frontmatter and a Markdown body.

```markdown
---
name: my-skill-name           # Skill name (lowercase, numbers, hyphens)
description: Short desc       # Used for AI retrieval
license: MIT                  # License
allowedTools:                 # Whitelist of allowed tools
  - run_shell_command
dependencies: []              # Other Skills this one depends on
---

# Usage Instructions
...
```

**Command/Agent Markdown (Command/Agent Type)**

Command and Agent types are typically single Markdown files, also supporting YAML Frontmatter.

```markdown
---
description: Description of this command
---

# Command Title

Specific instructions for the command go here...
```

#### 3.3 Script Support

The Skills system supports Python (`.py`), Bash (`.sh`, `.bash`), and Node.js (`.js`, `.mjs`, `.cjs`) scripts.
*   Scripts should be placed in the `scripts/` subdirectory.
*   The AI is strictly required to call these scripts directly rather than rewriting the code.

### 4. AI Interaction Mechanism

The system provides the `use_skill` tool for the AI to invoke skills.

#### 4.1 Invocation Flow

1.  **Discovery**: The AI sees a list of available Skills (metadata level) in its context.
2.  **Activation**: The AI calls `use_skill(skillName="name")`.
3.  **Loading**: The system loads the full content of `SKILL.md`.
    *   **Skill with Scripts**: The system issues a **severe warning**, forcing the AI to use `run_shell_command` to execute the pre-existing scripts, prohibiting the AI from writing new code to achieve the same functionality.
    *   **Pure Knowledge Skill**: The system injects the Markdown content into the context as an operational guide.

#### 4.2 Security & Limits

*   **Script Priority**: If a Skill provides scripts, the AI must use them.
*   **Tool Whitelist**: Skills can restrict which underlying tools the AI can use during execution.
*   **Sandbox Execution**: It is recommended to run Skill scripts in a sandboxed environment to ensure security.

---

<a id="chinese-version"></a>
## 🇨🇳 中文版

本文档详细说明了 Skills 系统架构及使用方法。

### 1. 系统架构概述

Skills 系统采用三层架构设计，旨在模块化扩展 AI 的能力：

1.  **Marketplace (市场)**: 顶层容器，通常是一个 Git 仓库或本地目录，包含多个 Plugin。
2.  **Plugin (插件)**: 逻辑分组，包含一组相关的 Skills、Commands 或 Agents。
3.  **Item (项)**: 最小的功能单元，分为三种类型：
    *   **Skill (技能)**: 由 `SKILL.md` 定义的复杂能力，可包含脚本。
    *   **Command (命令)**: 单个 Markdown 文件定义的指令，通常用于特定任务。
    *   **Agent (代理)**: 定义特定角色的 Markdown 文件，用于指导 AI 的行为模式。

### 2. CLI 命令使用说明

Otto CLI 新增了 `/skill` 命令族，用于管理整个生命周期。

#### 2.1 Marketplace 管理

管理技能来源（市场）。

*   **列出市场**:
    ```bash
    /skill marketplace list
    ```
*   **添加市场**:
    支持 Git URL 或本地路径。
    ```bash
    /skill marketplace add <git-url-or-local-path> [--name <custom-name>]
    # 示例
    /skill marketplace add https://github.com/anthropics/skills.git
    ```
*   **更新市场**:
    从 Git 拉取最新更改。
    ```bash
    /skill marketplace update <marketplace-name>
    ```
*   **浏览市场内容**:
    查看市场中可用的插件。支持通过插件名称、描述或关键词（keywords）进行搜索。
    ```bash
    /skill marketplace browse <marketplace-name> [search-query]
    ```
*   **移除市场**:
    ```bash
    /skill marketplace remove <marketplace-name> [--delete-files]
    ```

#### 2.2 Plugin 管理

管理具体的插件安装与启停。

*   **列出插件**:
    如果不带参数，列出已安装插件；带市场名则列出该市场的可用插件。
    ```bash
    /skill plugin list [marketplace-name]
    ```
*   **安装插件**:
    ```bash
    /skill plugin install <marketplace-name> <plugin-name>
    ```
*   **卸载插件**:
    ```bash
    /skill plugin uninstall <plugin-id>
    ```
*   **启用/禁用插件**:
    ```bash
    /skill plugin enable <plugin-id>
    /skill plugin disable <plugin-id>
    ```
*   **查看插件信息**:
    ```bash
    /skill plugin info <plugin-id>
    ```

#### 2.3 Skill 查看

查看已加载的具体技能。

*   **列出所有技能**:
    ```bash
    /skill list
    ```
*   **查看技能详情**:
    ```bash
    /skill info <skill-id>
    ```
*   **查看统计信息**:
    ```bash
    /skill stats
    ```

### 3. 开发自定义 Skill

要创建一个新的 Skill，需要遵循特定的目录结构和文件格式。

#### 3.1 目录结构

一个标准的 Skill 目录结构如下：

```text
my-plugin/
├── plugin.json           # 插件元数据 (可选，Strict模式下必需)
├── commands/             # Command 类型文件
│   └── my-command.md
├── agents/               # Agent 类型文件
│   └── my-agent.md
└── skills/               # Skill 类型目录
    └── my-skill/
        ├── SKILL.md      # 核心定义文件 (必需)
        ├── scripts/      # 可执行脚本目录 (可选)
        │   ├── script.py
        │   └── tool.js
        ├── LICENSE.txt   # 许可证 (可选)
        └── README.md     # 补充文档 (可选)
```

#### 3.2 定义文件格式

**SKILL.md (Skill 类型)**

`SKILL.md` 文件由 YAML Frontmatter 和 Markdown 正文组成。

```markdown
---
name: my-skill-name           # 技能名称 (小写字母、数字、连字符)
description: 简短描述         # 用于 AI 检索
license: MIT                  # 许可证
allowedTools:                 # 允许使用的工具白名单
  - run_shell_command
dependencies: []              # 依赖的其他 Skills
---

# 使用说明
...
```

**Command/Agent Markdown (Command/Agent 类型)**

Command 和 Agent 类型通常是单个 Markdown 文件，也支持 YAML Frontmatter。

```markdown
---
description: 这是一个命令的描述
---

# Command Title

这里是命令的具体指令...
```

#### 3.3 脚本支持

Skills 系统支持 Python (`.py`)、Bash (`.sh`, `.bash`) 和 Node.js (`.js`, `.mjs`, `.cjs`) 脚本。
*   脚本应放置在 `scripts/` 子目录下。
*   AI 会被强制要求直接调用这些脚本，而不是重新编写代码。

### 4. AI 交互机制

系统为 AI 提供了 `use_skill` 工具来调用技能。

#### 4.1 调用流程

1.  **发现**: AI 在上下文中看到可用的 Skills 列表（元数据级别）。
2.  **激活**: AI 调用 `use_skill(skillName="name")`。
3.  **加载**: 系统加载 `SKILL.md` 的完整内容。
    *   **含脚本的 Skill**: 系统会发出**严重警告**，强制 AI 使用 `run_shell_command` 执行预置脚本，禁止 AI 编写新代码来实现相同功能。
    *   **纯知识 Skill**: 系统将 Markdown 内容注入上下文，作为操作指南。

#### 4.2 安全与限制

*   **脚本优先**: 如果 Skill 提供了脚本，AI 必须使用它们。
*   **工具白名单**: Skill 可以限制 AI 在执行任务时能使用的底层工具。
*   **沙箱执行**: 建议在沙箱环境中运行 Skill 脚本以确保安全。