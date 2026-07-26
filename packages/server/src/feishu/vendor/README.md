# feishu/vendor —— 飞书网关源（软链自 cli，单一真相）

> Issue #3：把 历史 Feishu 纯网关层接入 server，
> 实现飞书 ↔ app 双向同步。

## 这些文件是什么

本目录下的 `.ts` 都是**符号链接（symlink）**，指向 cli 包内的同名源文件：

| vendor 软链 | 真实源 |
|---|---|
| `gateway.ts` | `../../../../cli/src/services/feishu/gateway.ts` |
| `credentials.ts` | `../../../../cli/src/services/feishu/credentials.ts` |
| `logger.ts` | `../../../../cli/src/services/feishu/logger.ts` |
| `markdown-style.ts` | `../../../../cli/src/services/feishu/markdown-style.ts` |
| `image-type.ts` | `../../../../cli/src/services/feishu/image-type.ts` |

为什么软链而非物理复制：

- **单一真相**：飞书 SDK 收发逻辑（鉴权 / 长连接 / CardKit 流式卡 / 去重）
  在 cli 与 server 必须一致。软链让 cli 改网关时 server 自动跟进，不漂移。
- **server 自包含可打包**：实测 `tsc --build`（composite）跟随软链编译，
  产物正常落进 `server/dist/src/feishu/vendor/gateway.js`（约 149KB），
  打包（Issue #8）无需额外搬运。
- 摸底确认：`gateway.ts` 仅依赖 `node:*` + 同目录这 4 个纯模块，
  **零 otto-core、零 Ink、零 appEvents**，可直接 import 进 server。

## 改动纪律

- vendor 文件是服务端运行时副本。修改 Feishu 网关时，需要同步跑 server Feishu adapter 测试。
- server 侧的飞书**适配 / 接线**逻辑写在 vendor 之外（`feishuAdapter.ts` /
  `streamBridge.ts` / `register.ts`），不碰 vendor。
- 若日后要彻底切断 cli 依赖（cli 退场），把这些软链替换为物理副本即可，
  接线代码（adapter/bridge/register）无需改动。

## 接线落点

- `../register.ts`：`registerFeishu()` —— 地基接缝实装。
- `../feishuAdapter.ts`：`new FeishuGateway` + `connect` + `onMessage` 桥接 + app→飞书回推。
- `../streamBridge.ts`：订阅 store 会话广播，把 core 流式帧节流回推飞书卡片。
