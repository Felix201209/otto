# SQLite/SQLCipher 到 PostgreSQL 迁移手册

本文定义企业服务端从单机 SQLite/SQLCipher 迁移到 PostgreSQL 的导入、
校验、停机切换和回滚基线。桌面端与离线部署继续使用本机
SQLite/SQLCipher，不参与企业集群切换。

## 安全边界

- SQLite 数据库及 WAL 必须位于本地磁盘，禁止放到 NFS、SMB/CIFS 或共享盘
  供多个实例写入。
- PostgreSQL 不使用 SQLCipher。生产连接必须使用 TLS，存储卷、快照和备份
  使用云 KMS 或等效静态加密；确需服务端可检索的敏感字段再使用字段级信封
  加密。
- E2EE 消息和附件在导入前已经是客户端密文。导入器只复制密文及元数据，
  不接触客户端身份私钥、设备私钥、恢复材料或附件文件密钥。
- 执行导入前必须停止全部 SQLite 写入进程。命令只有在显式设置
  `OTTO_SQLITE_IMPORT_MAINTENANCE_CONFIRMED=true` 后才允许写入 PostgreSQL。
- 导入只写 PostgreSQL 暂存表，不会自动切换权威源。只有对 verified run
  完成独立的领域提升后，PostgreSQL 核心路由才允许使用这些数据；未迁移路由
  返回 `POSTGRES_ROUTE_NOT_MIGRATED`，绝不回落 SQLite。

## 前置条件

1. PostgreSQL 使用托管高可用写端点或主备代理，已配置复制、自动故障转移、
   备份和 PITR。
2. Redis/兼容缓存和私有 S3/MinIO 已配置；集群预检全部通过。
3. 已创建并验证 SQLite/SQLCipher 快照，快照与密钥恢复材料分开保管。
4. 已冻结企业变更窗口，并确认所有 Otto Server/旧企业服务端进程停止。

先构建并准备 PostgreSQL 控制面：

```powershell
npm run build --workspace=packages/server
$env:OTTO_ENTERPRISE_DATABASE_BACKEND = 'postgresql'
$env:OTTO_POSTGRES_URL = 'postgresql://otto:<password>@postgres-rw.internal/otto'
npm run enterprise:postgres:prepare --workspace=packages/server
npm run enterprise:infrastructure:check --workspace=packages/server
```

## 演练模式

演练模式是默认模式，只读扫描 SQLite，不连接或写入 PostgreSQL。工具按主键
顺序读取每张表；无显式主键的普通表按 `rowid` 排序。BLOB 和大整数使用带类型
的规范表示，随后计算逐行、逐表和整库逻辑 SHA-256。逻辑哈希不受 SQLite
页布局、WAL checkpoint 或 SQLCipher 随机页密文影响。

```powershell
$env:OTTO_SQLITE_IMPORT_PATH = 'D:\migration\enterprise-snapshot.db'
npm run enterprise:postgres:import --workspace=packages/server -- --dry-run --batch-size 500
```

SQLCipher 快照还必须配置只读密钥文件和对应平台的原生资产：

```powershell
$env:OTTO_SQLITE_IMPORT_ENCRYPTION = 'required'
$env:OTTO_DATABASE_ENCRYPTION_KEY_FILE = 'D:\keys\database.keyring.json'
$env:OTTO_DATABASE_ENCRYPTION_KEY_READONLY = 'true'
$env:OTTO_SQLCIPHER_NATIVE_BINDING = 'D:\otto\native\sqlcipher\win32-x64\better_sqlite3.node'
```

只有确认源快照本身是普通 SQLite 时，才显式设置
`OTTO_SQLITE_IMPORT_ENCRYPTION=disabled`。该导入源开关与 PostgreSQL 目标配置
隔离；不得为 PostgreSQL 设置 `OTTO_DATABASE_ENCRYPTION=required`。

演练输出只包含源文件名、无凭据的 PostgreSQL 目标、Schema 版本、行数和哈希；
不会输出连接密码、完整本地路径或密钥材料。保存这份 JSON 作为切换审批证据。

