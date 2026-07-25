# Otto 构建工作流程 / Build Workflow

本文档介绍 Otto 项目的构建和开发工作流程，包含中英双语说明。

This document describes the build and development workflow for the Otto project, with bilingual instructions.

## 📋 项目结构 / Project Structure

Otto 采用 npm workspaces 的 monorepo 架构：

Otto uses a monorepo architecture with npm workspaces:

```
Otto/
├── packages/
│   ├── core/                   # 核心业务逻辑 / Core Business Logic
│   ├── server/                 # 本机与企业服务 / Local and enterprise services
│   └── desktop/                # Electron 桌面端 / Electron desktop client
└── package.json                # Workspace 配置 / Workspace Configuration
```

## 🚀 工作流程 / Workflow

### 1. 快速开发构建 / Quick Development Build

**用途 / Purpose**: 日常开发时使用，优先验证 core/server/desktop 三个边界
For daily development, validate the core/server/desktop boundaries first

```bash
# 基础构建 / Basic build
npm run build                    # 构建 core/server/desktop / Build core/server/desktop

# 开发版打包 / Development bundle
npm run bundle:dev              # 开发版打包（快速）/ Development bundle (fast)

# 生产版打包 / Production bundle
npm run bundle:prod             # 生产版打包（快速）/ Production bundle (fast)

# 跨平台打包 / Cross-platform bundle
npm run bundle:cross-platform:dev   # 开发版跨平台 / Development cross-platform
npm run bundle:cross-platform:prod  # 生产版跨平台 / Production cross-platform
```

### 2. VS Code 扩展开发 / VS Code Extension Development

**用途 / Purpose**: 专门用于 VS Code 扩展的开发和构建
Specifically for VS Code extension development and building

```bash
# 安装依赖 / Install dependencies
npm install --workspace=packages/vscode-ui-plugin

# 构建扩展 / Build extension
npm run build --workspace=packages/vscode-ui-plugin

# 打包扩展为 .vsix 文件 / Package extension as .vsix file
npm run pack:vscode

# 专用构建脚本 / Dedicated build script
npm run build:vscode
```

### 3. 完整构建 / Complete Build

**用途 / Purpose**: CI/CD 或需要完整功能时使用
For CI/CD or when complete functionality is needed

```bash
# 完整构建 / Complete build
npm run build:all               # 完整构建 + 沙箱 + VSCode / Complete build + sandbox + VSCode
npm run build:full              # 完整构建（包含 VSCode 扩展）/ Complete build (including VSCode extension)

# 完整打包 / Complete bundle
npm run bundle:full             # 完整打包（包含 VSCode 扩展）/ Complete bundle (including VSCode extension)

# 完整跨平台打包 / Complete cross-platform bundle
npm run bundle:cross-platform:full  # 完整跨平台打包 / Complete cross-platform bundle
```

## 🔧 开发命令 / Development Commands

### 基础开发 / Basic Development

```bash
# 启动开发模式 / Start development mode
npm run dev                     # 开发模式（带调试信息）/ Development mode (with debug info)

# 启动调试模式 / Start debug mode
npm run debug                   # 调试模式（带断点）/ Debug mode (with breakpoints)

# 标准启动 / Standard start
npm start                       # 标准启动 / Standard start
```

### 代码质量 / Code Quality

```bash
# 代码检查 / Code linting
npm run lint                    # 检查代码风格 / Check code style
npm run lint:fix                # 自动修复问题 / Auto-fix issues

# 代码格式化 / Code formatting
npm run format                  # 格式化代码 / Format code

# 类型检查 / Type checking
npm run typecheck               # TypeScript 类型检查 / TypeScript type checking
```

### 测试 / Testing

```bash
# 运行测试 / Run tests
npm test                        # 运行所有测试 / Run all tests
npm run test:ci                 # CI 测试（带覆盖率）/ CI tests (with coverage)

# 集成测试 / Integration tests
npm run test:integration:all    # 所有集成测试 / All integration tests
npm run test:e2e                # 端到端测试 / End-to-end tests
```

### 清理和维护 / Cleanup and Maintenance

```bash
# 清理构建产物 / Clean build artifacts
npm run clean                   # 清理所有构建文件 / Clean all build files

# 完整预检 / Complete preflight
npm run preflight               # 完整预检流程 / Complete preflight process
                                # (清理 + 安装 + 格式化 + 检查 + 构建 + 测试)
                                # (clean + install + format + lint + build + test)
```

