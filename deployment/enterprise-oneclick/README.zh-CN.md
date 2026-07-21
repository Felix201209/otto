# Otto Enterprise v1.9.2 新服务器迁移包

这是一套面向 Ubuntu 22.04/24.04 的“上传、填配置、执行一条安装命令”迁移包。它会安装固定并校验过 SHA-256 的 Node.js 22 LTS、最小企业服务、systemd 单元，并可选配置 Caddy HTTPS。

它不会携带任何生产数据库、手机号、短信密钥、管理员密码或平台令牌。旧服务器的数据要用包内 `export-migration.sh` 单独导出。

## 安全边界

- 只支持 `amd64/x86_64` 与 `arm64/aarch64`。
- 默认面向全新服务器。完全相同 build 重跑时只验收、不重启；检测到不同的现有 Otto 安装会拒绝覆盖。
- 这是“当前服务器原样迁入新机器”的包，数据导入接受生产 schema v2、v3 或 v4，并在隔离副本上统一迁移到 v4；更旧 schema 必须先在旧服务器走单独的受控升级。
- 数据导出使用 SQLite Online Backup API，不直接复制正在写入的 `data.db`。
- 导入先在隔离目录迁移，再在 `127.0.0.1:17777` 启动 canary；schema、外键、数据行数和 health 全部通过后才安装。
- 服务只监听 `127.0.0.1:7778`，公网必须经过 HTTPS 反向代理。
- 未完成的本机配对接口在 Caddy 边缘固定返回 404。
- `managed` 模式会验收公网 HTTPS 和三个 404；`external` 模式只验收本机 systemd/health，不能据此宣称公网已完成。
- 不自动修改 DNS、云安全组或 UFW。
- 迁移包是包含账号、手机号、会话和企业密钥的敏感文件，默认权限为 0600；传输完成后请妥善删除。
- 外层 SHA-256 与包内清单用于发现传输损坏或内容被改动，不是发布者数字签名。请从可信渠道向发送者核对外层 SHA-256。
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

先在压缩包所在目录校验外层压缩包：

```bash
sha256sum -c otto-enterprise-oneclick-v1.9.2-*.tar.gz.sha256
```

`.sha256` 与压缩包放在同一渠道只能证明两者一致，不能证明发送者身份。至少通过另一条可信渠道核对 64 位摘要。

校验成功后再解压：

```bash
tar -xzf otto-enterprise-oneclick-v1.9.2-*.tar.gz
cd otto-enterprise-oneclick-v1.9.2-*
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
5. 在隔离副本上迁移到 schema v4，并逐表对账；v3 数据库会先保留在线一致性快照，迁移后任一原有表行数减少都会阻断安装；
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
- `apiVersion: 3`
- `schemaVersion: 4`
- `db: connected`
- `sms.configured: true`
- `capabilities` 同时包含 `personal_enterprise_upgrade`、`direct_messages`、`atoa`、`position_invites`、`park_service_push`、`park_repair_v1`

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

## 九、常见问题

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
