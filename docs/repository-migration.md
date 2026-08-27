# Otto 仓库迁移与更新兼容策略

## 仓库角色

- `NSIETeam/otto-new`：唯一可写源码仓、默认开发推送目标、正式 GitHub Release 仓。
- `Felix201209/otto`：旧源码仓，只保留历史查询，不再接收提交、分支或标签。
- `Felix201209/otto-releases`：旧客户端兼容发布仓，不属于“旧源码仓只读”的范围。兼容期内必须继续接收与正式 Release 完全相同的安装包和 `latest.json`。
- `https://59.110.154.44:7777/otto-releases/latest.json`：V1.9.11 至 V1.9.13 的首选更新入口，必须长期可用并保持原子更新。

## 发版不变量

1. Release 源提交必须存在于 `NSIETeam/otto-new`，且包含最新 `origin/internal`。
2. 安装包、企业服务包、签名、校验和与 `latest.json` 必须由同一次工作流构建。
3. 工作流先创建新旧两个草稿，再完成验签、企业部署和服务器镜像原子切换。
4. 全部门禁通过后，先公开旧客户端兼容 Release，再公开 `NSIETeam/otto-new` 正式 Release。
5. 任一兼容发布失败都必须使整次发版失败；不得只更新新仓后宣称老用户可正常更新。

## Secret 迁移门禁

GitHub 不允许读取或复制既有 Secret 的值。启用新仓发版前，仓库管理员必须在 `NSIETeam/otto-new` 配置 `.github/workflows/README.md` 列出的签名、许可证与部署 Secret，并额外配置 `OTTO_LEGACY_RELEASES_TOKEN`。该令牌只授予 `Felix201209/otto-releases` 的 Contents 写权限。

## 结束兼容期

只有在遥测或支持台数据能够证明所有仍受支持的安装版本都已升级到包含 `NSIETeam/otto-new` 更新入口的桥接版本后，才可另行评审停止旧发布仓同步。旧源码仓可以先只读，但不得因此归档或停用旧发布仓。