## 📦 环境配置 / Environment Configuration

### API 密钥配置 / API Key Configuration

```bash
# Gemini API
export GEMINI_API_KEY="YOUR_API_KEY"

# Vertex AI
export GOOGLE_API_KEY="YOUR_API_KEY"
export GOOGLE_GENAI_USE_VERTEXAI=true
```

### 环境切换 / Environment Switching

```bash
# 切换到生产环境 / Switch to production
npm run env:production

# 切换到开发环境 / Switch to development
npm run env:development

# 切换到测试环境 / Switch to test
npm run env:test
```

## 🎯 推荐工作流程 / Recommended Workflow

### 日常开发 / Daily Development

1. **开始开发 / Start Development**
   ```bash
   npm run dev                  # 启动开发模式 / Start development mode
   ```

2. **代码修改后 / After Code Changes**
   ```bash
   npm run build               # 快速构建验证 / Quick build verification
   npm run lint                # 检查代码质量 / Check code quality
   npm test                    # 运行测试 / Run tests
   ```

### VS Code 扩展开发 / VS Code Extension Development

1. **准备扩展开发环境 / Prepare Extension Development**
   ```bash
   npm install --workspace=packages/vscode-ui-plugin
   ```

2. **开发和测试 / Development and Testing**
   ```bash
   npm run build --workspace=packages/vscode-ui-plugin
   npm run pack:vscode         # 生成 .vsix 文件测试 / Generate .vsix file for testing
   ```

### 发布准备 / Release Preparation

1. **完整构建和测试 / Complete Build and Test**
   ```bash
   npm run preflight           # 完整预检 / Complete preflight
   npm run build:all           # 完整构建 / Complete build
   ```

2. **打包发布 / Package for Release**
   ```bash
   npm run bundle:cross-platform:prod  # 跨平台生产包 / Cross-platform production bundle
   npm run pack:prod           # 生产打包 / Production packaging
   ```

## ⚠️ 注意事项 / Important Notes

### 依赖管理 / Dependency Management

- ✅ **在 workspace 根目录安装依赖** / Install dependencies at workspace root
- ✅ **使用 `--workspace` 参数操作特定包** / Use `--workspace` parameter for specific packages
- ❌ **避免在子包目录直接 `npm install`** / Avoid direct `npm install` in subpackage directories

### 构建策略 / Build Strategy

- 🚀 **日常开发使用快速构建** / Use quick build for daily development
- 🔧 **VS Code 扩展独立开发** / Develop VS Code extension independently
- 🎯 **发布前使用完整构建** / Use complete build before release

### 性能优化 / Performance Optimization

- ⚡ **默认构建排除 VS Code 扩展以提升速度** / Default build excludes VS Code extension for speed
- 🎨 **需要完整功能时使用 `INCLUDE_VSCODE_PLUGIN=true`** / Use `INCLUDE_VSCODE_PLUGIN=true` when complete functionality is needed
- 🔄 **CI/CD 环境建议使用完整构建** / Recommend complete build for CI/CD environments

## 📚 相关文档 / Related Documentation

- [项目架构 / Architecture](./architecture.md)
- [部署指南 / Deployment Guide](./deployment.md)
- [故障排除 / Troubleshooting](./troubleshooting.md)

---

## 🤝 团队协作 / Team Collaboration

### 新团队成员快速上手 / Quick Start for New Team Members

1. **克隆项目 / Clone Project**
   ```bash
   git clone <repository-url>
   cd DeepCode
   ```

2. **安装依赖 / Install Dependencies**
   ```bash
   npm install
   ```

3. **验证环境 / Verify Environment**
   ```bash
   npm run build
   npm test
   ```

4. **开始开发 / Start Development**
   ```bash
   npm run dev
   ```

### 提交代码前检查 / Pre-commit Checklist

- [ ] 运行 `npm run lint` 通过代码检查 / Pass code linting
- [ ] 运行 `npm test` 通过所有测试 / Pass all tests
- [ ] 运行 `npm run build` 确保构建成功 / Ensure build success
- [ ] 更新相关文档 / Update relevant documentation

---

*最后更新 / Last Updated: 2024-09-25*