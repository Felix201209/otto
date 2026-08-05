# Otto Enterprise 私有化部署包

这是一套面向 Ubuntu 22.04/24.04 的“上传、填配置、执行一条安装命令”迁移包。它会安装固定并校验过 SHA-256 的 Node.js 22 LTS、最小企业服务、systemd 单元，并可选配置 Caddy HTTPS。

它不会携带任何生产数据库、手机号、短信密钥、管理员密码或平台令牌。旧服务器的数据要用包内 `export-migration.sh` 单独导出。

## 安全边界

- 只支持 `amd64/x86_64` 与 `arm64/aarch64`。
- 默认面向全新服务器。完全相同 build 重跑时只验收、不重启；检测到不同的现有 Otto 安装会拒绝覆盖。
- 这是“当前服务器原样迁入新机器”的过渡发布包。实际可导入版本及目标版本以同一发布包内 `release/manifest.json` 的 `database.schemaFrom`、`database.schemaTo` 为准，安装器会在隔离副本上迁移并拒绝未声明或未来版本。
- 数据导出使用 SQLite Online Backup API，不直接复制正在写入的 `data.db`。
- 导入先在隔离目录迁移，再在 `127.0.0.1:17777` 启动 canary；schema、外键、数据行数和 health 全部通过后才安装。
- 服务只监听 `127.0.0.1:7778`，公网必须经过 HTTPS 反向代理。
- 未完成的本机配对接口在 Caddy 边缘固定返回 404。
- `managed` 模式会验收公网 HTTPS 和三个 404；`external` 模式只验收本机 systemd/health，不能据此宣称公网已完成。
- 不自动修改 DNS、云安全组或 UFW。
- 迁移包是包含账号、手机号、会话和企业密钥的敏感文件，默认权限为 0600；传输完成后请妥善删除。
- 外层 SHA-256 与包内清单用于发现传输损坏；正式包还必须携带 Ed25519 `.sig`，并使用从独立可信渠道取得的 Otto 发布公钥验签，不能信任签名文件自行提供的公钥。
- 正式写入前会创建 `/opt/otto-enterprise/.installing` 事务标记；断电或 `SIGKILL` 后标记会保留，重跑将 fail closed，避免把半安装状态当成新服务器。

## 一、在旧服务器导出

先把本压缩包上传到旧服务器并解压，然后确认实际数据库位置。当前标准安装位置是 `/var/lib/otto-enterprise/data.db`。

只读预检：

```bash
./export-migration.sh \
  --data-dir /var/lib/otto-enterprise \
  --output /root/otto-enterprise-migration.tar.gz \
  --dry-run
```

正式在线快照：

```bash
sudo ./export-migration.sh \
  --data-dir /var/lib/otto-enterprise \
  --output /root/otto-enterprise-migration.tar.gz
```

得到两个文件：

```text
/root/otto-enterprise-migration.tar.gz
/root/otto-enterprise-migration.tar.gz.sha256
```

导出不会停止或修改旧服务。为了最终切换时不丢写入，建议在短维护窗口内先停止旧服务，再做最后一次导出：

```bash
sudo systemctl stop otto-enterprise
sudo ./export-migration.sh \
  --data-dir /var/lib/otto-enterprise \
  --output /root/otto-enterprise-final.tar.gz
```

如果新服务器没有通过验收，立即重新启动旧服务：

```bash
sudo systemctl start otto-enterprise
```

不要把旧 `/etc/otto-enterprise/enterprise.env` 放进迁移压缩包。短信密钥应通过你自己的安全渠道单独复制到新配置。

## 二、准备新服务器

1. 使用 Ubuntu 22.04 或 24.04。
2. 为最终域名添加 A/AAAA 记录，指向新服务器。
3. 云安全组至少开放 TCP `80`、`443`、`7777`。
4. 上传：
   - 本一键部署压缩包；
   - 最终迁移包；
   - 迁移包 `.sha256`。
5. 不要提前关闭旧服务器；保留它作为切回点。

