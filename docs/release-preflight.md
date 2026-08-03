# Otto 发布前检查清单与规范

这份文档是 Otto 发版前的硬门禁。没有完成并记录这里的检查，就不要打 tag、创建 Release、上传安装包或升级企业服务器。

## 0.2 可执行发布审核（不可跳过）

`.github/release-attestation.json` 是发布审批记录，不是可选模板。每次发版必须在提交中更新它，并且 Release workflow 会拒绝下列任一项缺失或不匹配的版本：

- `version` 与本次 release 版本一致，`sourceCommit` 与触发 workflow 的父提交（被本次审批记录覆盖的发布源码）的 40 位 commit 一致；审批记录本身必须是该父提交之后的独立提交。
- 成功 CI 的 HTTPS 链接与产物校验说明。
- 桌面实机 smoke、企业 canary、回滚准备、安全与高风险变更审核，全部标记为 `passed` 并附可追溯证据。
- 风险摘要和高风险变更列表；无高风险变更时列表可以为空，但摘要仍必须明确说明。

默认文件刻意处于 `UNRELEASED` / `pending` 状态，因此不能被意外用来发版。不要通过修改 workflow 或伪造证据绕过该门禁；需要补充审核项时先扩展 `scripts/verify-release-attestation.mjs` 的 required checks。

## 0. 发布原则

- 发布源必须是 `origin/internal` 上的明确 commit；不要从本地脏树、过期 tag 或临时构建目录发版。
- 桌面端、企业服务器、GitHub Release 三者必须同步到同一版本号。
- 企业服务器升级必须先跑 canary，canary 通过后才允许切换生产 systemd。
- GitHub Actions 失败时必须查明是代码、脚本、Secrets、runner/账单还是服务器权限问题，不能把失败的自动化当作已发布。

## 0.1 LSTC 版本门禁

LSTC 指 Long-term Stable Channel。标记为 LSTC 的版本必须比普通 patch 版本多满足：

- 企业一键包 `manifest.json.releaseChannel` 必须是 `lstc`。
- 企业一键包 `manifest.json.database.schemaTo` 必须等于 `packages/server/src/enterprise/db.ts` 中的 `ENTERPRISE_SCHEMA_VERSION`。
- `deployment/enterprise-oneclick/tools/health-check.mjs` 必须检查当前源码的 `ENTERPRISE_API_VERSION` 和 `ENTERPRISE_SCHEMA_VERSION`。
- `deployment/enterprise-oneclick/tools/verify-release.mjs` 必须拒绝缺少 `releaseChannel: "lstc"` 或 schema 目标过旧的包。
- Release 说明必须明确写出 `LSTC`、发布 commit、企业包 SHA-256、服务器 health 结果和桌面安装包体积状态。

## 1. 源码状态

```bash
git fetch origin
git status --short --branch
git log --oneline --decorate -5
git log --oneline HEAD..origin/internal
```

必须满足：
- 当前分支是 `internal`，且和 `origin/internal` 对齐。
- 工作树干净；如果有未提交文件，必须明确属于本次 release 并已 commit。
- `HEAD..origin/internal` 为空；否则先合入远端最新提交。
- 不重写已发布 tag；如果 tag 指错，开新 patch 版本。

## 2. 版本一致性

```bash
node -p "require('./package.json').version"
node -p "require('./packages/desktop/package.json').version"
```

必须满足：
- 根 `package.json` 和 `packages/desktop/package.json` 版本一致。
- Release tag 使用 `vX.Y.Z`。
- GitHub Release 标题、桌面安装包名、企业包名、服务器 `/enterprise/health.version` 使用同一版本。

## 3. 问题回归

发布前必须逐条复核本版本修过的问题，至少覆盖：
- 旧版本升级后是否能自动恢复已修复问题。
- 企业账号、个人账号、未登录账号的权限边界是否符合预期。
- 宏创园区入口、企业树、企业记忆、A2A、企业私聊、未读提醒是否没有被 capability gate 误伤。
- 旧服务器能力缺失时，客户端是否显示可理解错误，而不是白屏或崩溃。

每个问题必须记录：
- 问题标题或 issue 编号。
- 对应 commit。
- 验证命令或实机验证结果。
- 是否需要服务器同步升级。

## 4. 本地验证顺序

先跑低成本检查，再跑重检查：

```bash
npm run doctor
git diff --check
npm run typecheck --workspace=packages/core
npm run typecheck --workspace=packages/server
npm run typecheck --workspace=packages/desktop
npx vitest run packages/core/src/telemetry/metrics.test.ts packages/core/src/telemetry/loggers.test.ts packages/desktop/src/main/enterprise-client.test.ts packages/server/src/enterprise/server.test.ts
```

