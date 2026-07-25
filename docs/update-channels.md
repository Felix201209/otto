# Otto 增量更新通道

Otto 后续更新分为四类，默认优先发增量包，只有触及 Electron、安装器、系统权限、驱动级 native 依赖时才发完整安装包。

## 通道

- patch：同一 appVersion/sourceCommit 内的小修复，覆盖桌面 main/renderer 资源或服务端 JS 资源。必须有 sha256、签名、回滚 receipt，不允许执行任意脚本。
- kernel：server runtime 运行内核更新，必须声明 kernelAbi，应用后重启本机 server 或 app。当前执行器只支持 `server/runtime`。
- component：skills、模板、连接器、前端资源等独立组件更新，必须声明 componentApi，原则上不重启。
- installer：Electron、安装器、系统集成、native ABI 不兼容或权限变化时使用完整安装包。

## 发布规则

1. release 先发布 manifest，再发布对应 artifacts。
2. 客户端只接受 HTTPS URL、合法 sha256、非空签名和匹配的 appVersion。
3. patch 必须绑定 sourceCommit；kernel 必须绑定 kernelAbi；component 必须绑定 componentApi。
4. 所有增量更新都写入 apply receipt，失败后按 receipt 回滚。
5. 服务器负责托管 manifest 和 artifacts；客户端不再把小问题都升级为完整安装包下载。

## 校验

示例清单在 docs/examples/incremental-update-manifest.example.json。提交前运行：

    npm run update:channels:check

也可以校验指定清单：

    npm run update:channels:check -- path/to/manifest.json

## 当前实现状态

已实现：

- manifest parser 校验 patch/kernel/component 三类通道。
- 发布校验脚本强制 HTTPS、sha256、`ed25519:<64-byte-base64url>` 签名、回滚字段和类型专属兼容字段。
- server loopback/control-token 推送入口：`POST /internal/incremental-update/push` 广播 `incremental_update_available`，只通知客户端检查 HTTPS manifest，不下发可执行内容。
- desktop main/preload 增量更新 IPC：`incrementalUpdateCheck` 与 `incrementalUpdateApply`；preload 收到 server 推送后会触发 main 进程检查。
- patch 本地执行层：下载 artifact、校验 sha256 和 Ed25519 签名、登记到 `userData/incremental-updates/patches/registry.json`，并写入 rollback receipt。
- `desktop/renderer-css` patch bundle 安全解包：bundle 必须是 schemaVersion=1 的 JSON，相对路径 + base64 文件内容，且根目录必须包含 `patch.css`；安装后会插入当前 renderer，窗口重建后也会重新应用。
- kernel 本地执行层：下载 artifact、校验 sha256 和 Ed25519 签名、登记到 `userData/incremental-updates/kernels/registry.json`，并写入 rollback receipt；`server/runtime` bundle 必须包含 `dist/index.js` 与 `dist/bin.js`，ServerManager 下次启动 server 时优先加载 active kernel。
- component 本地执行层：下载 artifact、校验 sha256 和 Ed25519 签名、登记到 `userData/incremental-updates/components/registry.json`，并写入 rollback receipt。
- `skills/<name>` component bundle 安全解包：bundle 必须是 schemaVersion=1 的 JSON，相对路径 + base64 文件内容；安装后同步到 `~/.otto-user/skills/<name>`，下一次 skills 刷新可发现。

运行约束：

- 客户端可通过 `OTTO_INCREMENTAL_UPDATE_MANIFEST_URL` 指向企业 HTTPS 增量 manifest；服务器推送帧也可携带本次检查用的 HTTPS manifest URL。未配置且未收到推送时检查会明确失败，不会伪装成“已最新”。
- 当前 patch 支持 `desktop/renderer-css` 受控 UI 热补丁，kernel 支持 `server/runtime` 签名 bundle 安装并在 server 重启后切换，component 支持 `skills/<name>` 安全解包。

未实现：

- patch 仍未开放 main/renderer JS 或服务端 JS 覆盖；当前只允许 CSS 资源补丁，不执行任意脚本。
- kernel 仍未覆盖 native ABI、Electron 主进程、安装器或数据库迁移；这些仍必须走完整安装包或后续专门迁移器。
- 非 skills component 的解包、运行时加载和权限授予。
- 公钥轮换和服务端发布接口。

当前 `skills/*` component 会解包并替换对应用户技能目录；非 skills component 仍只登记 artifact。客户端不会自动执行 bundle 内代码，只有 core 既有 skills 加载器在刷新后读取 `SKILL.md` 和相关资源。
