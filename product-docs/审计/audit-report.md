核心代码已全部核实,与复核结论一致。确认要点:

- `lark-cli.ts:330` `params.command` 直接拼接 + `:267` 仅做非空校验,无字符过滤 + `:598-602` `shell:true` 全量 `env` → 命令注入 + env 泄露,**双双坐实**。
- `gateway.ts:643-662` `getTenantToken` 直接 throw、无单飞锁、第653行无 `res.ok`,**坐实**。
- `gateway.ts:1338-1341` `downloadFileToDir` 保留任意扩展名(对比同文件 `downloadImageToDir` 用 magic number),**坐实**。
- `feishuCommand.ts:2577-2578` `/bind` 经典 TOCTOU `existsSync`→`mkdirSync`,**坐实**。

证据充分,直接出报告。

---

# Otto 飞书企业 Agent 体系审计报告

## 1. 执行摘要

整体健康度:**功能完整度高,但工程成熟度配不上"企业级"定位**。代码已实现多群隔离会话、三层消息去重、CardKit 流式卡片、设备码授权等相当完整的能力,作者明显懂业务。但在**安全边界、并发正确性、长时运行的资源管理**三条线上有系统性欠债——这些恰恰是"卖给企业、24/7 常驻"场景的生死线。

收到 70+ 条原始发现,经源码逐条复核后:剔除/降级了 4 条不实或夸大的(详见第 2 节脚注),确认下来真正会咬人的 CRITICAL/HIGH 约 18 条。其中**安全类的两条命令执行问题最致命**——它们能把"飞书消息"变成"开发者机器上的任意代码执行"。

**最该先修的 5 件事(按"伤害 × 易发"排序):**

1. **`lark-cli.ts:330` 命令注入** — `params.command` 未做任何字符过滤就拼进 `shell:true` 的命令串。LLM 工具调用 → RCE。这是整条飞书提效链路里最大的洞。
2. **`lark-cli.ts:601` 全量环境变量泄露** — 子进程继承父进程所有 `env`(含各家 API key)。配合上一条或供应链攻击即可外泄全部密钥。
3. **`downloadFileToDir` 扩展名不净化(`gateway.ts:1338`)** — 飞书用户上传 `evil.sh`,原样落盘到项目目录,而 Agent 有 `run_shell_command`。外部用户 → 本机 RCE。
4. **fetch 普遍不查 `res.ok`(gateway.ts 28/31 处)** — 飞书 5xx/限流返回 HTML 时,真因被 `JSON.parse` 错误掩盖;`getTenantToken` 等关键路径直接抛异常。稳定性 + 可观测性双输。
5. **`getTenantToken` 无单飞锁 + 直接 throw(`gateway.ts:643`)** — 并发刷新风暴 + 抛异常未被多数调用方捕获。同代码库的 `CodexAuthManager` 已有正确的 `refreshPromise` 单飞实现可直接照搬。

一句话:**先堵两个 RCE,再补 token 链路的健壮性,然后才谈内存泄漏和企业功能缺口。**

---

## 2. 已确认的 CRITICAL / HIGH 问题

> 下表均已对照源码 file:line 复核。复核为"不实/夸大"的单列在表后并注明处置。

### CRITICAL

| 标题 | 位置 | 问题 | 修法 | 复核结论 |
|---|---|---|---|---|
| **命令注入:`params.command` 未净化** | `core/.../lark-cli.ts:330`(校验在 `:267`,执行在 `:598 shell:true`) | `cmdString = \`${binary} ${params.command}\``,`validateToolParams` 只查非空,零字符校验。`command="calendar +x; rm -rf ~"` 直达 shell | `buildCommand` 改 `${this.sanitizeArg(params.command)}`(`sanitizeArg` 已存在于 `:322`);并在 `:267` 加白名单 `/^[a-z0-9_+\-. ]+$/i` | **坐实 CRITICAL**。args 已用 sanitizeArg、as 已 enum,唯独 command 裸奔 |
| **全量 env 泄露给子进程** | `core/.../lark-cli.ts:601` | `env: { ...process.env }` 把 OPENAI/ANTHROPIC/GITHUB 等所有密钥传给 lark-cli 子进程,违反最小权限 | 白名单过滤:仅透传 `PATH/HOME/USER/LANG/LC_/TERM/TZ/NODE_/NPM_` 前缀的变量 | **坐实 CRITICAL**。配合命令注入或供应链攻击即可外泄全部密钥 |
| **lark-cli 输出重组命令再执行** | `core/.../lark-cli.ts:506-583`(尤其 550/556/571) | 从 lark-cli 错误输出用正则抽 domain/scope/flags,拼回命令经 `:441→:598 shell:true` 再执行;只剥尾引号,leading `$()`/反引号保留 | 对 domain 用官方域名白名单、scope 用 `/^[a-z_]+:[a-z_]+\.[a-z_]+/` 校验、flags 仅允许 `--domain/--scope`;输入加长度上限 | **坐实**(复核升级为 CRITICAL):供应链/MITM 下可注入 shell 命令 |
| **记忆持久化并发写竞态** | `core/.../memoryTool.ts:308-341` | 非原子 read-modify-write,无文件锁。并行 Sub-Agent / 并发飞书消息同时 `save_memory` → 后写覆盖先写,事实丢失 | 原子写 temp+rename,或引入 `proper-lockfile` | **坐实 HIGH/CRITICAL**。直接砸"懂你"卖点。注:产品有最多 6 并发 Sub-Agent + 异步消息分发两条触发路径 |
| **QR 注册轮询静默吞网络错误** | `cli/.../registration.ts:146-150` | catch 里直接 `continue`,无日志无传播。网络故障时用户只见转圈,要等 10 分钟超时 | 计数连续失败,~10-15 次后给用户面向人的提示并建议 `--manual` | **坐实**(首次接入 UX,严重度可定 HIGH) |

