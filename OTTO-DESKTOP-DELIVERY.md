# Otto Desktop 交付计划（.app/Electron + app server + 飞书双向同步 + 维持 TUI）

> 用途：开 issues 的源文档。每条 issue 自包含，可直接 `gh issue create` 粘贴。
> **里程碑**：后天 **6/29（周一）交付**；明天 **6/28（周日）EOD 出 zip**。今天 6/27（周六）起跑。
> **飞书档位（已定）**：**完整双向同步**（飞书网关迁进 server）。带 **6/28 晚 checkpoint**：双向未通过则降级只读入 zip（见 §4），整体交付不阻塞。

## 团队（3 技术 + 1 PM）

| 人 | 角色 | 主战场 |
|---|---|---|
| **Felix** | UI / 视觉 + Electron 客户端整条 | Electron 壳、渲染层、setup GUI、飞书同步视图、视觉打磨 |
| **NaturalScience** | 后端脊梁（事实 tech lead） | otto-server、API 契约、飞书双向接入 |
| **IndustrialEngineering** | 打包 / TUI + 飞书双向结对 | electron-builder、server 自启 / daemon 重指向、TUI 保活、**早期与 NS 啃飞书双向** |
| **Jeremy Curry** | PM（最年长，不写码） | 交付与验收、README、里程碑、go/no-go、demo |

---

## 0. 现状（已摸底，作为前提）

- **`otto-core`（packages/core）** 已是独立 headless 核心；TUI 只是它的一个前端。✅ 抽核心不用做。
- **TUI = `otto-cli`（packages/cli）**，Ink（终端版 React）。入口 `packages/cli/src/otto.tsx`，根组件 `ui/App.tsx`。
- **已有 DOM 聊天 UI**：`packages/vscode-ui-plugin/webview`（React 18 + react-dom），经 `src/types/messages.ts` 协议与 core 通信 → **Electron 渲染层可复用**。
- **飞书**：daemon 在 `packages/cli/src/feishuDaemon.ts`，网关 `services/feishu/gateway.ts`，状态盘 `ui/components/FeishuStatusDashboard.tsx`。当前**跑在 CLI 进程内直接调 core**。
- **无通用 server**；仅 `packages/core/src/auth/login/authServer.ts`（OAuth 回调小 HTTP server）可作模式参照。
- 当前可交付物：`~/Desktop/otto-cli-1.1.12.tgz`（CLI/TUI，离线可装）——**兜底**始终放进交付 zip。

---

## 1. 目标架构：Electron + 本地 app server（唯一会话源，飞书双向）

```
                ┌──────────────── otto-server（新, 本地进程 127.0.0.1:PORT）───────────────┐
                │   otto-core 会话 + 事件存储(session store) + HTTP/WS API                  │
                │                       ▲                         ▲                        │
                └───────────────────────┼─────────────────────────┼────────────────────────┘
                          WS/HTTP ───────┘                         └─────── 飞书网关(迁入 gateway.ts，双向)
                              │                                                 ▲
                   ┌──────────┴───────────┐                          ┌──────────┴──────────┐
                   │ Electron renderer     │                          │ 飞书 daemon          │
                   │ (复用 webview DOM UI) │  双向同步同一份会话 ↔飞书 │ (重指向 server)      │
                   └───────────────────────┘                          └─────────────────────┘

   otto-cli (Ink/TUI) ── 原样保留，继续直接用 otto-core（本轮不动其行为）
```

**要点**
- app server = **独立本地进程**：飞书消息/回复写进 server 会话存储并经 **WS 广播**；Electron 渲染层订阅 → 飞书聊天**实时进 app**；app 内发言也回推飞书（**双向**）。
- server 可 headless 常驻：**app 关了飞书仍活**；`.app` 打开时自动拉起 server（若未运行）并同步历史。
- 渲染层走**纯 DOM（复用 webview）**，不引 xterm/node-pty → 绕开 Electron 最大原生编译坑。
- **TUI 不碰**：维持 TUI = 保 `otto-cli` 绿、行为不变（飞书↔TUI 同步列 P1）。
- **core 内部尽量别改**；必须改由 NaturalScience 统一把关（一改同时震 TUI 和 VSCode 插件）。

