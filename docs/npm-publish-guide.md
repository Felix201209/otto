# 📦 Otto npm 发布指南

## 🎯 发布前准备

### 1️⃣ 修改 package.json

需要修改根目录的 `package.json`：

```json
{
  "name": "easycode-ai",  // ✅ 包名（如果想发布到自己的 scope，可以改为 @你的用户名/easycode-ai）
  "version": "1.0.179",  // ✅ 版本号
  "private": false,      // ❌ 删除这行或改为 false（当前是 "true"，会阻止发布）

  // 建议修改为你自己的仓库地址
  "repository": {
    "type": "git",
    "url": "git+https://github.com/你的用户名/DeepCode.git"
  },

  // 添加一些有用的字段
  "keywords": [
    "ai",
    "coding-assistant",
    "easycode-ai",
    "cli",
    "gemini",
    "code-generation"
  ],
  "author": "Your Name",
  "license": "Apache-2.0",
  "homepage": "https://github.com/你的用户名/DeepCode#readme",
  "bugs": {
    "url": "https://github.com/你的用户名/DeepCode/issues"
  }
}
```

**关键修改点：**
- ✅ `"private": true` → 删除或改为 `false`
- ✅ 修改 `repository` URL
- ✅ 添加 `keywords` 方便用户搜索
- ✅ 添加 `author`、`homepage`、`bugs`

### 2️⃣ 确保 bundle 已构建

```bash
npm run bundle:cross-platform:prod
```

这会生成 `bundle/` 目录，里面包含了要发布的所有文件。

### 3️⃣ 检查发布内容

运行检查脚本：

```bash
node scripts/npm-publish-check.js
```

或者使用 npm 自带的测试发布（不会真正发布）：

```bash
npm pack --dry-run
```

查看会发布哪些文件：

```bash
npm pack
```

这会生成一个 `.tgz` 文件，你可以解压查看内容：

```bash
tar -tzf easycode-ai-1.0.179.tgz
```

## 🚀 发布步骤

### 步骤 1：登录 npm

```bash
npm login
```

输入：
- Username（用户名）
- Password（密码）
- Email（邮箱）
- OTP（如果开启了两步验证）

验证登录状态：

```bash
npm whoami
```

### 步骤 2：测试发布（推荐）

先模拟发布，看看会上传什么：

```bash
npm publish --dry-run
```

### 步骤 3：正式发布

**首次发布：**

```bash
# 如果包名不带 @scope（如 easycode-ai）
npm publish

# 如果包名带 @scope（如 @yourname/easycode-ai）
npm publish --access public
```

**后续更新：**

每次更新版本后：

```bash
# 1. 更新版本号（自动修改 package.json）
npm version patch   # 1.0.179 -> 1.0.180
npm version minor   # 1.0.179 -> 1.1.0
npm version major   # 1.0.179 -> 2.0.0

# 或手动修改 package.json 中的 version

# 2. 重新构建
npm run bundle:cross-platform:prod

# 3. 发布
npm publish
```

## 📋 发布检查清单

发布前确认：

- [ ] `package.json` 中 `private` 不是 `true`
- [ ] `version` 版本号已更新
- [ ] `bundle/` 目录已生成且包含最新代码
- [ ] `README.md` 存在且内容完善
- [ ] `LICENSE` 文件存在
- [ ] `.npmignore` 正确配置（或依赖 `files` 字段）
- [ ] 已登录 npm (`npm whoami`)
- [ ] 运行过 `npm publish --dry-run` 测试

## 🎨 包名选择建议

### 选项 1：使用简单包名（如果可用）
```json
{
  "name": "easycode-ai"
}
```

优点：简洁易记
缺点：可能已被占用

检查包名是否可用：
```bash
npm view easycode-ai
# 如果显示 404，说明可用
```

### 选项 2：使用 scoped 包名
```json
{
  "name": "@你的npm用户名/easycode-ai"
}
```

优点：一定可用（你的 scope 下）
缺点：名字稍长

发布 scoped 包需要加 `--access public`：
```bash
npm publish --access public
```

## 📝 发布后的工作

### 1. 更新 README 安装说明

```markdown
## 安装

\`\`\`bash
npm install -g easycode-ai
\`\`\`

## 使用

\`\`\`bash
easycode
\`\`\`
```

### 2. 在 GitHub 创建 Release

- 打 tag：`git tag v1.0.179`
- 推送 tag：`git push origin v1.0.179`
- 在 GitHub 上创建 Release

### 3. 添加徽章到 README

```markdown
[![npm version](https://badge.fury.io/js/easycode-ai.svg)](https://www.npmjs.com/package/easycode-ai)
[![Downloads](https://img.shields.io/npm/dm/easycode-ai.svg)](https://www.npmjs.com/package/easycode-ai)
```

## 🔄 自动化发布脚本

可以添加到 `package.json`：

```json
{
  "scripts": {
    "prepublishOnly": "npm run bundle:cross-platform:prod",
    "publish:check": "node scripts/npm-publish-check.js",
    "publish:test": "npm publish --dry-run",
    "publish:patch": "npm version patch && npm publish",
    "publish:minor": "npm version minor && npm publish",
    "publish:major": "npm version major && npm publish"
  }
}
```

使用：

```bash
npm run publish:check   # 检查
npm run publish:test    # 测试发布
npm run publish:patch   # 发布补丁版本
```

## ⚠️ 常见问题

### Q1: 发布时提示 "You do not have permission to publish"
- 检查是否登录：`npm whoami`
- 检查包名是否被占用：`npm view 包名`
- 如果是 scoped 包，加上 `--access public`

### Q2: 发布时提示 "package.json private field is true"
- 修改 `package.json`，删除 `"private": true` 或改为 `false`

### Q3: 用户安装后找不到命令
- 检查 `package.json` 中的 `bin` 字段是否正确
- 检查 `bundle/easycode.js` 第一行是否有 `#!/usr/bin/env node`

### Q4: 包太大
- 检查 `.npmignore` 是否正确配置
- 使用 `npm pack` 查看实际包含的文件
- 确保 `files` 字段只包含必要的文件

### Q5: 想撤回已发布的版本
```bash
# 只能撤回 72 小时内发布的版本
npm unpublish 包名@版本号

# 或者标记为废弃
npm deprecate 包名@版本号 "废弃原因"
```

## 🎯 推荐发布流程

```bash
# 1. 确保所有代码已提交
git status

# 2. 更新版本号（也可以手动修改）
npm version patch

# 3. 重新构建
npm run bundle:cross-platform:prod

# 4. 检查发布内容
node scripts/npm-publish-check.js
npm publish --dry-run

# 5. 正式发布
npm publish

# 6. 推送 git tag
git push && git push --tags

# 7. 验证发布
npm view easycode-ai
npm install -g easycode-ai@latest
easycode --version
```

## 📚 相关资源

- [npm 官方文档](https://docs.npmjs.com/cli/v9/commands/npm-publish)
- [语义化版本](https://semver.org/lang/zh-CN/)
- [npm 包管理最佳实践](https://docs.npmjs.com/packages-and-modules)