### HIGH

| 标题 | 位置 | 问题 | 修法 | 复核结论 |
|---|---|---|---|---|
| **fetch 普遍不查 `res.ok`** | `gateway.ts` 28/31 处(648/1678/1695/2164/2343/2403/2738 等) | 拿到 body 才查 `data.code`;飞书返 5xx/限流 HTML 时 `res.json()` 抛 `SyntaxError`,真因被掩盖 | 统一封装 `fetchJson()`:先 `if(!res.ok) return null`,再 `res.json()`,日志带 HTTP status + text | **坐实**(复核建议升 CRITICAL):覆盖 token 获取、发消息、上传、流式卡片等全部关键路径 |
| **`downloadFileToDir` 扩展名不净化** | `gateway.ts:1338-1341` | basename 净化了,`.sh/.py/.exe` 扩展名原样保留;落盘 `.easycode/inbound/` 后 Agent 可 `run_shell_command bash 之` | 扩展名白名单或按 MIME 赋安全扩展(参照同文件 `detectImageExtension` 的 magic-number 做法) | **坐实 HIGH**。外部飞书用户 → 本机 RCE |
| **`--exclude` scope 拼接 shell 注入** | `core/.../lark-cli.ts:410-411` | `--exclude "${uniqueExcludes.join(',')}"`,其中 `excludeScopes` 来自 `.easycode/settings.json`(用户可写),未 sanitize 也未校验格式 | 用 `sanitizeArg()` 包裹;`ProjectSettings.load()` 校验每个 scope 匹配 `/^[a-z_]+:[a-z_]+\.[a-z_]+$/` | **坐实 HIGH**。需本地写文件权限,但能在授权流里 RCE |
| **`getTenantToken` 无单飞锁** | `gateway.ts:643-662` | check 与 fetch 之间有竞态,并发到期请求各发一次 OAuth → 限流 429 / 状态不一致 | 加 `refreshPromise` 单飞,照搬同库 `CodexAuthManager:141-146` | **坐实**(复核定 medium,但企业并发下建议按 HIGH 处理) |
| **`getTenantToken` 缺 `res.ok` + 直接 throw** | `gateway.ts:648-656` | `:653` 未查 ok 就 `res.json()`;`:656` 抛带 `JSON.stringify(data)` 的异常;多数调用方(sendMessage:1664、uploadFile:2153 等)无 try-catch | 先查 ok 提取 status;调用方降级返回 null 而非链路中断 | **坐实 HIGH** |
| **错误消息泄露 token/API 响应** | `auth/feishuAuth.ts:285`、`gateway.ts:656`/`:1421` | 异常带原始 HTTP 响应/`JSON.stringify(data)`,经 catch 传到用户可见文本(HTML 错误页 / 飞书回复) | 加 `SensitiveDataFilter` 脱敏;只回错误码+人话描述,原文仅入 debug 日志 | **坐实 HIGH**。有实际可达的 user-facing 泄露路径 |
| **`isolatedSessions` 无回收 / 覆盖不释放** | `feishuCommand.ts:616/2859/995/4410` | Map 仅 `/feishu stop` 时清;覆盖旧 session 时旧 Config/GeminiClient 不主动释放;看门狗只查 loop 过期不查会话活跃。长跑 OOM 风险 | LRU 上限(≤100)+ 30min 无活动驱逐 + 看门狗加会话超时清理 | **坐实 HIGH**(延迟回收 + 无上限) |
| **`/bind` 目录创建 TOCTOU + 软链穿越** | `feishuCommand.ts:2576-2579` | `existsSync`→`mkdirSync` 经典 TOCTOU;projectRoot 后续 `isWithinRoot` 基于字符串不跟随软链,可指向 `/etc` | `realpathSync` 规范化 + 校验在允许父目录内;`mkdir {recursive,mode:0o700}` | **坐实 HIGH** |
| **并发 `/stop` 竞态:计数状态污染** | `feishuCommand.ts:2040-2072/3024/4341` | `/stop` 与旧 finally 双重 `decrementProcessingCount`;stop 到新消息被拒之间有窗口,新消息入队污染计数 → UI 状态错、事件错发 | 加 `stoppedChatIds` 原子标志维持 5-10s,入口检查拒新消息;或按全局递增 timestamp 过滤 | **坐实**(复核定高) |
| **跨会话串味(工具调用错发群)** | `feishuCommand.ts:2859/4354-4373/4410` | 覆盖 `isolatedSessions[chatId]` 时 while 循环仍持旧 config 引用 → 工具可能操作错误项目目录;看门狗迭代中会话被替换 | 覆盖前清理旧 session;`processMessageQueueForChat` 入口加 version check,迭代中变化即跳出 | **坐实**(复核定 Medium-High;触发需"消息连发+同 chatId 重绑")|
| **多用户 Config 共享(fallback 退化)** | `feishuCommand.ts:2743-2750/2866-2867` | 无 route 时 fallback 读共享 `activeConfig.getProjectRoot()`;隔离会话初始化失败时**永久**把共享 config 存进 `isolatedSessions`,自此无隔离 | 创建成功前不写占位为共享;失败时拒绝处理而非退化共享;用 `Map<chatId, Promise<Session>>` 防并发重复创建 | **坐实 MEDIUM-HIGH** |
| **跨用户记忆污染(无 scope 隔离)** | `core/.../memoryDiscovery.ts:85-93`、`memoryTool.ts:256` | 内存发现链路全程无 userId;多用户同 workspace 共享单一 `DEEPV.md`,A 的私密事实被加载进 B 的上下文 | 分层路径(global/project/user-{id});每条事实加 `[ts][user][confidence]` 元数据;加载按当前用户过滤 | **坐实 HIGH**。团队/敏感项目下是隐私泄露 |
| **记忆无上限/无去重** | `memoryTool.ts:336`、`memoryDiscovery.ts:241-269` | 纯 append 无去重无过期无大小限制;`readGeminiMdFiles` 不限大小全量载入。50 人一年 → 10 万+ 事实灌进每个 prompt | 加 `MAX_MEMORY_FILE_SIZE`、append 前子串去重、`bfsFileSearch` 限 maxDirs | **坐实 HIGH**。资源耗尽 + 成本飙升 |
| **设备码过期无倒计时 / 失败模式混淆** | `cli/.../registration.ts:119/185` | 默认 600s 过期但只显示 "Waiting...";超时/取消/拒绝三种失败回同一条 null + 同一句提示 | onProgress 带 deadline 显示倒计时;返回结构化 `{reason}` 区分超时/取消 | **坐实 HIGH**(首次接入 UX) |
| **凭证验证失败仍静默保存** | `cli/.../feishuCommand.ts:1271-1286`、`registration.ts:212-260` | `probeCredentials` 返 null 仍无条件 `saveCredentials`,用户到 `/feishu start` 才发现无效(对比手动流程 `:1432` 有检查) | `finalizeQrSetup` 检查 botInfo===null 时告警 fail-fast | **坐实 HIGH** |
| **遗留凭证致授权失效(owner 自锁)** | `cli/.../credentials.ts:216-225`、`feishuCommand.ts:1283` | `pollResult.openId` 为空时 `ownerOpenId` undefined 仍保存,setup 报"已配置"但所有人(含 owner)被拒 | 保存前校验 openId 非空;启动时 `isAuthorizationConfigured` 校验;加 `/feishu doctor` | **坐实**(复核降为 MEDIUM:实践中多数成功,可经 `/feishu allow` 补救;但隐形故障应修)|