正式包必须同时带有 `.sig`。先从 Otto 单独维护的可信渠道取得 Ed25519
公钥，再校验发布者身份；签名文件内不会携带或选择公钥：

```bash
node verify-enterprise-package-signature.mjs \
  otto-enterprise-oneclick-v*-*.tar.gz \
  otto-enterprise-oneclick-v*-*.tar.gz.sig \
  /安全路径/otto-enterprise-release-public.pem
```

然后校验传输完整性：

```bash
sha256sum -c otto-enterprise-oneclick-v*-*.tar.gz.sha256
```

`.sha256` 只负责发现传输损坏，不能替代 Ed25519 发布者签名。若签名、公钥或
校验器缺少任意一项，不应把该包用于正式服务器。

校验成功后再解压：

```bash
tar -xzf otto-enterprise-oneclick-v*-*.tar.gz
cd otto-enterprise-oneclick-v*-*
```

## 三、填写配置

```bash
cp config/enterprise.env.example ./enterprise.env
nano ./enterprise.env
chmod 600 ./enterprise.env
```

必须修改：

- `OTTO_PUBLIC_HOST`：最终企业域名；
- 阿里云短信四项：`ACCESS_KEY_ID`、`ACCESS_KEY_SECRET`、签名和模板；
- 若不用包管理 Caddy，把 `OTTO_CADDY_MODE` 改为 `external`。

园区报修通知为可选配置：

- `ALIYUN_SMS_NOTIFICATION_TEMPLATE_ID`：报修短信通知模板；它与注册验证码的 `ALIYUN_SMS_TEMPLATE_ID` 分开配置；
- `OTTO_ENTERPRISE_FEISHU_APP_ID` 与 `OTTO_ENTERPRISE_FEISHU_APP_SECRET`：必须成对填写，服务端只从 0600 运行配置读取；
- `OTTO_ENTERPRISE_FEISHU_DOMAIN`：`feishu` 使用飞书中国站，`lark` 使用 Lark 国际站，留空默认飞书中国站。

这些可选项留空不会阻止报修记录写入，但对应的外部通知通道不会发送。安装器会把它们写入 `/etc/otto-enterprise/enterprise.env`，不会放进迁移包或日志。

`OTTO_ENTERPRISE_ADMIN_TOKEN=auto` 会生成不输出到日志的随机平台令牌。迁移库已有管理员账号时不会重建账号；空库会生成一次性管理员密码，安装结束后只写到 `/root/otto-enterprise-bootstrap-*.txt`。

`external` 表示你自行管理 Nginx/Caddy/负载均衡器。安装器不会验证外置证书、公网 health 或 404 屏蔽规则，完成提示也会明确标为“待外置代理验收”。

正式迁移不要把 `OTTO_ALLOW_SMS_DISABLED` 设为 `1`。短信未配置时，邀请码注册必然不可用，安装器会默认阻断。

## 四、一条命令安装

先做不写盘预检：

```bash
./install.sh \
  --config ./enterprise.env \
  --migration /root/otto-enterprise-final.tar.gz \
  --dry-run
```

dry-run 会校验包内每个文件、release manifest、迁移归档、SQLite `quick_check`、外键、schema 和隔离副本数据对账。若机器没有兼容 Node，它可能把固定 Node runtime 下载到私有临时目录并在成功后删除；不会写 `/etc`、`/opt`、`/var/lib`，也不会创建用户或操作服务。若机器同时没有 Node、`curl` 或 CA 证书，dry-run 会给出明确错误，不会自行运行 `apt`。

正式安装：

```bash
sudo ./install.sh \
  --config ./enterprise.env \
  --migration /root/otto-enterprise-final.tar.gz
```

安装器会依次完成：

