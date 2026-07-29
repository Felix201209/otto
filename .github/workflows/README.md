# GitHub Actions Workflows

Otto 的发布链路分成三段：先检查异常，再构建 GitHub Release 草稿，最后在 Release 正式发布后同步企业服务器。

发布前必须先完成 `docs/release-preflight.md`；本文件只说明 Actions 如何执行，不替代发布门禁。

## 当前正式发布门禁

- 发布源提交必须与远端 `origin/internal` 最新提交完全相同，旧 tag、落后分支和未合并分支不能生成正式版本。
- 根目录与桌面端版本号必须一致，企业运行时 schema、清单、构建信息均从同一提交生成。
- macOS 必须通过 Developer ID 签名、公证和 stapler 验证；Windows 必须通过 Authenticode 验证。
- 企业一键部署包必须带外置可信公钥可验证的 Ed25519 `.sig`，只有 SHA-256 不允许发布。
- 正式发布顺序是：构建并验签草稿 -> 部署企业服务 -> 原子更新国内镜像 -> 公开 Release。任一步失败都不会公开新版本。

## CI

文件：`.github/workflows/ci.yml`

触发：

- PR 到 `internal` / `main`
- push 到 `internal`

主要检查：

- `npm run doctor`
- `git diff --check`
- 主链路 build
- workspace typecheck
- core/server/cli/desktop tests
- release 关键回归测试：桌面企业客户端、packaging contract、server、enterprise server

## Release Build

文件：`.github/workflows/release.yml`

触发：

- push tag：`v*.*.*`
- 手动 `workflow_dispatch`

输出：

- `Otto-<version>-arm64.dmg`
- `Otto-<version>-x64.dmg`
- `Otto-Setup-<version>-win-x64.exe`
- blockmap
- `latest.json`
- `otto-enterprise-oneclick-v<version>-<build>.tar.gz`
- `.sha256`
- `.sig`

规则：

- 根 `package.json` 与 `packages/desktop/package.json` 必须等于目标版本。
- 桌面安装包必须存在，并随 `latest.json` 一起发布用于校验和更新。
- Release 默认创建为 draft。人工确认后发布，发布事件会触发服务器部署 workflow。

## Deploy Server

文件：`.github/workflows/deploy-server.yml`

触发：

- 当前仓库 Release published
- 手动 `workflow_dispatch`

行为：

- 下载对应版本的 `otto-enterprise-oneclick` 包和 sha256。
- 上传到目标服务器 `/var/tmp/otto-enterprise-github/...`。
- 如果目标机已有 `/opt/otto-enterprise/current`，执行 `upgrade.sh`。
- 如果是新服务器，执行 `install.sh`。
- 支持手动 dry-run。

目标服务器要求：

- Ubuntu 22.04/24.04
- systemd
- 部署用户可免密 `sudo`
- 已有部署应由 one-click current symlink 管理

## Required Secrets

发行签名：

- `MAC_CSC_LINK`、`MAC_CSC_KEY_PASSWORD`
- `WIN_CSC_LINK`、`WIN_CSC_KEY_PASSWORD`
- `APPLE_ID`、`APPLE_APP_SPECIFIC_PASSWORD`、`APPLE_TEAM_ID`
- `OTTO_ENTERPRISE_SIGNING_PRIVATE_KEY`、`OTTO_ENTERPRISE_SIGNING_PUBLIC_KEY`
- `OTTO_LICENSE_PUBLIC_KEYS`（JSON 数组或单个 Ed25519 SPKI 公钥；私钥不得进入仓库或客户服务器）
- `OTTO_RELEASES_TOKEN`

部署服务器：

- `DEPLOY_HOST`
- `DEPLOY_USER`
- `DEPLOY_SSH_KEY`

可选：

- `DEPLOY_PORT`，默认 `22`
- `DEPLOY_CONFIG_PATH`，默认 `/etc/otto-enterprise/enterprise.env`

Release 默认使用当前仓库的 `GITHUB_TOKEN`。如果未来要发布到独立 release 仓库，需要同时修改 workflow 的 `RELEASES_REPO` 和 token。

## Manual Release

```bash
VERSION="$(node -p "require('./package.json').version")"
git tag "v${VERSION}"
git push origin "v${VERSION}"
```

等待 `Release Build` 生成 draft release。检查资产和体积后，在 GitHub Release 页面点 Publish。发布后 `Deploy Enterprise Server` 会自动同步服务器。

## Manual Server Dry Run

Actions -> Deploy Enterprise Server -> Run workflow：

- `version`: 必须与根目录及桌面端 `package.json` 的版本完全一致
- `dry_run`: true

dry-run 只会在目标机解包、校验、迁移 canary 和 health，不切换生产 `current`。
