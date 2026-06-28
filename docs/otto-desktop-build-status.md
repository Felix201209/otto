# Otto Desktop 构建状态 (集成验证报告)

> 生成于一次集成与验证 pass。范围：`npm install` → `packages/server` + `packages/desktop` typecheck/build → `otto-cli` 回归门 → 本文档。
> 未 commit、未 PR、未改 `packages/cli` 行为。
> 源计划：`OTTO-DESKTOP-DELIVERY.md`（13 条 issue）。

---

## 1. 一句话结论

新增的 `otto-server` 与 `otto-desktop` 两个 workspace **编译干净、构建产物落盘、server 实跑通过**；`otto-cli` 回归门保住（12 红全是预存良性红，**零新增**）。
能真跑：server 的 HTTP/WS 收发链路、desktop 三段构建产物、electron-builder 出 `.app`、**renderer 真 UI（已接线 + mock 数据可视化验证，1:1 还原设计图）**。
还是骨架：真实 LLM 往返（需可达 baseUrl 的 BYO-key 模型）、真飞书连接（无凭证/无 GUI 未实测）、setup/BYO-key 图形引导（Issue 7 仍占位）。

> **后续修订（renderer 收口 pass）**：断连失败的 renderer agent 其实已写完整套组件（Sidebar/ChatView/Message/Composer/ToolCalls/diff/888 行 app.css/423 行 store），只差没接进 `App.tsx`。本 pass 完成：① App 从三 tab 壳换成真组件单窗（Sidebar+ChatView）+ 引入 CSS；② 修一处运行时泄漏（ToolCalls 误 import 枚举值把 otto-server 运行时打进 renderer bundle，nodeIntegration:false 下会崩）→ 改纯类型导入，bundle 1.3M→187K；③ 补 `css.d.ts`；④ mock 假桥喂样例数据浏览器渲染截图验证，6 会话/Feishu·Local 徽章/diff 卡全部对位。typecheck + 全构建仍绿，cli 零改动。

---

## 2. 各 Issue 完成度

| # | 标题 | 状态 | 说明 |
|---|---|---|---|
| 1 | otto-server：HTTP/WS app server，托管 core 会话 | **已实装** | `CoreSessionRuntime` 移植 `nonInteractiveCli` while 循环包 core；懒构建 runtime；无模型自动降级 mock。HTTP/WS 端到端冒烟通过。**真 LLM 往返受 core adapter 相对 URL 问题阻塞**（需配可达 baseUrl 的自定义模型）。 |
| 2 | 冻结 server WS/HTTP API 契约 | **已实装** | `src/protocol.ts` 冻结：11 ClientToServer + 14 ServerToClient 帧、`source` 标记、HTTP 路由、发现端点、类型守卫。desktop 可 import。 |
| 3 | 飞书双向接入 server | **部分（逻辑全、真连未测）** | `feishuAdapter.ts` + `streamBridge.ts` 真实接线（vendor 软链自 cli）；落库 source:'feishu'、广播、回推卡片、鉴权 fail-closed、无凭证 fail-soft 全用 fake gateway 离线验证（5/5 测试绿）。**真飞书 WS 连接需有凭证的真机点一遍。** slash 生命周期命令、附件入站、工具确认回推留 TODO。 |
| 4 | packages/desktop：Electron 壳 (main+preload) | **已实装（未真起窗）** | 主进程：单实例锁、安全基线（导航白名单/外链系统浏览器/webviewTag off/权限全拒/CSP）、菜单、server 发现与拉起。preload：WS 客户端 + 入队 flush + 指数退避重连。三 tsconfig typecheck 绿。**未在本环境真起 `electron .`（无 GUI）。** |
| 5 | 渲染层：移植 webview 到 Electron | **已实装（可视化验证）** | 真组件全套（Sidebar/ChatView/Message/Composer/ToolCalls/diff/Prose/icons + 888 行 app.css + 423 行 useOttoStore）已接进 App 单窗，CSS 引入，运行时泄漏修复。mock 数据浏览器渲染 1:1 还原设计图（截图存证）。真机 Electron 窗口待 Felix 点。 |
| 6 | app 内飞书双向同步视图 | **已实装（统一进聊天面）** | 不做独立 tab：Sidebar 按 `source` 渲染 Feishu/Local 徽章，ChatView 顶栏「飞书·实时同步」指示，app 内对飞书会话发言 source='local'→server 回推。依赖真飞书后端（#3）连通验证。 |
| 7 | setup/BYO-key 图形引导 + 模型选择 | **骨架** | setup panel 占位。server 侧 `customModels.ts` 读 `~/.otto-user/custom-models.json` + `/models` 已实装，GUI 引导未做。 |
| 8 | electron-builder 出 .app + 交付 zip | **已实装** | `build` 块配齐（arm64 dir target、跳签名/公证）、`make-delivery-zip.mjs`、icon.icns。上一轮已真跑出 324MB `Otto.app`（asar 含 server/core/ws/lark）+ 137.8MB 交付 zip。本轮未重跑出包（renderer 仍占位，无需）。 |
| 9 | server 随 .app 自启 + daemon 重指向 | **部分** | desktop `server-manager.ts` 实装三态（discovered/detached/embedded），detached 子进程优先、内嵌兜底，「app 关 server 仍活」上一轮亲测通过。飞书 daemon（feishuDaemon.ts）重指向 server 未做。 |
| 10 | 维持 TUI：otto-cli 保绿（回归门） | **通过** | 见 §4。`packages/cli/` git-clean，行为未动；测试 12 红 = 预存基线，零新增。 |
| 11 | 清理 deepvlab/dvcode 端点 | **未做** | root `package.json` 的 `dev`/`debug` 脚本仍含 `api-code.deepvlab.ai` / `dvcode.deepvlab.ai`（仅 dev 脚本，非默认 `start`/交付路径）。打包前需剔除。 |
| 12 | 飞书 ↔ TUI 同步（拉伸） | **未做** | P1，非交付必需。 |
| 13 | 交付与验收（PM） | **N/A** | 人工流程。 |

