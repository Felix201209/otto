# Otto 增量更新通道

Otto 后续更新分为四类，默认优先发增量包，只有触及 Electron、安装器、系统权限、驱动级 native 依赖时才发完整安装包。

## 通道

- patch：同一 appVersion/sourceCommit 内的小修复，覆盖桌面 main/renderer 资源或服务端 JS 资源。必须有 sha256、签名、回滚 receipt，不允许执行任意脚本。
- kernel：core/server/native 运行内核更新，必须声明 kernelAbi，应用后重启本机 server 或 app。
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
