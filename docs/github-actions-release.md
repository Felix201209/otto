# 🚀 GitHub Actions 自动构建和发布指南

## 📋 概述

本项目已配置 GitHub Actions 工作流，支持**一键自动构建跨平台包**并**创建 GitHub Release**。

## 🎯 快速开始

### 第一次设置（仅需一次）

#### 1. 推送工作流配置到 GitHub

```bash
# 1. 添加 .github 目录
git add .github

# 2. 提交
git commit -m "feat: 添加 GitHub Actions 自动构建和发布工作流"

# 3. 推送到远程仓库
git push origin ls-dev

# 4. 如果需要同步到 github_main 分支
npm run sync-to-github
```

#### 2. 配置 GitHub 仓库权限

1. 访问仓库设置页面：
   ```
   https://github.com/OrionStarAI/OttoCode/settings/actions
   ```

2. 找到 **"Workflow permissions"** 部分

3. 选择 **"Read and write permissions"**

4. 勾选 **"Allow GitHub Actions to create and approve pull requests"**（可选）

5. 点击 **"Save"** 保存

> ⚠️ **重要**：这一步是必须的，否则工作流无法创建 Release！

## 🎬 使用方式

### 方式 1: 手动触发构建（推荐）

**适用场景**：想立即发布新版本，或测试构建流程

**步骤**：

1. **访问 GitHub Actions 页面**
   ```
   https://github.com/OrionStarAI/OttoCode/actions/workflows/release.yml
   ```

2. **点击右上角 "Run workflow" 按钮**

3. **选择分支**（通常选择 `ls-dev` 或 `main`）

4. **填写参数**（全部可选）：

   | 参数 | 说明 | 示例 |
   |------|------|------|
   | **version** | 指定版本号（留空则使用 package.json 中的版本） | `1.0.262` 或 `1.0.262-beta.1` |
   | **prerelease** | 是否为预发布版本（测试版本勾选） | 勾选 ✅ |
   | **draft** | 是否创建草稿（需要手动发布） | 勾选 ✅ |

5. **点击绿色的 "Run workflow" 按钮**

6. **等待构建完成**（约 3-5 分钟）