---

## 3. 如何本地起

### 前置
```bash
cd /Users/felix/Desktop/EasyCode
npm install            # workspaces，含 server/desktop 依赖
npm run build          # 主链构建 core/cli/server（vscode 非 critical，pdf-parse 报错被跳过）
```

### 起 server（独立本地进程）
```bash
# 前台跑（Ctrl-C 优雅退出），默认 127.0.0.1:7637
node packages/server/dist/bin.js start
#   可改端口：OTTO_SERVER_PORT=7639 node packages/server/dist/bin.js start
#   强制 mock（无 BYO-key 也能跑收发链路）：OTTO_SERVER_MOCK=1 node packages/server/dist/bin.js start

node packages/server/dist/bin.js status   # 读端点文件 + 探活
node packages/server/dist/bin.js stop      # 按 pid 发 SIGTERM

# 冒烟
curl -s http://127.0.0.1:7637/health
curl -s -X POST http://127.0.0.1:7637/sessions -H 'content-type: application/json' -d '{}'
```
端点发现文件：`~/.otto-user/server-endpoint.json`。

### 起 Electron（dev）
```bash
# 一次性构建三段产物（main + preload + renderer webpack）
npm run build --workspace=packages/desktop

# 起窗（需真机 GUI；本集成环境无显示，未跑）
npm start --workspace=packages/desktop      # = electron .
#   主进程会自动发现/拉起 server（detached 优先，内嵌兜底）

# renderer 改动热构建
npm run dev:renderer --workspace=packages/desktop
```

### 出 .app + 交付 zip
```bash
npm run dist --workspace=packages/desktop       # electron-builder --mac --dir → release/mac-arm64/Otto.app
npm run package --workspace=packages/desktop     # 聚合 .app + CLI tgz + README → zip
```

### BYO-key（真对话需要）
真实 LLM 往返需在 `~/.otto-user/custom-models.json` 配一个 **baseUrl 完整可达**的自定义模型；否则 server 走 mock 回声，或触发 core adapter 相对 URL 报错（见 §5）。

---

## 4. Typecheck / 构建 / 测试结果（本轮实跑）