1. 验证 Ubuntu、架构、磁盘、域名、短信配置、`PACKAGE-MANIFEST.sha256` 和迁移包；
2. 下载 Node.js `v22.23.1` 并核对官方 SHA-256；
3. 校验最小 release 文件集合和每个文件的 SHA-256；
4. 校验迁移数据库 `quick_check`、外键和 schema；
5. 按发布清单在隔离副本上迁移到该包声明的目标 schema，并逐表对账；旧 schema 数据库会先保留在线一致性快照，迁移后任一原有表行数减少都会阻断安装；
6. 启动 `127.0.0.1:17777` canary；
7. 安装专用 `otto-enterprise` 用户、只读 release 和 0600 运行配置；
8. 启动 systemd 服务；
9. 可选安装/验证/重载 Caddy；
10. 验证公网 HTTPS、精确版本、短信状态和三个 404 屏蔽路径。

## 五、验收

本机验收：

```bash
sudo /opt/otto-enterprise/deploy/verify.sh
sudo systemctl status otto-enterprise --no-pager
sudo journalctl -u otto-enterprise -n 100 --no-pager
```

公网 health：

```bash
curl --fail --show-error \
  https://你的域名:7777/enterprise/health
```

上面的公网验收只适用于 `managed` 模式。`external` 模式必须在外置代理配置完成后手动执行同等 health 与三个 404 检查。

必须看到：

- `status: ok`
- `apiVersion: 4`
- `schemaVersion` 必须与本次 release manifest 的 `database.schemaTo` 一致
- `db: connected`
- `sms.configured: true`
- `capabilities` 同时包含 `personal_enterprise_upgrade`、`direct_messages`、`atoa`、`position_invites`、`park_service_push`、`park_repair_v1`、`data_protection_v1`、`encrypted_attachment_storage_v1`、`encrypted_message_storage_v1`、`signed_telemetry_transport_v1`

浏览器验收：

1. 打开 `https://你的域名:7777/enterprise/admin`；
2. 用迁移前的管理员账号登录；
3. 核对企业、账号和成员数量；
4. 打开已有邀请落地页，确认不是 404/410；
5. 用修复后的 Otto 客户端完成一次“邀请链接 → 短信注册 → 进入工作区 → 展开企业组织树”；
6. 确认真实账号看到服务端组织，而不是机器上残留的本机树。
7. 用两个测试账号互发一条私聊，再发起一次 A2A 请求；确认接收方明确同意后才执行，且请求方收到结果；
8. 用成员账号提交一次园区报修，确认管理员可见；若配置了短信或飞书通知，再核对对应通道真实收到通知；
9. 用管理员向测试成员推送一次园区服务，确认成员消息中可读。

注意：管理员手动“生成新邀请”会立即废止旧邀请。若只是迁移验收，不要无意点击生成按钮。

## 六、切换与回退

新服务器全部通过后再恢复业务写入。旧服务器建议保持停止但不删除至少 7 天。

若新服务器在恢复写入前失败：

1. 将 DNS 指回旧服务器；
2. `sudo systemctl start otto-enterprise` 启动旧服务；
3. 保留新服务器 `/var/tmp/otto-enterprise-deploy-*` 失败目录供排查。

一旦新服务器已经接收新注册、邀请码或业务写入，不能直接回到旧数据库，否则会丢失这段时间的数据。此时应先重新导出新库，再制定明确的数据恢复方案。

## 七、安装被中断，看到 `.installing`

不要直接删除标记并重跑。先检查：

```bash
sudo cat /opt/otto-enterprise/.installing
sudo systemctl status otto-enterprise --no-pager
sudo readlink -f /opt/otto-enterprise/current
sudo ls -la /opt/otto-enterprise /var/lib/otto-enterprise /etc/otto-enterprise
sudo ls -ld /var/tmp/otto-enterprise-deploy-*
```

若服务已启用，先停止它；保留 `/var/tmp/otto-enterprise-deploy-*` 和数据库副本。确认这是未接收任何业务写入的新服务器后，按事务目录中的失败文件恢复或清理，再移除标记。对状态没有把握时不要覆盖安装，直接把上述输出交给维护者。

## 八、验证边界