### 复核判为"不实 / 降级",已剔除

- ❌ **getTenantToken 抛异常致"事件分发器崩溃"**(原标第1条 CRITICAL):复核证实主路径(1531-1542 inner catch)、高风险路径(1552-1554 outer catch)、文本选择路径(上层 try-catch)均有兜底,事件处理器始终返回 `{code:0}`。**降为 design smell(LOW)**——缺防守式编程但有多层兜底。*注:与"另一条 getTenantToken HIGH"不矛盾:那条针对的是单飞锁缺失 + res.ok 缺失 + 调用方一致性,是真问题。*
- ❌ **inFlightMessages 删除顺序致重复执行**(原 HIGH):复核证实 try-finally-return 语义 + `recordProcessedMessage` 同步落盘 + 飞书必须收 `{code:0}` 才停推,三重保证无竞态。**降为 LOW(建议)**。
- ❌ **`--as` 参数命令注入**(原 HIGH):三层 enum 校验(TS 类型 + `:283` 运行时 + schema enum)封死攻击路径。**降为 LOW(防御纵深/一致性)**。
- ❌ **全局 `activeAbortController` 跨群误杀**(原 CRITICAL):复核证实该变量全代码库**只被赋 null、从未赋真实 controller**,fallback 分支是死代码;真实 abort 全走 `activeAbortControllers` Map 且按 chatId 隔离。**判为 False Positive**。
- ❌ **`parseJSONSafe` 静默丢工具参数**(原 HIGH):`SchemaValidator` 显式识别 `__parseError` 标记并返回错误,40+ 工具均在 execute 前校验,不会静默执行。**判为设计改进项,非 bug**。
- ⚠️ **健康检查在 QR 之后**(原 HIGH):复核证实 `feishuCommand.ts:1164` 已在渲染 QR **之前**调 `initRegistration()`。**判为 False Positive**。