| 检查 | 命令 | 结果 |
|---|---|---|
| install | `npm install` | ✅ audited 1635 包（83 audit 警告均既有 devDep，非本次引入） |
| server typecheck | `tsc --noEmit` | ✅ EXIT 0 |
| desktop typecheck | main+preload+renderer 三 tsconfig `--noEmit` | ✅ EXIT 0 |
| desktop build | `npm run build`（tsc×2 + webpack） | ✅ 产物：`dist/main/index.js`、`dist/preload/index.js`、`dist/renderer/index.html`+`main.js` |
| server 测试 | `vitest run` | ✅ 5/5（飞书适配器离线端到端） |
| 主链构建 | `npm run build` | ✅ **core / cli / server 全 SUCCESS**；vscode-ui-plugin FAILED 但 non-critical 被跳过（见 §5），脚本 EXIT 0 |
| server 实跑 | `node dist/bin.js start` + curl | ✅ `/health` ok、`POST /sessions` 建会话成功、SIGTERM 优雅退出、无 orphan 进程 |

### 回归门（Issue 10）— otto-cli `vitest run`
```
Test Files  3 failed | 159 passed | 2 skipped (164)
     Tests  12 failed | 1969 passed | 28 skipped (2009)
```
12 红逐个核对 = 预存良性基线，**零新增**：
- `src/ui/App.test.tsx` — **9 红**：有意关闭的 context-summary footer 功能（断言 `0/2 MCP servers` / `GEMINI.md` 等已不渲染）。
- `src/config/config.test.ts` — **3 红**：proxy 测试受本机 `http_proxy`/`https_proxy` 环境变量污染（期望空 / 期望 `localhost:7890`）。
- `src/commands/extensions/install.test.ts` — **1 红**：预存 mock 崩。

`packages/cli/` git status **空**（行为未动），TUI 回归门保住。

---

## 5. 已知缺口与坑

1. **core adapter 相对 URL 问题（阻塞真 LLM 往返）**：server 进程内驱动现有自定义模型触发 `Failed to parse URL from /v1/chat/messages` —— core `OttoServerAdapter` 的 base URL 配置问题（非 server/desktop 代码 bug）。需 core/模型配置侧排查，或配一个 baseUrl 完整可达的自定义模型。被 try/catch 捕获成 error 帧广播，server 不崩。
2. **真飞书连接未实测**：无凭证、无 GUI，鉴权/落库/广播/回推全用 fake gateway 离线验证。真连飞书走的是 cli 已验证的同一份 vendor 代码，但「真发飞书→app 看到→回飞书」需有凭证的真机点一遍。
3. **未真起 Electron 窗口**：本环境无显示。窗口显示、菜单点击、renderer 加载、CSP 在真窗口放行 WS —— 需 Felix 真机 `npm start --workspace=packages/desktop` 亲眼点一遍。
4. **renderer 已接线为真 UI**（已可视化验证）。剩余：setup/BYO-key 图形引导（Issue 7）仍为占位 SetupPanel，未接进单窗（当前配 key 走 CLI `otto setup` 或编辑 `~/.otto-user/custom-models.json`）；FeishuPanel/ChatPanel 两个地基占位文件已不被使用（可后续删）。可视化自检走 `npx webpack --config packages/desktop/webpack.preview.cjs` + 起静态服务看 `preview-dist/`（mock 桥，非真 server）。
5. **vscode-ui-plugin 构建失败（与本次无关）**：`node_modules/pdf-parse/lib/pdf.js/v1.10.88/build/pdf.worker.js.map` 源映射损坏（第三方包，未被本次改动触碰）。该包 non-critical，主链跳过、EXIT 0。
6. **`.gitignore` 修了一处跨包接缝**：原 `server/` 规则会误吞整个新 `packages/server/` 包（让它对 git/打包不可见）。本轮加 `!packages/server/` un-ignore 该包，`dist/`+`node_modules/` 仍被通用规则忽略。这是本轮唯一的源码改动，属集成接缝修复。
7. **deepvlab/dvcode 端点未清（Issue 11）**：root `package.json` 的 `dev`/`debug` 脚本仍含母公司端点；非默认/交付路径，但打包前应剔除。
8. **TODO 残留**：`tool_confirmation_response` 路由（当前 YOLO 不上抛确认）、多模态 image 注入、token 用量透传、飞书 slash 生命周期命令、飞书 daemon 重指向 server（Issue 9 后半）。

---