---

## 2. 并行契约（让团队不互相阻塞）

- **冻结点**：**6/28 周日 AM，NaturalScience 发布 `otto-server` 的 WS/HTTP API 契约**（优先复用并扩 `webview/src/types/messages.ts`）。
- 今晚各起架子用 **mock 接口**：Felix 起 Electron 空窗 + 假 WS 渲染、IndustrialEngineering 搭 electron-builder 架子 + 记 TUI 基线、NaturalScience 搭 server 骨架。
- 契约冻结后实装，当天集成。

---

## 3. 倒排时间线

| 时间 | 里程碑 |
|---|---|
| **今晚 6/27** | NaturalScience: server 骨架(空 WS/HTTP 能起)；Felix: Electron 空窗 + webview 本地渲染(接 mock)；IndustrialEngineering: electron-builder 架子 + 记 `otto-cli` 红绿基线，随后转 #3 |
| **6/28 AM** | **NaturalScience 冻结并发布 server API 契约** → 全队并行实装。Felix 先做不依赖飞书的 #4/#5/#7，#6 最后做；IndustrialEngineering 早期并到 #3 |
| **6/28 晚 ★checkpoint** | 飞书**双向**是否跑通？通过→进 zip；**未通过→降级只读版进 zip**（不阻塞交付） |
| **6/28 EOD** | 集成 → **切 zip**：① mac `.app`(未签名,右键打开) ② `otto-cli` tgz 兜底 ③ README。Jeremy Curry 装包 + 跑验收 |
| **6/29 AM** | Jeremy Curry 冒烟 → 修 bug、打磨 → 最终 `.app`+zip → **交付** |

---

## 4. 风险与降级（hackathon 纪律）