---

## 3. MEDIUM / LOW 问题归类

**资源/内存(MEDIUM):**
- `cardCallbacks` 超时 timer 在 messageId 不匹配时不清理,默认 30min TTL,繁忙系统可堆积上千条(`gateway.ts:595/1607/3332`)— 复核升 HIGH 量级,但触发需 ID 错配
- `sideQuestionControllers` 部分清理漏洞,abort 旧 controller 不 delete;`handleStop` 漏 clear(`feishuCommand.ts:791/857/4653`)
- `recentContents`/`highRiskHashes` 被动清理,空闲期不回收(`gateway.ts:460-462`)
- `isolatedSessions` 并发初始化非原子,可重复建资源(`feishuCommand.ts:2742-2859`)

**并发/状态(MEDIUM):**
- CardKit 流式 `sequence` 无互斥,并发推送可乱序(`gateway.ts:2527-2614`)
- 230020 限流无重试,流式 token 可丢(`gateway.ts:2729-2762`)
- `recentContents` 不持久化,重启后 5s 内同内容不去重(`gateway.ts:461`)— 复核定 Low-Medium,messageId 主防线仍在
- `handleSingleFeishuMessage` finally 版本检查仍有极窄竞态(`feishuCommand.ts:4019-4033`)
- 看门狗 `isPendingRun` 死锁堆积、async 任务无超时(`feishuCommand.ts:4407-4477`)

**安全(MEDIUM/LOW):**
- 软链路径穿越(import processor `memoryImportProcessor.ts:198-214`)
- 循环 import 深度 10 致指数读取 DoS(`memoryImportProcessor.ts:48`)
- Windows `taskkill` 不 await、无 fallback,可留僵尸进程(`lark-cli.ts:657`)
- 错误 JSON 解析无类型校验,可 prompt injection(`lark-cli.ts:823-838`)
- scope 抽取正则 ReDoS(`lark-cli.ts:529-537`)
- `appSecret` 明文 POST body / 不清零(协议固有,LOW)
- debug 日志可能暴露消息内容(`gateway.ts:560/1491`)
- 飞书消息文本无 prompt injection 防护(`feishuCommand.ts:2497`)

**一致性/可维护(LOW):**
- 错误处理风格不一(download 吞异常返 null vs upload 抛异常)
- credentials 文档写 `~/.deepv/` 实际 `~/.easycode-user/`(`credentials.ts:56-64`)
- 多处硬编码中文错误(`feishuAuth.ts:150` 等)
- Codex token JWT 结构未校验、非原子写(`codexAuth.ts:52/184`)
- SSE 帧解析 bare catch 静默丢事件(`customModelAdapter.ts:1612/1946/2199`)

---

## 4. 企业落地缺口(对"围绕飞书提效"目标,按优先级)