构建包内 `BUILD-INFO.json`、`SOURCE-INPUTS.sha256`、`PACKAGE-MANIFEST.sha256` 和 release manifest 记录了源状态与实际交付内容。`sourceTreeDirty=true` 表示包来自尚未提交的工作树；这不改变内容哈希校验，但不能冒充“可由某个 Git commit 单独复现”。

本包在 macOS 上完成了语法、清单、release、SQLite 迁移、未来 schema 拒绝和本地隔离 canary 验证。Ubuntu 22.04/24.04 × amd64/arm64 的 systemd、apt、Caddy 和真实公网证书必须在目标机执行安装器自验，未跑目标机前不能声称该矩阵已经实机通过。

## 九、备份、恢复与容量保护

服务默认每 24 小时创建一份在线一致性快照，保留 30 天且至少保留 3 份。备份包含
SQLite、加密附件对象、账号同步密钥、附件密钥和消息字段密钥，外层再使用 AES-256-GCM 加密；
`/enterprise/health` 的 `dataProtection` 会显示最近成功时间、文件 SHA-256、失败原因、
磁盘余量和异地副本状态。

手动备份：

```bash
sudo /opt/otto-enterprise/deploy/backup-now.sh
```

恢复前会先完成解密认证、SQLite `quick_check`、外键和 schema 校验。恢复后服务不健康时
脚本会自动换回恢复前数据：

```bash
sudo /opt/otto-enterprise/deploy/restore-backup.sh \
  /var/lib/otto-enterprise/backups/otto-enterprise-*.otto-backup
```

`OTTO_BACKUP_ENCRYPTION_KEY` 必须由客户和交付方按合同约定离线托管；只剩备份文件但
丢失该密钥时无法解密。需要异地副本时，将 NFS、对象存储网关或备份卷挂载到
`/var/backups/otto-enterprise`，再设置
`OTTO_BACKUP_REPLICA_DIR=/var/backups/otto-enterprise`。异地副本写入后会重新计算
SHA-256，上传或复制失败不会阻断 Otto 业务，但会进入健康状态告警。

高安全部署可以预先创建三个恰好 32 字节的原始密钥文件，并在配置中填写
`OTTO_ACCOUNT_SYNC_ENCRYPTION_KEY_FILE`、`OTTO_ATTACHMENT_ENCRYPTION_KEY_FILE`、
`OTTO_FIELD_ENCRYPTION_KEY_FILE`。文件必须使用绝对路径、不能是符号链接，并且
`otto-enterprise` 服务账号必须可读；恢复时外部密钥与备份不一致会 fail closed，安装器
不会替客户覆盖密钥。私聊正文以及 License 内的租约令牌、遥测令牌均使用字段密钥
AES-256-GCM 加密，服务启动时会先迁移旧明文数据并验证密钥，失败时拒绝对外提供服务。

如配置 `OTTO_TELEMETRY_ENDPOINT`，地址必须使用 HTTPS。遥测请求除 Bearer 令牌外还
携带 HMAC-SHA256 签名、时间戳和一次性随机数；接收端只接受 5 分钟窗口内且未重放的
请求，本地遥测保留期由 `OTTO_TELEMETRY_RETENTION_DAYS` 控制。正式交付前必须填写
`OTTO_DATA_CONTROLLER_NAME` 和 `OTTO_PRIVACY_CONTACT`，
并确认 `OTTO_DATA_REGION`、`OTTO_DATA_RESIDENCY` 与
`OTTO_CROSS_BORDER_DATA_ENABLED` 符合客户实际数据流。只有数据目录所在磁盘已经启用
LUKS、云盘加密卷或等价保护后，才能把 `OTTO_STORAGE_VOLUME_ENCRYPTED` 设为 `true`；
否则管理页会持续显示未达到数据治理就绪状态。

聊天附件不再以大 BLOB 写进 SQLite，而是以 AES-256-GCM 加密对象写入
`/var/lib/otto-enterprise/attachments`。大客户可把该目录映射到持久卷、MinIO/S3 网关
或客户对象存储；数据库只保存受控对象键，不保存任意文件路径。