## 6. 下一步建议（按优先级）

1. **Issue 5 移植 webview** → renderer 从骨架变真 UI（解锁 #6/#7 视觉验收）。
2. **真机点窗**：Felix `npm start --workspace=packages/desktop` 亲眼验 Electron 窗口 + CSP + WS。
3. **配可达 BYO-key 模型** 跑通真 LLM 往返，或排查 core adapter 相对 URL（§5.1）。
4. **真机验飞书双向**（有凭证时）。
5. **Issue 11 清 deepvlab/dvcode** + Issue 9 后半（daemon 重指向）后再出最终交付 zip。

---

## 7. 打磨轮（视觉 polish #0/#1/#2 之后的集成验证 pass）

> 范围：`npm install` → desktop 三段 typecheck/build → 渲染层 bundle 健康检查 → server/desktop/cli 三处 vitest → 重建预览。
> 唯一源码改动：`packages/desktop/vitest.config.ts`（测试接缝修复，详见下）。未 commit、未 PR、未碰 `packages/cli`、未碰 renderer 产品代码。

### 7.1 视觉打磨要点（前序 polish 轮已落地，本轮承接验证）
- **质感增强（polish #0）**：用户气泡加深+暖描边、分层阴影体系（xs/sm/card/pop）、typing 三点动画、工具卡 `grid-template-rows: 0fr→1fr` 折叠动画、diff 横滚容器+统计条+sticky 行号、模型菜单层次、顶栏滚动 hairline、空态示例 prompt 胶囊、新消息浮标。全在 spec 既定浅色+amber 布局之上，未改结构与配色语义。
- **setup/BYO-key 向导（polish #1，Issue 7）**：占位 → 完整模态向导（品牌供应商 pill、协议下拉、官方端点锁定/custom 可编辑、API key 掩码+粘贴、模型 id 示例快填、字段级校验）。渲染层**纯复刻** core 的 `CustomModelConfig`/`generateCustomModelId`/校验逻辑（不 import core 运行时，守住 bundle 红线）。
- **import type 纪律保持**：ToolCalls 状态用字符串字面量比较，零运行时值导入。

### 7.2 setup 完成度（Issue 7）
- **UI/校验/落盘构造**：✅ 完成。面板渲染、字段校验、`custom-models.json` 字节级对齐 CLI（`{ models:[...], _metadata:{version:"1.0",lastModified} }`），浏览器实测放行。
- **落盘链路**：⚠️ **未打通**。渲染层唯一传输是 preload WS 桥（只收 `ClientToServer` 帧），`protocol.ts` 无写自定义模型的帧、server 无写端点。在「只改 setup/+App.tsx」分区约束下未越界新增协议帧/端点。当前「完成配置」走「复制就绪 JSON / 等价 `otto setup` 命令」两条今天即可落盘的工作路径，面板红框已明确标注。补齐路径：协议加 `save_custom_model` 帧 + server 端写盘，`submit()` 改 `transport.send` 即可（其余 UI 已就绪）。

### 7.3 本轮 typecheck / build / 测试结果（实跑数字）
| 检查 | 命令 | 结果 |
|---|---|---|
| install | `npm install` | ✅ up to date，audited 1635 包（无新增 devDep 需补；83 audit 警告均既有） |
| desktop typecheck | main+preload+renderer 三 tsconfig `--noEmit` | ✅ 三段全 EXIT 0 |
| desktop build | `npm run build`（tsc×2 + webpack prod） | ✅ `compiled successfully`，三段产物落盘 |
| server 测试 | `vitest run` | ✅ **75/75**（6 文件全绿：protocol/sessions/endpoint/feishuAdapter/customModels/server） |
| desktop 测试 | `vitest run` | ✅ **31/31**（2 文件：useOttoStore 23 + 另 1 文件 10）。修测试接缝前为 21 红，根因非代码 bug，见 §7.5 |
| **cli 回归门** | `vitest run` | ✅ **基线保持**：`3 failed \| 159 passed \| 2 skipped` 文件 · `12 failed \| 1969 passed \| 28 skipped` 测试，**零新增** |