如果改动涉及共享协议、企业服务、桌面 preload/main/renderer 边界，再加：

```bash
npm run build --workspace=packages/server
npm run build --workspace=packages/desktop
```

规则：
- 失败即停止发版。
- 跳过任何测试都必须写明原因。
- 只跑 focused tests 时，要说明为什么 blast radius 不需要全量测试。

## 5. 桌面安装包

正式桌面 release 必须执行：

```bash
npm run release --workspace=packages/desktop
```

必须满足：
- mac arm64 DMG 已生成
- mac x64 DMG 已生成
- Windows x64 installer 已生成
- `latest.json` 的 sha256 与实际资产一致

必须记录桌面安装包体积；包体增长异常时先查 `app.asar`、Electron Framework、`node_modules` 最大项，不得为了体积删除运行时必需文件。

## 6. 企业服务器发布包

构建企业包：

```bash
node scripts/build-enterprise-oneclick.mjs
sha256sum deliverables/otto-enterprise-oneclick-vX.Y.Z-*.tar.gz
cat deliverables/otto-enterprise-oneclick-vX.Y.Z-*.tar.gz.sha256
```

必须满足：
- `verify-release.mjs` 通过。
- `manifest.json.sourceCommit` 是本次要发布的 commit。
- `sourceTreeDirty` 为 `false`。
- 包内包含 `server.js` 直接或间接 import 的所有运行时模块。
- 最小 `otto-core` adapter 导出企业服务器实际使用的符号。

企业包改动后必须至少跑一次解包 canary：

```bash
tar -xzf deliverables/otto-enterprise-oneclick-vX.Y.Z-*.tar.gz -C /tmp/otto-enterprise-check
node /tmp/otto-enterprise-check/otto-enterprise-oneclick-vX.Y.Z-*/tools/verify-release.mjs \
  /tmp/otto-enterprise-check/otto-enterprise-oneclick-vX.Y.Z-*/release
```

## 7. GitHub Release

创建或更新 Release 前检查：

```bash
gh auth status
gh release view vX.Y.Z --json tagName,targetCommitish,isDraft,assets,url
gh run list --limit 8
```

必须满足：
- Release 资产名和本次实际部署包一致。
- `.tar.gz` 和 `.sha256` 同时上传。
- 替换已发布资产时，必须删除旧资产并重新上传新资产。
- 如果 Actions job `steps: []` 且 runner id 为空，这是 runner/账单/额度层失败，不是脚本通过。

## 8. 企业服务器升级

优先使用 `.github/workflows/deploy-server.yml`；GitHub runner 不可用时才手工部署。

手工部署必须按顺序做：
1. 上传包到远端临时目录。
2. 远端 `sha256sum -c`。
3. 解包并运行 `tools/verify-release.mjs`。
4. 复制生产 `data.db` 到隔离 canary 目录。
5. 用新 release 启动 `127.0.0.1:17777` canary。
6. canary `/enterprise/health` 必须返回新版本。
7. 备份当前 systemd drop-in、运行 env、`data.db*`。
8. 停止 `otto-enterprise`。
9. 切换 release 目录和 systemd drop-in。
10. `systemctl daemon-reload && systemctl start otto-enterprise`。
11. 本机和公网 health 都必须返回新版本。

验收命令：

```bash
systemctl is-active otto-enterprise
curl -fsS http://127.0.0.1:7778/enterprise/health
curl -skS https://59.110.154.44:7777/enterprise/health
```

必须看到：
- `status: ok`
- `version: X.Y.Z`
- `apiVersion` 等于当前源码定义
- `db: connected`
- `capabilities` 包含本版本客户端需要的能力

## 9. 发布后验证

发布后必须做一次真实客户端验证：
- 启动当前桌面客户端。
- 登录企业账号。
- 展开企业树。
- 打开宏创园区面板。
- 检查企业记忆列表。
- 检查企业消息/未读轮询不再报“服务器版本过旧或功能不完整”。

最后记录：
- 发布 commit。
- GitHub Release URL。
- 企业服务器 buildCommit。
- 服务器备份目录。
- 桌面安装包大小。
- 未解决风险。

## 10. 回滚规范

回滚前先判断是否已有新业务写入。

允许快速回滚的条件：
- 新版本刚切换，未产生新注册、企业邀请、工单、消息、记忆写入。
- 旧 release 目录和 `data.db*` 备份完整。

禁止直接回滚的条件：
- 新版本已接收业务写入。
- 数据 schema 已升级且旧服务不支持。
- 备份不完整。

回滚动作必须留下记录：
- 回滚原因。
- 回滚到的 release/buildCommit。
- 使用的备份目录。
- 回滚后 health 结果。
