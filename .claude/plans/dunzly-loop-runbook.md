# Dunzly 自主循环 Runbook

> 模式:`/loop-start` 自主连续("一直做")· safe · 单仓库 `/Users/felix/Desktop/EasyCode` · 分支 `dunzly`
> 目标:给企业一套**围绕飞书**大幅提效的方案(本机 CLI 后端 + 飞书,对标 Easy Code,Hermes harness/记忆,Codex 双鉴权)。
> 停止条件:见各阶段"完成判据";全部满足且审计无新增高优问题 → 循环收敛,汇报待 Felix 飞书授权。

## 品牌(已定)
- 产品名 **Dunzly**;CLI = **Dunzly Code**(对标 Easy Code)。
- 家族:Dunzly / Dunzly Code / Dunzly Desk / Dunzly Work / Dunzly Studio。
- 工作名替换:`同崽`、`Easy Code`、`EasyCode`、`DeepV Code` → `Dunzly`(用户可见层)。
- 保留(合规/结构性):Apache 版权头(Google LLC / Easy Code team)、内部包名 `deepv-code-core`、类名 `DeepVServerAdapter`、记忆文件名 `DEEPV.md`(功能性,后续单独议)。

## 阶段与完成判据
- **P0 Codex 双鉴权** ✅ 已完成并实测(HTTP 200 + 文本流)。
- **R 全量 rebrand → Dunzly**:用户可见名全换;`npm run build` 三包 SUCCESS;dist 含 Dunzly;版权头/内部名未伤。
- **M 多模型配置**:CLI 像 Easy Code 且支持多模型(custom-models.json 多条 + Codex + API key 共存),`/model` 可切;实测加载多条不报错。
- **W 工作流/产品审计(核心)**:用 Workflow 从里到外审飞书 agent 体系(gateway/会话隔离/lark-cli/记忆/鉴权/错误处理/onboarding)→ 列问题(分级)→ 逐条改 + 验证 → 迭代到无新增高优问题。
- **P1 Hermes 记忆(可选,按审计优先级)**:turn.ts 钩子挂 prefetch/syncTurn + 飞书 chatId 当 sessionId;实测会话内记得、跨会话隔离。

## 安全纪律
- 每次改动后 `npm run build` 验证(对照绿基线);破坏性/不可逆操作停下确认。
- 不动认证逻辑除非有实测;不盲改内部模块名(会崩构建)。
- 飞书授权由 Felix 本人完成(不替他扫码)。
- 进度与改动如实汇报,失败带原始输出。

## 监控
- 改动均在 `dunzly` 分支、未提交:`git diff` 审;回滚 `git checkout -- <file>`。
- 产物文档:`product-docs/`;审计报告将写入 `product-docs/审计/`。