建议每季度在隔离服务器执行一次真实恢复演练，并记录恢复点目标（默认 24 小时）和
恢复时间目标。磁盘可用空间低于 `OTTO_DISK_MIN_FREE_MB` 时 health 会告警，空间不足以
容纳校验副本时新备份会拒绝执行，但现有业务数据不会被自动删除。

License 验签支持多把 Ed25519 公钥并行。`OTTO_LICENSE_PUBLIC_KEYS` 可以填写 PEM 数组，
也可以填写 Otto Control `GET /v1/signing-keyring` 返回的完整 JSON；客户端会接受
`active`、`standby` 和 `retired` 公钥，因此密钥轮换后历史 License 仍可验证，并自动排除
`revoked` 公钥。紧急处置还可通过 `OTTO_LICENSE_REVOKED_KEY_IDS` 填写 JSON 数组或
逗号分隔的 16 位 key ID。更新这两个配置前必须先用已信任公钥验证控制面密钥环签名，
不能把 HTTPS 下载结果直接当作新的信任根。在线 License 还会在下一次短租约刷新时由
控制面检查签名密钥状态；离线 License 无法实时接收吊销，必须使用较短有效期并由交付
流程同步吊销清单。

### 签名执行收据与积分结算

在线商业部署不再向旧的 `/v1/billing/usage/consume` 发送无签名用量。Otto Server 会为
每个部署生成独立 Ed25519 执行收据密钥，私钥使用字段加密密钥进行 AES-256-GCM 加密，
只保存在客户服务器；Control 只登记公钥。管理员可从
`/enterprise/deployment/status` 的 `billing.executionReceipt.key` 读取 key ID 和公钥，
再由两名具备 `billing.manage` 权限的 Control 管理员完成登记审批。

每条收费任务会先写入 `billing_usage_outbox`，再按部署连续序号上传到
`/v1/billing/execution-receipts`。第一条失败时后续收据不会越过它；服务重启或网络恢复后
仍按原顺序补传，相同任务和相同收据不会重复扣费。收据只包含部署、组织、模块、模型、
计量单位和不透明任务 ID，不包含提示词、回复、聊天、文件名、会议内容或个人身份信息。
升级时尚未发送的旧用量会在本地转换为 v2 收据，已经结算的历史记录不会重复转换。

收据有效期最长七天。持续离线超过七天会让队首收据进入需人工对账状态，不能通过跳号
绕过；正式交付应对 `billing.failed` 和 `billing.lastError` 配置告警。字段加密密钥必须与
数据库一起备份，丢失该密钥将无法继续使用原收据签名身份。

## 十、常见问题

### Caddy 证书申请失败

检查：

```bash
getent ahosts 你的域名
sudo systemctl status caddy --no-pager
sudo journalctl -u caddy -n 100 --no-pager
```

确认 DNS 已指向新服务器，且云安全组开放 80、443、7777。安装器不会替你修改这些外部资源。

### 邀请码能打开，但收不到验证码

查看 health 中 `sms.configured`。若为 `false`，说明短信四项没有进入 `/etc/otto-enterprise/enterprise.env`。不要用 `OTTO_ALLOW_SMS_DISABLED=1` 绕过正式迁移验收。

### 客户端仍没有组织树

旧 v1.8.6 客户端把“免登录 UI”错误地同时当成了“禁用企业网络”，并且组织树只看本机 ProductWorkspace。必须使用 v1.8.7 或更新客户端：交付版默认恢复真实登录；邀请 intent 会进入注册并显示目标企业服务器；真实企业账号始终读取 `/enterprise/organization/view`，即使本机 ProductWorkspace 尚未连接也能加载组织树。

### 想把本包覆盖到已有不同版本

不要修改安装脚本绕过检查。这个包是“新服务器迁入包”，不同版本升级需要单独的备份、canary、兼容矩阵和回滚计划。