## 正式导入与断点续传

确认演练哈希后执行：

```powershell
$env:OTTO_SQLITE_IMPORT_MAINTENANCE_CONFIRMED = 'true'
npm run enterprise:postgres:import --workspace=packages/server -- --execute --batch-size 500
```

导入器使用 PostgreSQL advisory lock 保证同一时间只有一个导入任务。数据写入
`otto_sqlite_import_rows` 暂存表，并在 `otto_sqlite_import_tables` 保存列顺序、
主键、源行数和源哈希。每批使用 `(run_id, table_name, row_index)` 幂等写入；
中断后以相同源逻辑哈希再次执行会从连续的下一行恢复。

每张表复制完成后，导入器重新读取 PostgreSQL 中的行哈希并验证顺序、行数和
聚合哈希。全部表完成后再次扫描 SQLite；源数据在导入期间发生任何变化都会
使任务失败。只有三次校验一致，`otto_sqlite_import_runs.state` 才会变成
`verified`。失败记录只保存 `source_changed`、`verification_failed` 或
`import_failed`，不保存异常中的凭据或密钥。

## verified 数据提升

导入完成后，先对 run ID 执行只读演练：

```powershell
npm run enterprise:postgres:promote --workspace=packages/server -- --run <run-id> --dry-run
```

演练会重新检查 verified 状态、逐表行数、目标是否为空以及核心字段能否安全
转换，但最终回滚事务。确认结果后执行：

```powershell
$env:OTTO_SQLITE_IMPORT_MAINTENANCE_CONFIRMED = 'true'
npm run enterprise:postgres:promote --workspace=packages/server -- --run <run-id> --execute
```

正式提升使用 advisory lock，在单个事务内写入组织、账号、会话、组织架构、
功能开关、审计、E2EE 设备、密钥透明日志和消息密文，并记录幂等 promotion
receipt。目标已经存在账号或消息时拒绝覆盖；旧消息仍是明文时拒绝提升；存在
消息附件时也会拒绝切换，必须先通过后续 S3 附件迁移完成复制和校验。

## 停机切换

正式切换必须按以下顺序进行：

1. 进入维护模式，停止所有 SQLite 写入实例。
2. 创建最终 SQLCipher 快照并完成备份恢复抽检。
3. 对最终快照执行演练，记录整库哈希、逐表行数和逐表哈希。
4. 执行正式导入，确认任务状态为 `verified`，且正式结果与演练结果完全一致。
5. 对 verified run 先执行领域提升演练，再执行正式提升并保存 receipt。
6. 将异步 PostgreSQL 核心服务部署为单个金丝雀实例；
   配置 PostgreSQL、Redis 和 S3，不挂载 SQLite 或本地附件目录。
7. 验证登录、设备注册、E2EE 密文消息、多设备同步、附件、审计、备份和
   恢复，再逐步增加无状态实例。
8. 在回滚宽限期内保留只读 SQLite 快照及密钥，禁止删除或覆盖。

当前只有账号、组织、审计和 E2EE 核心路由完成异步 PostgreSQL Repository。
SMS 注册、邀请、知识库、园区、工单、商业控制、数据治理、附件 S3 路由及
Redis 会话/限流仍需迁移；这些路由会显式返回 503。因此只能对核心范围做
金丝雀验证，不能宣称完整企业生产切换完成。

## 回滚

在 PostgreSQL 尚未接收新业务写入时，回滚是可逆的：停止金丝雀，恢复原
SQLite 配置，以已验证的最终快照和对应密钥启动单实例，并复核整库哈希。

PostgreSQL 一旦接收新写入，旧 SQLite 快照就不再是最新权威源，禁止直接切回，
否则会丢数据。此时应保持维护模式，使用 PostgreSQL PITR/备份恢复到健康集群，
或通过经过验证的反向迁移/事件回放工具恢复后再开放流量。每次切换和回滚都要
记录审批人、版本、快照、导入 run ID、哈希、开始/结束时间和验证结果，但不得
记录数据库密码或密钥材料。
