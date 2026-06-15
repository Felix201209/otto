# Extensions 命令使用指南

Extensions 命令用于管理 Otto CLI 的扩展。扩展可以添加自定义命令、提供 MCP 工具和上下文信息。

## 命令概览

```bash
easycode extensions <subcommand> [options]
```

支持的子命令：
- `install` - 安装扩展
- `uninstall` - 卸载扩展
- `list` - 列出已安装的扩展
- `link` - 链接本地扩展（开发用）
- `new` - 创建新扩展
- `validate` - 验证扩展配置

## install - 安装扩展

### 从 Git 仓库安装

```bash
easycode extensions install <repository-url> [options]
```

**参数**：
- `<repository-url>` - Git 仓库地址（支持 https/http/git@ 协议）

**选项**：
- `--ref <branch|tag|commit>` - 指定 Git ref（分支、标签或提交哈希）
- `--auto-update` - 启用自动更新此扩展
- `--pre-release` - 允许安装预发布版本
- `--consent` - 跳过安全风险确认提示

**示例**：
```bash
# 从 GitHub 安装最新版本
easycode extensions install https://github.com/user/my-extension

# 指定特定分支
easycode extensions install https://github.com/user/my-extension --ref develop

# 启用自动更新
easycode extensions install https://github.com/user/my-extension --auto-update

# 跳过确认提示
easycode extensions install https://github.com/user/my-extension --consent
```

### 从本地路径安装

```bash
easycode extensions install <local-path>
```

**示例**：
```bash
easycode extensions install ./my-extension
easycode extensions install /absolute/path/to/extension
```

## uninstall - 卸载扩展

```bash
easycode extensions uninstall <name>
```

**参数**：
- `<name>` - 扩展名称或源路径

**示例**：
```bash
# 按扩展名卸载
easycode extensions uninstall my-extension

# 按源路径卸载
easycode extensions uninstall https://github.com/user/my-extension
```

## list - 列出已安装的扩展

```bash
easycode extensions list
```

显示所有已安装的扩展信息，包括：
- 扩展名称
- 版本号
- 安装路径
- 源地址（Git URL 或本地路径）
- 可用的命令
- MCP 服务器（如果有）

**示例**：
```bash
$ easycode extensions list

Installed Extensions:

  📦 my-extension (1.0.0)
     Source: https://github.com/user/my-extension
     Path: ~/.easycode-user/extensions/my-extension
     Commands: /ext:my-extension:analyze, /ext:my-extension:generate
     MCP Servers: my-tools
```

## link - 链接本地扩展

用于开发时快速测试本地扩展。链接的扩展会在每次启动时读取最新文件，无需重新安装。

```bash
easycode extensions link <path>
```

**参数**：
- `<path>` - 本地扩展目录的路径

**示例**：
```bash
easycode extensions link ./extensions/my-extension

# 之后可以通过扩展名卸载
easycode extensions uninstall my-extension
```

## new - 创建新扩展

```bash
easycode extensions new <path> [template]
```

**参数**：
- `<path>` - 创建扩展的目录路径
- `[template]` - 使用的模板（可选）

**示例**：
```bash
# 创建基础扩展结构
easycode extensions new ./my-extension

# 基于模板创建
easycode extensions new ./my-extension basic

# 创建后可以测试链接
easycode extensions link ./my-extension
```

创建的扩展包含：
- `gemini-extension.json` - 扩展配置文件

## validate - 验证扩展

```bash
easycode extensions validate <path>
```

验证扩展配置的有效性，检查：
- `gemini-extension.json` 文件是否有效
- 引用的上下文文件是否存在
- 版本号是否遵循 semver 格式

**参数**：
- `<path>` - 扩展目录路径

**示例**：
```bash
easycode extensions validate ./my-extension
```

## 扩展目录结构

扩展通常包含以下结构：

```
my-extension/
├── gemini-extension.json          # 必需：扩展配置
├── GEMINI.md                      # 可选：提供给 AI 的上下文信息
├── package.json                   # 可选：npm 包配置
├── commands/                      # 可选：命令定义
│   ├── analyze.toml
│   └── generate/
│       └── code.toml
├── mcp/                           # 可选：MCP 服务器脚本
│   └── server.js
└── README.md                      # 可选：文档
```

## gemini-extension.json 配置

扩展的核心配置文件：

```json
{
  "name": "my-extension",
  "version": "1.0.0",
  "description": "Extension description",
  "mcpServers": {
    "server-name": {
      "command": "node",
      "args": ["./mcp/server.js"],
      "env": {
        "DEBUG": "true"
      }
    }
  },
  "contextFileName": "GEMINI.md",
  "excludeTools": ["run_shell_command"]
}
```

**字段说明**：
- `name` - 扩展名称（必需）
- `version` - 版本号（必需）
- `description` - 描述信息（可选）
- `mcpServers` - MCP 服务器定义（可选）
- `contextFileName` - AI 上下文文件名（可选）
- `excludeTools` - 禁用的工具列表（可选）

## 扩展命令

扩展可以在 `commands/` 目录中添加 TOML 格式的命令定义。

**文件示例**：`commands/analyze.toml`
```toml
description = "Analyze code for issues"
prompt = """
You are a code analyst.
Please analyze the following code:
{{args}}

Focus on:
- Performance issues
- Security concerns
- Code style
"""
```

**命令调用**：
```bash
/ext:my-extension:analyze
```

**使用嵌套命令**：
```
commands/
├── analyze/
│   ├── performance.toml   → /ext:my-extension:analyze:performance
│   └── security.toml      → /ext:my-extension:analyze:security
└── generate/
    └── code.toml          → /ext:my-extension:generate:code
```

## 安装位置

扩展安装到用户主目录：
- **用户级**：`~/.easycode-user/extensions/`

## 常见问题

### 如何开发扩展？

1. 创建扩展结构：
   ```bash
   easycode extensions new ./my-extension
   ```

2. 编辑配置和命令

3. 链接本地扩展进行测试：
   ```bash
   easycode extensions link ./my-extension
   ```

4. 验证扩展：
   ```bash
   easycode extensions validate ./my-extension
   ```

### 如何从 Git 分支测试？

```bash
easycode extensions install https://github.com/user/my-extension --ref develop
```

### 如何更新已安装的扩展？

重新运行 install 命令会更新现有扩展：
```bash
easycode extensions install https://github.com/user/my-extension
```

### 安装失败怎么办？

1. 检查网络连接
2. 确认 Git URL 有效
3. 尝试卸载后重新安装：
   ```bash
   easycode extensions uninstall my-extension
   easycode extensions install https://github.com/user/my-extension
   ```

### 如何禁用特定工具？

在 `gemini-extension.json` 中使用 `excludeTools` 字段：
```json
{
  "excludeTools": ["run_shell_command", "shell"]
}
```

## 最佳实践

1. **命名规范** - 使用小写和连字符（如 `my-extension`）

2. **版本管理** - 遵循 semver 格式（如 1.0.0）

3. **提供文档** - 创建 GEMINI.md 为 AI 提供上下文

4. **命令描述** - 在 TOML 文件中添加 description 字段

5. **参数处理** - 在 prompt 中使用 `{{args}}` 处理用户输入