### 7.4 渲染层 bundle 健康检查（★关键）
- **生产 renderer bundle**：`dist/renderer/main.js` = **222 KiB（227,758 字节）** — 数百 KB 量级，✅ 正确（非 MB 级）。
- **运行时泄漏扫描**：`opentelemetry` 命中 **0**、`OttoServerAdapter/nonInteractiveCli/@lark` server 运行时命中 **0**、`WebSocketServer` 命中 **0**。✅ import type 纪律守住，otto-server 运行时未被打进 renderer。
- 注：`preview-dist/main.js` = 1.3 MiB 是 **dev 模式 + 含 react 整包**的预览专用产物（mock 桥），与生产 bundle 无关，不在健康检查口径内。

### 7.5 测试接缝修复（本轮唯一源码改动）
- **现象**：`packages/desktop` vitest 初跑 21 红，全是 `Cannot read properties of null (reading 'useReducer')`。
- **根因**：monorepo 内 react 实例分裂 —— root `node_modules` 是 react/react-dom **19.2.3**，`packages/desktop/node_modules` 自带 react/react-dom **18.3.1**；`@testing-library/react@16` 的渲染器解析到 root 19，被测 hook（`useOttoStore`）解析到 desktop 18，两份 react → hooks dispatcher 为 null。**非代码 bug，是测试环境依赖解析接缝**。
- **修法**：`vitest.config.ts` 把 react/react-dom 及其子路径（`react-dom/client`、`jsx-runtime` 等）经 alias 统一钉到 **root 的 react 19**（RTL 16 原生兼容 19），并 `server.deps.inline` 强制 RTL 内联以让 alias 对其内部 import 生效。`dedupe` 在本仓不可靠（两份完整副本），故改 alias。被测内容是 store reducer（纯函数）+ 基础 hook，18→19 行为无差异；**生产 renderer 仍由 webpack 用 desktop 的 react 18 编译，测试解析独立于打包**。
- **结果**：31/31 全绿。残留 `act(...)` 是 react 19 对 `renderHook` 更严格的 stderr 警告（非失败）。

### 7.6 TUI 回归结论
- `packages/cli/` **git status 空**，行为未动。
- 12 测试红逐项核对 = 预存良性基线，**零新增**：App.test 9 红（有意关闭的 context-summary footer 功能）+ config.test 3 红（本机 `http_proxy`/`https_proxy` 环境污染，`127.0.0.1` vs `localhost`）；第三个失败文件 install.test 为整文件 suite-level 崩（预存 mock 崩，不计入 12 的 test 计数）。**TUI 回归门保住。**

### 7.7 preview-dist 就绪
- `cd packages/desktop && npx webpack --config webpack.preview.cjs` ✅ `compiled successfully`，`preview-dist/{index.html, main.js}` 已重建，供主代理截图复验（mock 桥喂样例数据，非真 server）。

### 7.8 诚实完成度
- **已验证**：install / 三段 typecheck / 三段 build / server 75 测试 / desktop 31 测试 / cli 回归门零新增 / bundle 222K 且无运行时泄漏 / preview-dist 重建 —— 全部本轮实跑命令出数。
- **未验证（环境/分区所限，沿用前序坑）**：① 真 Electron 窗口（本环境无 GUI，齿轮入口/首启自动浮出/CSP 放行 WS 需 Felix 真机点）；② 真 LLM 流式往返（受 §5.1 core adapter 相对 URL 阻塞，非渲染层问题）；③ setup 落盘链路端点（§7.2，分区约束未越界补）；④ 真飞书双向（无凭证）；⑤ 顶栏 hairline / 新消息浮标的浏览器实滚可视确认（逻辑已实装、typecheck 过，preview 程序化 scrollTop 被钳制未能可视复现）。

---

## 8. 收口轮 QA（setup 落盘 + LLM 修复 + Issue9/11 + 死文件 + 打磨 之后的全量验证 pass）

> 范围：从已 install 的环境重跑 `npm install` → server+desktop 三段 typecheck → desktop 三段 build + bundle 健康/泄漏扫描 → server/desktop/cli 三处 vitest → 重建 preview。
> **本轮零源码改动**：所有检查首次跑即全绿，无需修任何接缝。未 commit、未 PR、未碰 `packages/cli` 行为。
> Node v24.12.0 / npm 11.6.2，分支 `feat/otto-desktop`。

