# Otto 1.9.13 过渡版本发布说明

## 发布目标

1.9.13 是面向现有 1.9.x 用户的短生命周期过渡版本。它以最新 `origin/internal` 为祖先，完整保留 1.9.12 已发布能力，并加入已验证的空闲计费、安全重放、私有部署和 License 回滚修复。它不把实验功能分支直接变成发布源。

## 纳入的分支

- `origin/internal`：权威产品基线，提交 `30e2adab7bf9d647ff69965bbbbcf1044b3e3014`。
- `origin/release/1.9.12-transition`：七个已发布增量，包括托管模型令牌、企业模型网关、SQLCipher 原生运行时、更新清单、制品来源和过渡签名策略。完整继承以避免 1.9.12 升级回退。
- `origin/fix/background-model-zero-default`：十二个安全补丁，包括默认关闭后台付费模型任务、默认手动工具授权、备份密钥 fail-closed、隐藏/退出取消任务、断线队列 allowlist、原子记忆/知识写入、模型请求结果未知保护、空闲轮询收敛和 A2A 结果持久化。
- `origin/agent/private-deployment-center-1.10.2-final`：五个按依赖顺序重放的单服务器私有部署补丁，包括一次性登记 Secret 文件、自动企业/CEO 开通、License 防回滚和商业计费幂等。

## 已核对但不重复合并的分支

- 1.9.11、SQLCipher、MLS 附件、macOS 集成和服务器集成分支的有效能力已由 `internal` 或 1.9.12 重写吸收；再次合并会恢复旧版本号或旧 UI。
- E2EE/OpenMLS 与旧设备信任分支已由当前 MLS 权威实现取代，正式 E2EE 门禁仍保持 fail-closed。
- 企业邀请码的十二位混合大小写校验已存在于当前登录页和回归测试中。

## 本版本明确排除

- `feat/self-service-enterprise-verification`：仍是独立产品功能 PR，不属于过渡安全补丁。
- 旧双 UI、协会版隐藏入口、RPA Recorder、Rust Core、旧 Web 原型及其他落后实验分支。
- 未经正式 E2EE 门禁批准的协议切换。

这些排除项防止无关代码、依赖和资源进入安装包。

## 更新兼容与体积预算

- `1.9.12 < 1.9.13` 有独立回归测试；`1.10.1` 等更高开发版本不会被降级。
- 更新清单继续使用固定 HTTPS 镜像、平台精确资产名、真实文件大小和 SHA-256。
- 1.9.12 的 `236,706,516` 字节安装包错误包含 Rust `target/debug` 和 SQLite 编译中间文件，不能作为正常体积基线。
- 1.9.13 改用已正式发布且内容正常的 1.9.11 Windows 安装包 `125,255,674` 字节作为基线，最多允许上涨 12 MiB；实际有效上限是 `137,838,586` 字节（约 131.45 MiB）。
- Windows 包必须排除 Rust `target`、原生源码、嵌套开发依赖以及 `better-sqlite3` 编译目录；SQLCipher 只通过经过能力探测和校验的独立 `resources/sqlcipher/better_sqlite3.node` 交付。
- 体积与更新清单门禁在安装包生成后执行，测试文件、源码映射、文档、覆盖率和开发目录继续被排除。

## 发布约束

过渡渠道只有在显式选择 `release_channel=transition` 与 `unsigned_transition=true` 时才允许未签名制品。正式稳定渠道仍强制 Windows Authenticode、Apple Developer ID/公证和企业 Ed25519 签名。SQLCipher 来源、原生加载、SBOM、SHA-256、更新清单和服务器 canary 不因过渡渠道而跳过。
