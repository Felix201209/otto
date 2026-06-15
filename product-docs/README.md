# Otto · 产品总纲

> **一句话定位**：让企业里每个员工，都有一个**住在飞书里、懂他、替他干活的 AI 数字同事**。
>
> **形态**：本机 CLI 后端（跑在用户自己电脑上，像 easycode）+ 飞书。**不是云端多租户 SaaS。**
> **品牌**：Otto｜CLI = **Otto Code**（对标 Easy Code）｜家族：Otto / Otto Code / Otto Desk / Otto Work / Otto Studio。
> **底座**：基于开源 **easycode**（Apache-2.0，源自 Google Gemini CLI）二次开发的**独立产品**，与猎豹移动 / OrionStar 无任何关联；源码 Apache 版权头按合规保留（用户不可见）。

---

## 这是什么

Otto 围绕**飞书**帮企业大幅提效。它不是又一个云端 SaaS，而是一套**跑在用户本机的 CLI 后端**，通过飞书与人对话、替人干活：读日程、查文档、整理表格、跑任务。每个员工因此拥有一个**属于自己、记得自己、按自己岗位办事**的数字同事。

底座是开源的 easycode（一个 coding agent CLI）。我们在它现成的 agent 骨架、飞书网关、多模型适配器之上做**增量嫁接**——不重写——把"写代码的 agent"重塑为"在飞书办公的数字同事"。

---

## 能力清单（诚实分层，没做的不说成做了）

### ✅ 已完成并构建 / 实测验证

| 能力 | 验证状态 |
|------|----------|
| **Codex 双鉴权**（OAuth + API Key） | 实测 HTTP 200 + 文本流通过；明确**不做 Claude OAuth** |
| **多模型配置**（`custom-models.json` 多条：Codex / DeepSeek / OpenAI） | `/model` 可热切换 |
| **全量 rebrand → Otto** | 覆盖 172 个文件，构建全绿 |
| **安全止血** | 命令注入 RCE、下载扩展名 RCE、全量 env 密钥泄露、`--exclude` 注入、lark-cli 输出重组注入 **全部封堵**，恶意 payload 实测拦截 |
| **记忆并发写串行化** | 20/20 并发零丢失 |
| **token 链路健壮性** | `getTenantToken` 单飞锁 + `res.ok` 校验 + 脱敏；令牌交换脱敏 |
| **会话 idle 回收** | 防长跑 OOM |

> token 自动刷新代码已按实测参数写好，但**未到期触发验证**——如实标注，不冒充"已验证"。

### 📋 下一步大特性（已设计 / 还没建）

| 特性 | 价值 |
|------|------|
| **结构化记忆 / 按会话隔离** | "懂你岗位"护城河，**P0 卖点**。现状只是往文件追加文本，无结构化检索 |
| **企业审计日志** | 合规刚需 |
| **速率限制** | 防滥用 / 控成本 |
| **RBAC** | 权限分级 |

---

## 当前所在阶段

**止血已收敛，下一步建护城河。**

第一阶段（安全 + 工程成熟度）的致命洞已堵住、并发正确性已校准、鉴权与模型链路已打通并实测。审计报告的 87 条发现里，高危项已修，剩余基本是上面那批"大特性"。接下来的重心从"别出事"转向"做出护城河"——把结构化记忆这个 P0 卖点真正建起来。

---

## 文档索引

| 文件 | 内容 |
|------|------|
| [回家快速试用.md](回家快速试用.md) | **想试就看这个**：配模型 → 启动 → 飞书扫码连本人身份，三步跑起来 |
| [Codex双鉴权-使用与实现.md](Codex双鉴权-使用与实现.md) | Codex OAuth + API Key 双鉴权的用法与实现（已实测通过） |
| [PRD.md](PRD.md) | 完整产品需求：定位 / 护城河 / 功能 / MVP 范围 / 路线图 / 商业化 / 风险红线 |
| [架构设计.md](架构设计.md) | 技术架构：harness 嫁接、记忆层、模型网关、鉴权层、独立化补丁点 |
| [agent人设-system-prompt.md](agent人设-system-prompt.md) | 把"coding agent"重塑为"数字同事 Otto"的 system prompt 草稿 + 接入点 |
| [命名与品牌.md](命名与品牌.md) | 品牌、家族命名、slogan、商标 / 域名 checklist |
| [审计/audit-report.md](审计/audit-report.md) | 飞书企业 agent 体系审计报告（87 发现，高危已修，剩余为大特性） |
| [landing/index.html](landing/index.html) | 产品落地页（Firefox 直接打开，自包含单文件） |
| [_source/architecture-v2.md](_source/architecture-v2.md) | 架构参考：Hermes harness 经 easycode 现有 `turn.ts` BeforeModel/AfterModel 钩子接入；记忆三层（全局/项目/会话）设计；Codex 鉴权 |
| [_source/](_source/) | 其余原始产出：命名 workflow、产品蓝图（给后续 agent 打底） |

---

## 关键技术结论

1. **增量嫁接，不是重写**：easycode 已有飞书网关（`gateway.ts` 3400+ 行）、隔离会话、`turn.ts` 的 BeforeModel/AfterModel 钩子、多 provider 适配器、proxyAuth token 管理。harness / 记忆 / Codex 鉴权都是借现成扩展点接入。
2. **记忆三层设计已就位**：全局 / 项目 / 会话 三层，是"懂你岗位"护城河的承载结构。但**结构化检索本身还没建**——目前仍是文件追加文本，这是 P0，不是已成熟的卖点，对外别吹。
3. **本机形态的独立性是实的**：自定义模型直连 provider，不走任何第三方后端、不要求登录第三方账号。
4. **安全边界已止血**：5 类可达的 RCE / 密钥泄露 / 注入路径全部封堵并实测拦截；token 链路加了单飞锁与脱敏；会话有 idle 回收防 OOM。

---

## 怎么试

照 [回家快速试用.md](回家快速试用.md) 做三步：

1. **配模型** — 写 `~/.easycode-user/custom-models.json`（key 用环境变量占位，绝不写死）。
2. **启动** — `npm start`，在界面里 `/model` 选你配的模型。
3. **连飞书** — 对话里说"看我今天的飞书日程"，弹二维码 → 手机飞书扫码授权 → 它用**你本人的飞书身份**替你办事。

---

*底座 easycode（Apache-2.0，源自 Google Gemini CLI）的版权与 NOTICE 已按开源义务保留。*
