---
type: guide
date: 2026-05-29
tags: [release, git, tag, ci-cd, npm, workflow]
---

# Release Process Guide

> 本文档详细记录了 Easy Code 项目的规范化发布流程和核心校验规则。

## 核心规则与纪律

在执行任何发布动作之前，必须严格遵守以下关键准则，否则会导致 CI/CD 编译失败或污染代码分支：

### 1. 已推送的提交禁止 Amend
- **常驻开发分支**：`ls-dev` 分支会频繁合到主线。
- **Git 提交纪律**：**已推送到远程仓库的提交绝对不能再进行 `git commit --amend`**！如果需要修改，必须新建一笔 commit。提 MR 时也绝对不要加 `--remove-source-branch`。

### 2. 版本号严格关系限制 (CI 成功前提)
- `package.json` 中的版本号可以不随发布手动递增（CI 发布时会自动注入真实版本号）。
- ⚠️ **核心红线限制**：**`package.json` 里的版本号必须严格低于（<）发布的 release tag 版本号**。
  - *示例*：如果 release tag 为 `cli-release-v1.0.358`，则 `package.json` 的版本必须小于 `1.0.358`（例如项目内维持在 `1.0.319` 便能完美通过 CI）。

### 3. ⚠️ 打 Tag 前本地必须构建全绿 (防远程挂掉)
- **硬性红线要求**：在执行任何打 Tag 动作并推送到远程之前，**必须首先在本地运行 `npm run build` 确保整个 Monorepo 编译完完全全全绿通过**！
- 严禁“先打 Tag 推送，再本地验证”或者“带病（编译类型报错）上远程”，否则 CI/CD 流水线将会因 TypeScript 编译错误而立即失败，导致版本号废损。

---

## 规范发布步骤

请严格按照以下标准化顺序执行代码修改、主线合并和版本发布：

### 步骤 1. 本地代码修改与就地验证
在修改完业务代码后，严禁直接推送。必须首先执行本地验证：
- **运行单元测试**：使用单文件测试命令验证业务逻辑。
  ```bash
  npx vitest run <test-file-path>
  ```
- **全量构建编译**：本地运行全量编译，确保类型校验没有引入任何错误。
  ```bash
  npm run build
  ```

### 步骤 2. 提交并推送开发分支
将代码改动提交到本地，并推送到远程开发分支 `ls-dev`：
```bash
git add <modified-files>
git commit -m "feat(module): your clear message"
git push origin ls-dev
```

### 步骤 3. 创建 MR 并合并至主线
由于主线分支（如 `master`）是保护分支，无法直接推送：
1. **优先使用本地 `glab` 命令**创建一个 Merge Request（MR）。如果本地环境未安装或配置 `glab` 命令行工具，则引导用户在 GitLab 网页端手动创建。
2. 优先通过 `glab` 执行 Merge 合并；在无 `glab` 环境下由用户在网页端审核并执行合并，将改动合并至主线 `master` 分支。

### 步骤 4. 切换主线，拉取并再次验证 (双重全绿校验)
为了彻底防范任何由于分支合并产生的冲突或缺陷，合并至主线后**必须在 master 上拉取并再次本地编译**：
1. 本地切换到主线分支：
   ```bash
   git checkout master
   ```
2. 从远程拉取最新代码（获取主线合并后的最终提交）：
   ```bash
   git pull origin master
   ```
3. **至关重要：在本地 master 上再次运行构建**，确保最终合并后的代码 100% 全绿通过：
   ```bash
   npm run build
   ```

### 步骤 5. 在主线打 Tag 重新发版
只有在步骤 4 验证主线完全无冲突且本地构建全绿后，才可以开始发版：
1. 列出远程最新的 release tag 列表：
   ```bash
   git tag -l "cli-release-v*" --sort=-v:refname
   ```
   *计算*：假设最新 tag 为 `cli-release-v1.0.360`，递增后下一版为 `cli-release-v1.0.361`。
2. 确认本地 `package.json` 中的版本号严格小于（<）此版本号。
3. 在本地 `master` 分支创建此递增的新 Tag：
   ```bash
   git tag cli-release-v1.0.361
   ```
4. 将此 Tag 推送到远程，触发 CI/CD 自动化流水线：
   ```bash
   git push origin cli-release-v1.0.361
   ```
5. 发版结束后，切回 `ls-dev` 继续开展日常开发工作：
   ```bash
   git checkout ls-dev
   ```

---

## 关联阅读

- [[build-system]]
- [[cli-module]]
- [[core-module]]
