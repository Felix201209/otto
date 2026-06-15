# GitHub Actions 工作流说明

## 📋 可用工作流

### 1. `release.yml` - 构建和发布工作流

自动构建跨平台包并创建 GitHub Release。

#### 🎯 触发方式

**方式 1: 手动触发（推荐）**

1. 访问 GitHub Actions 页面：
   ```
   https://github.com/OrionStarAI/EasyCodeCode/actions/workflows/release.yml
   ```

2. 点击右上角 **"Run workflow"** 按钮

3. 填写参数（都是可选的）：
   - **version**: 版本号（留空则使用 package.json 中的版本）
   - **prerelease**: 是否为预发布版本（测试版本勾选）
   - **draft**: 是否创建草稿 Release（勾选后需要手动发布）

4. 点击绿色的 **"Run workflow"** 按钮

**方式 2: 推送 tag 自动触发**

```bash
# 1. 创建 tag
git tag v1.0.261

# 2. 推送到 GitHub
git push origin v1.0.261

# 工作流会自动运行并创建 Release
```

#### 📦 工作流执行内容

1. ✅ 检出代码
2. ✅ 设置 Node.js 20 环境
3. ✅ 安装依赖
4. ✅ 运行测试（失败不会中断）
5. ✅ 代码 lint 检查（失败不会中断）
6. ✅ TypeScript 类型检查（失败不会中断）
7. ✅ 构建跨平台包 (`npm run pack:prod`)
8. ✅ 生成 Release Notes
9. ✅ 创建 GitHub Release 并上传 `.tgz` 文件
10. ✅ 上传构建产物为 workflow artifact

#### 📥 获取构建产物

**方式 1: 从 GitHub Release 下载**

访问 Releases 页面：
```
https://github.com/OrionStarAI/EasyCodeCode/releases
```

下载 `easycode-ai-x.x.x.tgz` 文件。

**方式 2: 从 workflow artifacts 下载**

1. 访问 Actions 页面找到对应的工作流运行
2. 在页面底部的 "Artifacts" 区域下载
3. 适合测试还未正式发布的版本

#### 🔐 权限要求

工作流需要以下权限（已在配置中设置）：
- `contents: write` - 创建 Release 和上传文件
- `packages: write` - 发布包（如果将来需要发布到 GitHub Packages）

#### 🛠️ 自定义配置

如果需要修改工作流：

1. 编辑 `.github/workflows/release.yml`
2. 常见自定义项：
   - 修改 Node.js 版本（默认 20）
   - 启用/禁用测试步骤
   - 修改 Release Notes 模板
   - 添加其他构建步骤

#### 📝 示例：发布新版本

**场景 1: 发布正式版本**

```bash
# 1. 本地更新版本号
npm version 1.0.262

# 2. 推送代码和 tag
git push
git push --tags

# 3. 工作流自动运行，创建 Release
```

**场景 2: 手动发布测试版本**

1. 访问 Actions 页面
2. 点击 "Run workflow"
3. 设置：
   - version: `1.0.262-beta.1`
   - prerelease: ✅ 勾选
   - draft: 不勾选
4. 运行

**场景 3: 创建草稿 Release（需要人工审核后发布）**

1. 访问 Actions 页面
2. 点击 "Run workflow"
3. 设置：
   - draft: ✅ 勾选
4. 运行
5. 工作流完成后，去 Releases 页面手动发布

#### ⚠️ 常见问题

**Q: 工作流失败，提示 "No .tgz file found"**

A: 检查 `npm run pack:prod` 是否成功执行。可能原因：
- 依赖安装失败
- 构建脚本错误

**Q: 创建 Release 失败，提示权限不足**

A: 确保：
1. 仓库设置中 Actions 权限设置为 "Read and write permissions"
   - 路径: Settings → Actions → General → Workflow permissions
2. 或在工作流文件中显式设置了 `permissions`

**Q: 想跳过测试直接构建**

A: 两种方式：
1. 在 `.github/workflows/release.yml` 中注释掉测试步骤
2. 或保留 `continue-on-error: true` 让测试失败也继续执行

**Q: 想同时发布到 npm**

A: 添加一个新步骤：

```yaml
- name: 📤 Publish to npm
  run: npm publish
  env:
    NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}
```

需要在 GitHub 仓库设置中添加 `NPM_TOKEN` secret。

#### 📚 相关文档

- [GitHub Actions 文档](https://docs.github.com/en/actions)
- [创建 Release](https://docs.github.com/en/repositories/releasing-projects-on-github/managing-releases-in-a-repository)
- [workflow_dispatch 事件](https://docs.github.com/en/actions/using-workflows/events-that-trigger-workflows#workflow_dispatch)

#### 🔗 快速链接

- [查看工作流运行历史](https://github.com/OrionStarAI/EasyCodeCode/actions/workflows/release.yml)
- [查看所有 Releases](https://github.com/OrionStarAI/EasyCodeCode/releases)
- [仓库 Actions 设置](https://github.com/OrionStarAI/EasyCodeCode/settings/actions)