### 8.1 各阶段产出完成度（对照本轮 QA 输入清单）
| 阶段产出 | 完成度 | 本轮验证口径 |
|---|---|---|
| **setup 落盘**（save_custom_model 帧 + server 写端 + 前端发帧闭环） | **代码/类型/单测层闭环** | server `customModels.test.ts` 12 + `server.test.ts` 16 全绿（覆盖写盘去重/广播/error 回包）；renderer typecheck 0 错强保证 payload 契约字节对齐。**真落盘+真 desktop+真 key 全链路未跑**（无 GUI/无 key）。 |
| **LLM URL 修复**（coreConfig.ts server 侧兜底默认模型→custom id） | **代码层完成，零 core 改动** | server typecheck 0 错；逻辑修复点明确。**真 LLM 往返未跑**（受 §5.1 + 无可达 baseUrl 的 BYO-key 模型）。 |
| **Issue9**（飞书 daemon 重指向 server） | **未做（遵从安全评估）** | `feishuDaemon.ts` 未触碰；cli 回归门 feishu/daemon 相关测试零退化（见 8.5）。降级为独立 backlog。 |
| **Issue11**（清 deepvlab/dvcode 端点） | **已做（root package.json dev/debug 脚本）** | `npm run` 脚本内 `deepvlab` 残留 grep = 0（见 8.6）。探针脚本 `scripts/probe-*.mjs`/`test-acp-live.mjs` 的 fallback 端点仍在，不入 bundle，留 backlog。 |
| **死文件清理**（ChatPanel.tsx / FeishuPanel.tsx） | **已删** | 二者及空目录 chat//feishu/ 已不存在；renderer typecheck 0 错，无悬空引用（见 8.7）。 |
| **打磨**（toast/断连横幅/管理模型入口/diff fade/浮标/状态淡入 6 项） | **代码层完成** | 已编入生产 main.js；renderer typecheck + build 全绿。**动态态真机外观未逐态截图**（playwright 未装）。 |

### 8.2 install / typecheck / build（实跑数字）
| 检查 | 命令 | 结果 |
|---|---|---|
| install | `npm install` | ✅ **up to date，audited 1635 包**（83 既有 audit 警告：5 low/38 mod/34 high/6 crit，全 devDep 既存，非本次引入；postinstall 二进制权限修复 OK） |
| server typecheck | `tsc --noEmit` | ✅ **EXIT 0** |
| desktop typecheck | main+preload+renderer 三 tsconfig `--noEmit` | ✅ **三段全 EXIT 0** |
| desktop build | `build:main`+`build:preload`+`build:renderer`（tsc×2 + webpack prod） | ✅ **`compiled successfully`**（1107ms），三段产物落盘 |

### 8.3 bundle 健康 + 运行时泄漏扫描（★关键）
- **生产 renderer bundle**：`dist/renderer/main.js` = **310 KiB（317,152 字节）** — 数百 KB 量级，✅ 正确（非 MB 级）。比 §7.4 的 222K 增大约 88K = **头像内联**（本轮 renderer 已接生成的头像资产，base64 内联进 bundle），符合「头像内联后约 300K 量级正常」的预期口径。
- **运行时泄漏扫描（命中应为 0，实测全 0）**：`opentelemetry`=0、`OttoServerAdapter`=0、`nonInteractiveCli`=0、`WebSocketServer`=0、`@lark`=0、`ws/lib`=0。✅ import type 纪律守住，**otto-server 运行时 / @opentelemetry 未被打进 renderer**。
- 注：`preview-dist/main.js` = 1.4 MiB 是 dev 模式 + react 整包的预览专用产物（mock 桥），不入生产口径。

### 8.4 三处 vitest（实跑数字）
| 包 | 命令 | 结果 |
|---|---|---|
| server | `npm run test`（vitest run） | ✅ **75/75**（6 文件全绿：protocol 10 / sessions 27 / endpoint 5 / feishuAdapter 5 / customModels 12 / server 16） |
| desktop | `npx vitest run`（注：desktop package.json **无 `test` 脚本**，需 npx 直跑——见 8.8 缺口） | ✅ **31/31**（2 文件：useOttoStore 23 + diff 8；`act(...)` 警告非失败，是 RTL16+react19 解析下的 stderr 噪声，见 §7.5） |
| **cli 回归门** | `npx vitest run` | ✅ **基线保持，零新增** |