7. **查看结果**：
   - 访问 [Releases 页面](https://github.com/OrionStarAI/OttoCode/releases) 查看新发布的版本
   - 或在 workflow 运行页面的 Artifacts 区域下载构建产物

### 方式 2: 推送 Git Tag 自动触发（推荐）

**适用场景**：版本发布流程规范化，自动触发构建，并通过 tag 消息生成 Release Notes

**步骤**：

```bash
# 1. 本地更新版本号
npm version 1.0.262
# 或手动修改 package.json 中的 version

# 2. 创建带注释的 tag（tag 消息将作为 Release Notes）
git tag -a v1.0.262 -m "Release v1.0.262

## ✨ New Features
- Add new authentication flow with enhanced security
- Support for custom proxy configurations

## 🐛 Bug Fixes
- Fix memory leak in file watcher
- Resolve issue with clipboard on Ubuntu

## 📚 Documentation
- Update installation guide
- Add troubleshooting section for Windows users
"

# 或者使用编辑器编写详细的 tag 消息
git tag -a v1.0.262
# 这会打开编辑器，让你编写多行 Release Notes

# 3. 推送代码和 tag
git push && git push --tags

# 工作流会自动运行，使用 tag 消息生成 Release Notes
```

**💡 Tag 消息格式建议**：

```markdown
Release v1.0.262

## ✨ New Features
- Feature 1 description
- Feature 2 description

## 🐛 Bug Fixes
- Bug fix 1
- Bug fix 2

## 🔧 Improvements
- Improvement 1
- Improvement 2

## 📚 Documentation
- Documentation updates

## ⚠️ Breaking Changes
- Breaking change description (if any)
```

## 📦 工作流执行内容

当你触发工作流后，GitHub Actions 会自动执行以下步骤：

1. ✅ **检出代码** - 获取最新代码（包含完整 tag 信息）
2. ✅ **设置环境** - 安装 Node.js 22.13
3. ✅ **安装依赖** - `npm ci`
4. ✅ **运行测试** - `npm run test`（失败不会中断）
5. ✅ **代码检查** - `npm run lint`（失败不会中断）
6. ✅ **类型检查** - `npm run typecheck`（失败不会中断）
7. ✅ **构建跨平台包** - `npm run pack:prod:ci`（不自动递增版本号）
8. ✅ **获取版本号** - 从输入参数、tag 或 package.json
9. ✅ **查找构建产物** - 找到生成的 `.tgz` 文件
10. ✅ **提取 tag 注释** - 从 annotated tag 中提取 Release Notes
11. ✅ **生成 Release Notes** - 使用 tag 消息 + 安装说明模板
12. ✅ **创建 GitHub Release** - 上传 `.tgz` 文件并发布
13. ✅ **上传构建产物** - 作为 workflow artifact（保留 90 天）

## 📥 下载和使用构建产物

### 从 GitHub Release 下载

1. 访问 [Releases 页面](https://github.com/OrionStarAI/OttoCode/releases)
2. 找到对应版本
3. 下载 `easycode-ai-x.x.x.tgz` 文件
4. 安装：
   ```bash
   npm install -g ./easycode-ai-1.0.262.tgz
   ```

### 从 npm 安装（发布到 npm 后）

```bash
npm install -g easycode-ai@1.0.262
```

### 从 Workflow Artifacts 下载（用于测试）

1. 访问 [Actions 页面](https://github.com/OrionStarAI/OttoCode/actions/workflows/release.yml)
2. 点击对应的工作流运行
3. 在页面底部的 "Artifacts" 区域下载
4. 解压后安装

## 🎯 常见使用场景

### 场景 1: 发布正式版本

```bash
# 1. 确保代码已提交
git status

# 2. 更新版本号（手动或使用 npm version）
npm version patch   # 1.0.261 → 1.0.262
# 或
npm version minor   # 1.0.261 → 1.1.0
# 或
npm version major   # 1.0.261 → 2.0.0

# 3. 推送代码和 tags
git push && git push --tags

# 4. GitHub Actions 自动构建并创建 Release（使用 package.json 中的版本号）
```

> 💡 **注意**：GitHub Actions 使用 `pack:prod:ci` 命令，**不会自动递增版本号**，而是使用 `package.json` 中的当前版本。请确保在触发 workflow 前手动更新版本号。

### 场景 2: 发布测试版本

**方法 A: 使用手动触发**

1. 访问 Actions 页面
2. Run workflow
3. 设置：
   - version: `1.0.262-beta.1`
   - prerelease: ✅
4. 运行

**方法 B: 使用 tag（推荐）**

```bash
# 1. 修改 package.json 版本为 1.0.262-beta.1

# 2. 创建带注释的 tag 并标记为预发布
git tag -a v1.0.262-beta.1 -m "Beta Release v1.0.262-beta.1

## 🧪 Testing Features
- New feature A (needs testing)
- Experimental feature B

## ⚠️ Known Issues
- Issue X is being investigated
"

# 3. 推送 tag
git push origin v1.0.262-beta.1
```

> 💡 **提示**：包含 `-alpha`, `-beta`, `-rc` 的版本号会自动被标记为 prerelease。

### 场景 3: 创建草稿 Release（需人工审核）

1. 访问 Actions 页面
2. Run workflow
3. 设置：
   - draft: ✅
4. 运行完成后
5. 访问 Releases 页面
6. 编辑草稿 Release
7. 点击 "Publish release"

### 场景 4: 测试构建流程（不创建 Release）

如果只想测试构建是否正常，可以：

1. 临时修改 `.github/workflows/release.yml`
2. 注释掉 "Create GitHub Release" 步骤
3. 手动触发工作流
4. 查看构建日志和下载 Artifacts

## ⚙️ 高级配置

### 同时发布到 npm

在 `.github/workflows/release.yml` 中添加：

```yaml
- name: 📤 Publish to npm
  run: npm publish
  env:
    NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}
```

然后在 GitHub 仓库设置中添加 `NPM_TOKEN` secret：

1. 访问 `https://github.com/OrionStarAI/OttoCode/settings/secrets/actions`
2. 点击 "New repository secret"
3. Name: `NPM_TOKEN`
4. Value: 你的 npm token（从 https://www.npmjs.com/settings/YOUR_USERNAME/tokens 获取）

### 跳过测试步骤

如果测试很慢，可以：

**方法 1**: 注释掉测试步骤

```yaml
# - name: 🧪 Run tests
#   run: npm run test
```

**方法 2**: 保留但允许失败（已配置）

```yaml
- name: 🧪 Run tests
  run: npm run test
  continue-on-error: true  # 测试失败也继续
```

### 自定义 Release Notes

修改 `.github/workflows/release.yml` 中的 "Generate Release Notes" 步骤。

## ⚠️ 故障排查

### 问题 1: 工作流失败，提示权限不足

**解决方案**：

1. 检查仓库 Actions 权限设置
2. 路径: Settings → Actions → General → Workflow permissions
3. 选择 "Read and write permissions"

### 问题 2: 找不到 .tgz 文件

**可能原因**：

- `npm run pack:prod` 执行失败
- 依赖安装问题
- 构建脚本错误

**解决方案**：

1. 查看工作流日志中的 "Build cross-platform package" 步骤
2. 本地测试 `npm run pack:prod` 是否正常
3. 检查构建脚本 `scripts/newpack.js`

### 问题 3: Release 创建成功但没有文件

**可能原因**：

- 文件路径配置错误
- 文件未找到

**解决方案**：

检查 `.github/workflows/release.yml` 中的 `files:` 配置：

```yaml
files: |
  ${{ steps.find_artifacts.outputs.TGZ_FILE }}
  bundle/**/*
```

### 问题 4: 想修改 Release 的内容

**方案**：

1. 访问 Releases 页面
2. 找到对应的 Release
3. 点击 "Edit release"
4. 修改标题、描述或上传/删除文件
5. 保存

## 📚 相关文档

- [GitHub Actions 工作流详细说明](.github/workflows/README.md)
- [npm 发布指南](./npm-publish-guide.md)
- [部署架构](./deployment.md)

## 🔗 快速链接

- [🎬 触发构建](https://github.com/OrionStarAI/OttoCode/actions/workflows/release.yml)
- [📦 查看 Releases](https://github.com/OrionStarAI/OttoCode/releases)
- [📊 Actions 运行历史](https://github.com/OrionStarAI/OttoCode/actions)
- [⚙️ 仓库 Actions 设置](https://github.com/OrionStarAI/OttoCode/settings/actions)

## 💡 提示

- 首次使用前，务必配置仓库权限（见"第一次设置"）
- **推荐使用 annotated tag 触发**，Release Notes 更有意义
- 使用 `git tag -a` 创建带注释的 tag，消息会成为 Release Notes
- 可以先用 `draft: true` 创建草稿测试
- Workflow artifacts 保留 90 天，适合临时测试
- 正式 Release 永久保存
- Tag 消息支持 Markdown 格式，可以包含链接、代码块等

## 📝 Tag 消息最佳实践

### 简单版本（快速发布）
```bash
git tag -a v1.0.262 -m "Fix critical authentication bug"
```

### 详细版本（正式发布）
```bash
git tag -a v1.0.262
# 在编辑器中写入：
```

```markdown
Release v1.0.262

## ✨ New Features
- **Authentication**: Add OAuth2 support for enterprise users
- **Performance**: Implement intelligent caching for 50% faster startup
- **UI**: New dark theme with customizable color schemes

## 🐛 Bug Fixes
- Fix memory leak in file watcher (#123)
- Resolve clipboard issue on Ubuntu 22.04 (#145)
- Correct Windows path handling for spaces (#156)

## 🔧 Improvements
- Reduce bundle size by 30% through tree-shaking
- Improve error messages for network failures
- Add progress indicators for long-running operations

## 📚 Documentation
- Add comprehensive authentication guide
- Update installation instructions for ARM64
- Include troubleshooting section for common issues

## 🙏 Contributors
Thanks to @user1, @user2, and @user3 for their contributions!
```

### 使用 Conventional Commits
```bash
git tag -a v1.0.262 -m "Release v1.0.262

feat: add OAuth2 authentication support
feat: implement intelligent caching system
fix: resolve memory leak in file watcher (#123)
fix: correct Windows path handling (#156)
perf: reduce bundle size by 30%
docs: add authentication guide
"
```