1. **审计日志缺失(P0 合规阻断)** — 无结构化操作日志、工具执行不记 `sender_open_id`、无不可篡改 audit.jsonl(`logger.ts:23`)。SOC2/ISO27001 直接卡死。这是"卖给企业"的硬门槛,不是 nice-to-have。
2. **记忆系统不可用于企业(P0 卖点阻断)** — 无结构化存储/检索/排序/去重/用户隔离,只 append 纯文本(`memoryTool.ts` + `memoryDiscovery.ts`)。产品文档自己承认"懂你是 P0 待建"。"懂你岗位"这条护城河目前是空的。
3. **无速率限制/配额** — 无 per-user/per-org 限流,工具调用无界,多群并发可打爆飞书共享配额、推高成本(`feishuCommand.ts:2507`)。
4. **授权模型过粗** — 仅 owner+allowlist,无 RBAC、无 per-project 权限、无授权审计、`/bind` 可让授权但不可信用户改工作目录/换 agent(提权)。50 项目 100 用户场景无法 scale。
5. **持久化健壮性弱** — `feishu-projects.json` 等无 schema 校验、非原子写、无备份、多进程无锁,损坏即丢全部群-项目绑定(`feishuCommand.ts:500`)。
6. **无对话历史/无崩溃恢复** — 消息实时拉取无本地副本;任务中途崩溃无 retry/checkpoint,且 `recordProcessedMessage` 在处理完成前就标记已处理,失败即丢(`gateway.ts:1503`)。
7. **存储无 GC** — `processed-messages`/`card-dumps` 等无限增长,无轮转无配额,长跑撑爆磁盘。

---

## 5. 建议的修复批次(P0 先行,可独立验证)

**P0 — 安全止血(独立可验,优先级最高,改动小):**
- `lark-cli.ts:330` command 加 sanitizeArg + 白名单 → 单测构造 `; rm` 验证被拒
- `lark-cli.ts:601` env 白名单过滤 → 子进程 `printenv` 断言无 API key
- `lark-cli.ts:410` `--exclude` sanitizeArg + settings 格式校验
- `lark-cli.ts:550/571` domain/scope 白名单
- `gateway.ts:1338` 下载扩展名白名单 → 上传 `evil.sh` 验证落盘为 `.bin`
- 验证手段:针对性单测 + 手工构造恶意 payload,全可在不连飞书的情况下跑。

**P1 — Token 链路与稳定性(独立可验):**
- 封装 `fetchJson()` 统一 `res.ok`,替换 gateway 28 处 → mock 5xx/HTML 响应断言返 null 不抛
- `getTenantToken` 加单飞锁(照搬 `CodexAuthManager`)+ res.ok + 调用方降级 → 并发 N 次只触发 1 次 OAuth
- 错误消息脱敏 `SensitiveDataFilter`
- 记忆并发写原子化(temp+rename)→ 并发 save_memory 测试零丢失

**P2 — 资源与并发正确性:**
- `isolatedSessions` LRU + 超时驱逐 + 覆盖时释放
- 并发 `/stop` 原子标志 + 跨会话 version check
- 多用户 Config fallback 不退化共享
- `cardCallbacks` TTL 清理

**P3 — 企业落地(较大工程,需单独立项):**
- 审计日志系统(P0 合规但工程量大,故排 P3 启动)
- 记忆结构化存储 + 检索 + 用户隔离(产品卖点)
- RBAC + 速率限制 + 持久化原子写/schema 校验

---

**取舍说明:** 我把两个命令执行洞排在所有"内存泄漏"之前——内存泄漏要数周长跑才显现且 GC 兜底,而 RCE 是一条飞书消息的事。审计日志虽是企业 P0 合规项,但工程量大、可与代码并行,故放 P3 启动而非 P0 阻塞止血。复核中 6 条被否的发现已明确剔除,不掺进修复清单浪费工时——其中"全局 activeAbortController 跨群误杀"和"健康检查顺序"两条若不核源码很容易误修,特此标注为 False Positive。

关键源码位置(均绝对路径):
- `/Users/felix/Desktop/EasyCode/packages/core/src/tools/lark-cli.ts`(命令注入/env/scope 注入,行 267/330/410/550/571/601)
- `/Users/felix/Desktop/EasyCode/packages/cli/src/services/feishu/gateway.ts`(fetch/token/下载,行 643/1338,及 28 处 fetch)
- `/Users/felix/Desktop/EasyCode/packages/cli/src/ui/commands/feishuCommand.ts`(会话/并发/bind,行 616/2576/2743/2859/4410)
- `/Users/felix/Desktop/EasyCode/packages/core/src/tools/memoryTool.ts` + `/Users/felix/Desktop/EasyCode/packages/core/src/utils/memoryDiscovery.ts`(记忆)
- `/Users/felix/Desktop/EasyCode/packages/cli/src/services/feishu/registration.ts`(QR/设备码 UX)
- `/Users/felix/Desktop/EasyCode/packages/cli/src/services/feishu/credentials.ts`(授权)