### 8.5 cli 回归门逐项核对（★Issue9 关注点）
```
Test Files  3 failed | 159 passed | 2 skipped (164)
     Tests  12 failed | 1969 passed | 28 skipped (2009)
```
- 与 §4 / §7.3 基线 **逐数字吻合，零新增**。失败文件（junit 解析）= `config.test.ts`(3) + `App.test.tsx`(9) + `install.test.ts`(1)，全是预存良性红：
  - `App.test.tsx` 9 红 = 有意关闭的 context-summary footer（断言 `0/2 MCP servers`/`GEMINI.md` 已不渲染）。
  - `config.test.ts` 3 红 = 本机 `http_proxy`/`https_proxy` 环境污染（`localhost` vs `127.0.0.1`）。
  - `install.test.ts` 1 红 = 预存 mock 崩。
- **Issue9 未动 `feishuDaemon.ts`**：cli 测试中 **无任何 feishu/daemon 相关用例退化**（12 红全在上述 3 个与飞书无关的文件内）。`packages/cli/` **git status 空**，行为未动。**回归门保住。**

### 8.6 Issue11 端点清理核对
- `package.json` 的 `scripts` 块内 `deepvlab` 残留 grep = **0**（`dev`/`debug` 已清母公司端点）。
- 残留（不入 bundle，留 backlog）：`scripts/probe-*.mjs`、`test-acp-live.mjs` 仍有 `api-code.deepvlab.ai` 作 fallback 探针端点；交付物 `~/Desktop/otto-cli-1.1.12.tgz` 是否含残留未在本轮重打验证。

### 8.7 死文件 / 接缝
- `packages/desktop/src/renderer/chat/ChatPanel.tsx`、`feishu/FeishuPanel.tsx` 及两空目录 **已不存在**；renderer typecheck EXIT 0，无悬空 import。
- root `package.json` / `.gitignore` / `scripts/build.js` 在 `git status` 显示 `M`（前序轮改动，本 QA 轮未再动）。

### 8.8 preview-dist 就绪
- `cd packages/desktop && npx webpack --config webpack.preview.cjs` ✅ **`compiled successfully`**（458ms），`preview-dist/{index.html(1.7K), main.js(1.4M)}` 已重建，供主代理截图复验（mock 桥喂样例数据，含 `save_custom_model` 处理 + `?empty` 开关）。

### 8.9 诚实完成度（本环境无法验的）
- **已硬验证**（本轮实跑出数）：install / server+desktop 三段 typecheck / desktop 三段 build / bundle 310K 且 6 项泄漏关键字全 0 / server 75 测试 / desktop 31 测试 / cli 回归门 12 红零新增 / preview-dist 重建。
- **本环境无法验（沿用前序坑 + 本轮新增分区限制）**：
  ① **真 Electron 窗口**（无 GUI）：窗口/菜单/CSP 放行 WS/齿轮入口/首启浮出 setup 需 Felix 真机点；
  ② **真 LLM 流式往返**（无可达 baseUrl 的 BYO-key 模型 + §5.1 core adapter 相对 URL）：LLM 修复仅代码层验证，未端到端跑通；
  ③ **setup 真落盘全链路**（无 key/无 GUI）：save_custom_model→server 写 `~/.otto-user/custom-models.json`→广播→模型可用，仅单测+类型层闭环，未真盘验证；
  ④ **真飞书双向**（无凭证）：fail-soft 跳过；
  ⑤ **打磨 6 项动态态真机外观**（playwright 未装）：toast/saving 转圈/断连横幅/diff fade/浮标/状态淡入仅 typecheck+grep 编入证明，未逐态截图人工核对；
  ⑥ **electron-builder 出 .app + 交付 zip**：本轮未重跑出包。
- **小接缝提示（非阻塞）**：`packages/desktop/package.json` 缺 `test` 脚本与 `vitest` devDep，测试靠 root vitest + `npx` 间接跑；建议补 `"test":"vitest run"` 脚本，让 desktop 测试可被 `npm run test --workspace` 统一驱动（当前会报 `Missing script: "test"`）。