- **★ 飞书双向 = 唯一真会滑窗的点**：6/28 晚 checkpoint 不通过，**当晚切只读版进 zip**（app 订阅 daemon 只读展示飞书会话），完整双向做 fast-follow。不让一个模块绑架交付。
- **不碰 .app 公证**：出未签名包 + “右键→打开”说明，别烧时间在 Apple 公证。
- **保底交付**：zip 永远含可装 CLI tgz——`.app` 滑窗也不为零。
- **webview 复用 = 今晚必须有结论**（Felix 的 P0）：起不来才降级 xterm 嵌 TUI。
- **维持 TUI = 硬验收门**：Electron/server 改动不许碰 `packages/cli` 行为。
- **关键路径加固**：Felix 接手 Electron 壳(#4) 后，IndustrialEngineering **早期即与 NS 结对啃 #3 飞书双向**（最险点两人盯）；NS 仍主 #1/#2/#3。
- **残留端点**：`dev`/`debug` 脚本里还有 `deepvlab.ai/dvcode`，打包前剔除，勿入交付物。

---

## 5. Issues（逐条可开）

> **已上线**：13 条已建到 `github.com/Felix201209/otto`，对应 **GH#5–17**（标题含 `Issue N` 前缀对齐本文档），标签 + `6/29 交付`里程碑已挂，Issue 4–7 已 assign `Felix201209`。NaturalScience / IndustrialEngineering / Jeremy Curry 的 GitHub assignee 待补 handle。
>
> 字段：**Owner** / **Labels** / **Depends** / **Milestone=6/29 交付**。
> 标签先建：`area:server` `area:desktop` `area:feishu` `area:packaging` `area:tui` `area:delivery` `P0` `P1`。

### Issue 1 — [P0] 立 `otto-server`：本地 HTTP/WS app server，托管 core 会话
- **Owner**: NaturalScience · **Labels**: `area:server` `P0` · **Depends**: 无（关键路径起点）
- **Context**: 新建 `packages/server`（`otto-server`），包住 `otto-core`，做会话+事件存储，暴露本地 HTTP/WS。参照 `core/src/auth/login/authServer.ts`。
- **Tasks**
  - [ ] 新建 `packages/server`，默认监听 `127.0.0.1:<port>`（可配/可发现）
  - [ ] 包一层 otto-core：建会话、发消息、流式回复事件
  - [ ] 会话+事件存储（in-memory 起步，落盘 P1），多客户端订阅同一会话
  - [ ] WS 广播会话事件；HTTP 取历史/列会话
  - [ ] `otto server start/stop/status` 命令（对齐现有 daemon 风格）
- **Acceptance**: 两个 WS 客户端连同一会话，一端发消息，另一端实时收到同样流式回复。

### Issue 2 — [P0] 冻结并发布 server WS/HTTP API 契约（全队解锁前提）
- **Owner**: NaturalScience · **Labels**: `area:server` `P0` `contract` · **Depends**: #1
- **Tasks**
  - [ ] 复用并扩 `webview/src/types/messages.ts`：会话列表/历史/用户消息/流式增量/工具调用/状态/错误
  - [ ] 来源标记 `source: feishu|app|tui` + 会话归属
  - [ ] 落 `packages/server/src/protocol.ts` 并导出类型给 desktop
  - [ ] **6/28 AM 冻结**，本 issue 贴最终协议
- **Acceptance**: Felix、IE 能 import 协议类型实装，无需口头对齐。

### Issue 3 — [P0] 飞书**双向**接入 app server（同步源）
- **Owner**: NaturalScience（IndustrialEngineering 结对）· **Labels**: `area:server` `area:feishu` `P0` · **Depends**: #1
- **Context**: 把 `services/feishu/gateway.ts` 网关逻辑迁进 server，飞书每条来/回消息进 server 会话并广播；**app 内发言回推飞书**。受 §4 checkpoint 约束（不通过则当晚降只读）。
- **Tasks**
  - [ ] 网关迁入 server（或 server 内置飞书 adapter）
  - [ ] 飞书会话映射为 server 会话（`source:feishu`）
  - [ ] 来/回消息写存储并 WS 广播
  - [ ] **app→飞书回推**（双向）
  - [ ] 与 #9 daemon 重指向对接
- **Acceptance**: 飞书发消息→app 实时看到且能回复→飞书侧收到 app 的回复。

### Issue 4 — [P0] 立 `packages/desktop`：Electron 壳（main + preload）
- **Owner**: Felix · **Labels**: `area:desktop` `P0` · **Depends**: #2（今晚可先 mock）
- **Note**: Felix 同时拥 #4/#5/#6/#7 整条桌面端，preload 接口自产自销、无跨人阻塞。
- **Tasks**
  - [ ] Electron 主进程 + 窗口 + 菜单 + 图标
  - [ ] 启动时检测 server，未跑则拉起（与 #9 对齐）
  - [ ] preload/contextBridge 暴露 WS/HTTP 客户端接口（按 #2）
  - [ ] 安全基线：禁 nodeIntegration、开 contextIsolation、本地 CSP
- **Acceptance**: Electron 起空窗能连本地 server 完成握手。

### Issue 5 — [P0] 渲染层：移植 `vscode-ui-plugin/webview` 到 Electron 并接 server
- **Owner**: Felix · **Labels**: `area:desktop` `P0` · **Depends**: #4
- **Context**: fork webview，把 vscode `postMessage` 换成 preload 的 server WS 通道。**今晚先验证 webview 能否起来——起不来立刻报，降级 xterm。**
- **Tasks**
  - [ ] webview 源码移入渲染层，本地能构建渲染
  - [ ] 抽传输层，vscode → Electron preload WS 适配
  - [ ] 渲染会话历史 + 流式回复 + 工具调用展示
  - [ ] 列出依赖 vscode API 的点并替换/桩掉
- **Acceptance**: app 内发消息→看到流式回复，全图形界面。

### Issue 6 — [P0] app 内飞书**双向**同步视图
- **Owner**: Felix · **Labels**: `area:desktop` `area:feishu` `P0` · **Depends**: #3 #5
- **Tasks**
  - [ ] 会话列表区分来源（飞书/本地）+ 同步状态指示
  - [ ] 实时显示飞书消息与回复（WS）
  - [ ] app 内对飞书会话发言→回推飞书（双向）
- **Acceptance**: 飞书↔app 双向，几秒内互见（端到端 demo）。

### Issue 7 — [P0] setup/BYO-key 图形引导页 + 模型选择 + slash
- **Owner**: Felix · **Labels**: `area:desktop` `P0` · **Depends**: #4
- **Tasks**
  - [ ] 首启引导填 provider/key/model（BYO-key），落到与 CLI 一致的配置
  - [ ] 模型选择 + slash 命令面板
- **Acceptance**: 全新机器从 .app 打开→图形配 key→直接对话。

### Issue 8 — [P0] electron-builder 出 mac `.app` + 交付 zip
- **Owner**: IndustrialEngineering · **Labels**: `area:packaging` `P0` · **Depends**: #4
- **Tasks**
  - [ ] electron-builder 配置产出 `.app`（先空壳跑通）
  - [ ] 打包脚本聚合 .app + CLI tgz + README 成交付 zip
  - [ ] 未签名打开说明（右键→打开）
  - [ ] 干净 Mac 冒烟
- **Acceptance**: 另一台 Mac 解压：`.app` 能开、tgz 能装。

### Issue 9 — [P0] app server 随 .app 打包 + 自启；飞书 daemon 重指向 server
- **Owner**: IndustrialEngineering（NaturalScience 协作）· **Labels**: `area:packaging` `area:feishu` `P0` · **Depends**: #1 #3 #8
- **Tasks**
  - [ ] server 打进 .app，主进程按需自启
  - [ ] 飞书 daemon 重指向 server，`otto feishu daemon start/stop/status` 仍可用
  - [ ] 端到端冒烟：飞书 ↔ server ↔ app 双向
- **Acceptance**: 关 app 飞书仍能对话；再开 app 历史同步出现。

### Issue 10 — [P0] 维持 TUI：`otto-cli` 重构后保绿、行为不变（回归门）
- **Owner**: IndustrialEngineering · **Labels**: `area:tui` `P0` `regression-gate` · **Depends**: 无（全程）
- **Context**: 已知 ~12 红为良性（App 9=有意关功能 / proxy 3=本机代理 / install=预存 mock 崩），**基线不得新增红**。
- **Tasks**
  - [ ] 记今晚基线红绿
  - [ ] 每次动 cli/core 后复跑 `otto-cli` 测试
  - [ ] `otto`(TUI) 手动冒烟：配 key、对话
- **Acceptance**: 交付前 TUI 行为与 v1.1.12 一致，无新增失败。

### Issue 11 — [P1] 清理残留 deepvlab/dvcode 端点
- **Owner**: IndustrialEngineering（Jeremy Curry 验收）· **Labels**: `area:packaging` `P1`
- **Tasks**
  - [ ] `dev`/`debug` 脚本及代码内 `deepvlab.ai`/`dvcode` 端点剔除或置空
  - [ ] 确认交付物（.app/tgz）不含母公司端点
- **Acceptance**: 交付包内无 deepvlab/dvcode 出网端点。

### Issue 12 — [P1] 飞书 ↔ TUI 同步（拉伸目标）
- **Owner**: 视进度 · **Labels**: `area:tui` `area:feishu` `P1` · **Depends**: #1 #3
- **Acceptance**: TUI 可只读看到飞书会话（非交付必需）。

### Issue 13 — [P0] 交付与验收（PM 主战场）
- **Owner**: Jeremy Curry · **Labels**: `area:delivery` `P0` · **Depends**: 各 P0
- **Context**: PM 不写码，owns 把关交付质量与节奏。
- **Tasks**
  - [ ] 维护 issue 板 + 6/29 里程碑，每日盯进度/解阻塞
  - [ ] 跑各 issue Acceptance 清单（手动 QA / 冒烟）
  - [ ] **6/28 晚主持 checkpoint**：飞书双向过/降级 决策
  - [ ] 组装交付 zip（.app + tgz + README），干净 Mac 验收
  - [ ] 6/29 go/no-go + demo 脚本
- **Acceptance**: zip 在另一台 Mac 验收通过，交付物齐备可演示。

---

### 开 issues 提示
逐块对应一个 issue。`gh issue create -t "<标题>" -b "<正文>" -l "<labels>" -a "<assignee>"` 可批量建。建议先建标签与 6/29 里程碑，assignee 换成各人 GitHub 账号。
