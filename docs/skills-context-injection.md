# Skills Context 注入机制

**文档版本：** 1.0
**最后更新：** 2026-02-05
**维护者：** Otto Team

---

## 📋 概述

Skills Context 注入机制负责将已启用的 Skills 元数据注入到 AI 的 system prompt 中，使 AI 能够：
- 发现可用的 Skills
- 了解每个 Skill 的功能描述
- 识别哪些 Skills 包含可执行脚本
- 主动推荐用户使用相关 Skills

---

## 🏗️ 架构设计

### 核心组件

```
┌─────────────────────────────────────────────────────────────┐
│                    CLI 启动流程                              │
│  gemini.tsx:296 → initializeSkillsContext()                │
└─────────────────────┬───────────────────────────────────────┘
                      │
                      ▼
┌─────────────────────────────────────────────────────────────┐
│            Skills Integration Layer                          │
│  skills-integration.ts                                       │
│  - initializeSkillsContext(): 启动时加载                     │
│  - getSkillsContext(): 获取缓存                              │
│  - clearSkillsContextCache(): 清除缓存                       │
│  - cachedSkillsContext: 5分钟 TTL 缓存                       │
└─────────────────────┬───────────────────────────────────────┘
                      │
                      ▼
┌─────────────────────────────────────────────────────────────┐
│           Skill Context Injector                             │
│  skill-context-injector.ts                                   │
│  - injectStartupContext(): 生成元数据 XML                    │
│  - formatMetadataContext(): 格式化为 <available_skills>      │
└─────────────────────┬───────────────────────────────────────┘
                      │
                      ▼
┌─────────────────────────────────────────────────────────────┐
│            System Prompt Builder                             │
│  prompts.ts → getCoreSystemPrompt()                          │
│  - 调用 getSkillsContext() 获取缓存的元数据                  │
│  - 注入到 finalPrompt                                        │
└─────────────────────────────────────────────────────────────┘
```

---

## 🔄 注入流程

### 1. 启动时初始化（Primary Injection）

**入口点：** `packages/cli/src/gemini.tsx:296-299`

```typescript
const { initializeSkillsContext } = await import('easycode-core');
await initializeSkillsContext();
```

**流程：**
1. 扫描所有已启用的 Skills
2. 加载元数据（名称、描述、脚本列表）
3. 格式化为 XML 格式的 `<available_skills>`
4. 缓存到内存（`cachedSkillsContext`）
5. 估算 Token 成本（~150 tokens/skill）

**缓存配置：**
- **TTL：** 5 分钟
- **存储位置：** `packages/core/src/skills/skills-integration.ts:9-10`
- **清除时机：** Skills 安装/卸载/启用/禁用时

---

### 2. System Prompt 构建（Injection Point）

**注入点：** `packages/core/src/core/prompts.ts:1152-1157`

```typescript
// Inject Skills context (cached from startup)
const skillsContext = getSkillsContext();
if (skillsContext) {
  finalPrompt += `\n\n${skillsContext}`;
}
```

**触发时机：**
- CLI 启动时（`startChat()`）
- MCP Prompts 更新时（`updateSystemPromptWithMcpPrompts()`）
- 模型切换时（重建 GeminiChat）

---

### 3. 输出格式

**XML 格式示例：**

```xml
# Available Skills

You have access to specialized Skills that provide domain knowledge, workflows, and executable scripts.

<available_skills>
<skill>
<name>pdf</name>
<type>document-processing</type>
<description>PDF document processing skill 📜 **Has executable scripts: extract_text.py**. You MUST use the use_skill tool to load instructions before executing any scripts. DO NOT write new code if scripts are available. (plugin:document-skills)</description>
<location>plugin</location>
<has_scripts>true</has_scripts>
<scripts>
  <script>extract_text.py</script>
</scripts>
</skill>
<skill>
<name>excel</name>
<type>document-processing</type>
<description>Excel spreadsheet processing skill (plugin:document-skills)</description>
<location>plugin</location>
</skill>
</available_skills>

**Mandatory Skill Usage**:
If a skill's description says it MUST be used for the current task, you MUST call `use_skill` before doing any work.
When in doubt, prefer loading the skill first.

**Important**: Skills marked with 📜 or <has_scripts>true</has_scripts> have executable scripts.
You MUST use the `use_skill` tool to load their instructions before executing any scripts.
See the `use_skill` tool description for complete usage instructions.

**Token cost**: ~300 tokens (metadata only, full instructions loaded on-demand)
```

---

## 🎯 自动触发机制

### 设计目标

确保 AI 能够主动识别并调用符合当前任务的 Skills，而不是被动等待用户明确指令。

### 触发规则

**硬性指令（位于 `skills-integration.ts`）：**

```markdown
**Mandatory Skill Usage**:
If a skill's description says it MUST be used for the current task, you MUST call `use_skill` before doing any work.
When in doubt, prefer loading the skill first.
```

### 典型触发模式

| 用户请求 | Skill Description 关键字 | AI 应执行 |
|---------|------------------------|----------|
| "我们来讨论一下系统重构" | "You MUST use this before any creative work" | 自动调用 `brainstorming` skill |
| "帮我修复这个 bug" | "Use when encountering any bug" | 自动调用 `systematic-debugging` skill |
| "实现这个功能" | "Use when implementing any feature" | 自动调用 `test-driven-development` skill |
| "审查这段代码" | "Use when completing tasks...before merging" | 自动调用 `requesting-code-review` skill |

### 触发流程

```
用户输入
    ↓
AI 解析任务意图
    ↓
检查 Skills 元数据中的 description
    ↓
匹配 "MUST be used" 等硬性条件？
    ↓ Yes
调用 use_skill 加载完整指令
    ↓
按 Skill 指令执行工作流
```

### 兜底策略

**"When in doubt, prefer loading the skill first"**

- 当不确定是否需要 Skill 时，优先加载
- Skill 加载的 Token 成本远低于错误的实现
- 用户可以在 Skill 加载后决定是否继续

### ⚠️ Skill Description 编写规范

**重要：谨慎使用 "MUST" 关键字**

自动触发机制依赖 Skill description 中的硬性指令（如 "You MUST use this..."）。**不当使用可能导致误触发**。

**✅ 正确使用示例：**
```markdown
You MUST use this before any creative work - creating features,
building components, adding functionality, or modifying behavior.
```
- 触发条件明确（creative work）
- 适用场景清晰（creating, building, modifying）

**❌ 错误使用示例：**
```markdown
You MUST use this for ANY task.
```
- 触发条件过于宽泛
- 会导致每个任务都被误触发

**编写建议：**
1. **精确描述触发条件** - 使用具体的任务类型（如 "debugging", "refactoring", "testing"）
2. **避免模糊词汇** - 不要使用 "ANY task", "ALL work" 等过于宽泛的表述
3. **提供示例场景** - 在 description 中举例说明何时应该触发
4. **测试触发准确性** - 创建 Skill 后测试是否会误触发

**参考 Superpowers Skills 的良好实践：**
- `brainstorming`: "before any **creative work**" - 明确指创意性工作
- `systematic-debugging`: "when encountering any **bug**" - 明确指调试场景
- `test-driven-development`: "when **implementing** any feature" - 明确指实现阶段

### 实现细节

**关键代码位置：** `packages/core/src/skills/skills-integration.ts:64-66`

```typescript
**Mandatory Skill Usage**:
If a skill's description says it MUST be used for the current task, you MUST call \`use_skill\` before doing any work.
When in doubt, prefer loading the skill first.
```

**为什么放在这里？**
1. **集中管理** - 与 Skills 元数据在同一处，避免规则分散
2. **易于维护** - 修改规则只需更新一处
3. **紧邻元数据** - AI 在看到 Skills 列表时立即看到使用规则
4. **简洁明确** - 硬性指令，没有歧义

---

## 📌 关键场景

### 场景1：CLI 启动
```
1. gemini.tsx 启动
2. initializeSkillsContext() 加载并缓存
3. startChat() 调用 getCoreSystemPrompt()
4. getSkillsContext() 返回缓存
5. Skills context 注入到 system instruction
```

### 场景2：`/session new` 开新会话
```
1. createNewSession() 创建新会话
2. setHistory(clientHistory) 切换对话历史
3. ⚠️ System instruction 不变（已包含 Skills）
4. ✅ 新会话继承 Skills context
```

**关键点：** `setHistory()` 只更新对话历史，不更新 system instruction。

### 场景3：`/compress` 压缩上下文
```
1. tryCompressChat() 执行压缩
2. compressHistory() 生成摘要 + 保留最近历史
3. setHistory(newHistory) 更新历史
4. ⚠️ System instruction 不受影响
5. ✅ Skills context 始终保留
```

**关键点：** 压缩只影响对话历史（Content[]），不影响 system instruction。

### 场景4：MCP Prompts 更新
```
1. updateSystemPromptWithMcpPrompts() 触发
2. getCoreSystemPrompt() 完整重建
3. ✅ 包含所有组件：base + dynamic + MCP + Skills
4. setSystemInstruction(updatedSystemPrompt) 应用
```

**关键点：** 每次重建都会自动包含 Skills context。

---

## 🔧 维护指南

### 何时需要清除缓存？

**自动清除：** 以下命令会自动调用 `clearSkillsContextCache()`

- `/skill install <plugin>` - 安装新 Plugin
- `/skill uninstall <plugin>` - 卸载 Plugin
- `/skill enable <skillName>` - 启用 Skill
- `/skill disable <skillName>` - 禁用 Skill

**手动清除：** 如果需要手动刷新缓存

```typescript
import { clearSkillsContextCache } from 'easycode-core';
clearSkillsContextCache();
```

---

### 如何验证 Skills 是否正确注入？

#### 方法1：环境变量导出 System Prompt

```bash
# 导出当前 system prompt 到文件
GEMINI_WRITE_SYSTEM_MD=1 easycode

# 查看导出的文件
cat ~/.easycode/system.md | grep -A 20 "Available Skills"
```

#### 方法2：运行时日志

启动 CLI 时查看日志：

```bash
easycode
# 查看日志输出中的 Skills 加载信息
# [Skills] Loaded 3 enabled skills
# [Skills] Estimated tokens: ~450
```

#### 方法3：单元测试

```bash
# 运行 Skills context 注入测试
npx vitest run packages/core/src/core/prompts.test.ts
```

---

### 常见问题排查

#### 问题1：AI 看不到已安装的 Skills

**排查步骤：**
1. 检查 Skill 是否已启用：`/skill list`
2. 检查缓存是否过期（5分钟 TTL）
3. 重启 CLI 强制刷新缓存
4. 检查 `initializeSkillsContext()` 是否被调用

**验证命令：**
```bash
# 检查已启用的 Skills
/skill list --enabled

# 重启 CLI
/quit
easycode
```

#### 问题2：Skills 变更后 AI 仍显示旧信息

**原因：** 缓存未清除

**解决方法：**
- 等待 5 分钟缓存自动过期
- 或执行安装/卸载/启用/禁用命令（会自动清除缓存）
- 或重启 CLI

#### 问题3：Token 成本过高

**分析：**
- 元数据注入：~150 tokens/skill
- 10个 Skills：~1500 tokens
- 如果超出预期，检查是否误用了 Level 2（完整内容）

**优化建议：**
- 只启用必要的 Skills
- 使用 `/skill disable <name>` 禁用不常用的 Skills

#### 问题4：AI 没有自动调用相关 Skill

**症状：**
- 用户说"讨论系统重构"，但 AI 没有调用 `brainstorming` skill
- Skill description 中有 "MUST be used"，但 AI 忽略了

**排查步骤：**
1. 检查 Skills context 是否包含自动触发规则
2. 检查 Skill description 是否明确说明触发条件
3. 验证 AI 使用的系统提示词版本

**验证命令：**
```bash
# 导出系统提示词检查
GEMINI_WRITE_SYSTEM_MD=1 easycode

# 搜索自动触发规则
cat ~/.easycode/system.md | grep "Mandatory Skill Usage"
```

**预期输出：**
```
**Mandatory Skill Usage**:
If a skill's description says it MUST be used for the current task, you MUST call `use_skill` before doing any work.
When in doubt, prefer loading the skill first.
```

**解决方法：**
- 如果没有找到规则，升级到 v1.1+ 版本
- 重启 CLI 确保使用最新的系统提示词

---

## 📊 性能指标

| 指标 | 数值 | 说明 |
|------|------|------|
| **启动时加载** | ~100ms | 扫描并缓存所有 Skills 元数据 |
| **Token 成本** | ~150 tokens/skill | 仅元数据（名称+描述+脚本列表） |
| **缓存 TTL** | 5 分钟 | 平衡性能与实时性 |
| **注入开销** | <1ms | 从缓存读取，无 I/O |

---

## 🔗 相关文件

### 核心代码
- `packages/core/src/skills/skills-integration.ts` - 缓存管理
- `packages/core/src/skills/skill-context-injector.ts` - 格式化逻辑
- `packages/core/src/core/prompts.ts` - 注入点
- `packages/cli/src/gemini.tsx` - 启动入口

### 测试文件
- `packages/core/src/core/prompts.test.ts` - System prompt 测试
- `packages/core/src/skills/skill-context-injector.test.ts` - Injector 测试

### 相关文档
- `docs/skills-usage.md` - Skills 使用指南
- `docs/HOOKS_INDEX.md` - Hooks 系统文档
- `docs/archive/SKILL_MIGRATION.md` - Skills 系统迁移指南

---

## ⚠️ 重要注意事项

### 🚨 禁止事项

1. **❌ 不要直接修改 `cachedSkillsContext`**
   - 始终通过 `initializeSkillsContext()` 更新缓存
   - 始终通过 `clearSkillsContextCache()` 清除缓存

2. **❌ 不要在 `setHistory()` 中注入 Skills**
   - Skills context 属于 system instruction
   - 对话历史（Content[]）不应包含 Skills 信息

3. **❌ 不要绕过缓存直接调用 `injectStartupContext()`**
   - 缓存存在是为了性能优化
   - 直接调用会导致重复的文件系统扫描

### ✅ 最佳实践

1. **使用缓存机制**
   ```typescript
   // ✅ 正确：使用缓存
   const skillsContext = getSkillsContext();

   // ❌ 错误：直接调用
   const injector = new SkillContextInjector(...);
   const result = await injector.injectStartupContext();
   ```

2. **及时清除缓存**
   ```typescript
   // 修改 Skills 配置后
   await settingsManager.disableSkill(skillId);
   clearSkillsContextCache(); // ✅ 立即清除缓存
   ```

3. **验证注入结果**
   ```typescript
   // 在测试中验证
   const prompt = getCoreSystemPrompt();
   expect(prompt).toContain('<available_skills>');
   ```

---

## 📝 变更日志

### v1.1 (2026-02-05)
- ✅ **添加自动触发规则** - 新增 `Mandatory Skill Usage` 硬性指令
- ✅ **增强 AI 理解** - 明确要求在 skill description 指示时自动调用 `use_skill`
- ✅ **优化决策策略** - 添加 "When in doubt, prefer loading the skill first" 兜底机制
- ✅ **集中管理规则** - 规则与元数据统一在 `skills-integration.ts` 中管理

**改进背景：**
之前虽然 Skills 元数据成功注入，但 AI 不会主动根据 description 中的触发条件（如 "You MUST use this before any creative work"）自动调用相应 skill。通过添加集中、明确的硬性指令，解决了自动触发缺失的问题。

### v1.0 (2026-02-05)
- ✅ 初始版本
- ✅ 修复 Skills context 未注入的 bug
- ✅ 添加完整的多场景验证
- ✅ 添加缓存机制文档

---

## 🧪 自动触发机制测试

### 快速验证脚本

创建临时测试文件 `test-skill-trigger.js`：

```javascript
#!/usr/bin/env node
import { initializeSkillsContext, getSkillsContext } from './packages/core/dist/src/skills/skills-integration.js';

async function testSkillTrigger() {
  console.log('🧪 测试 Skills 自动触发规则注入...\n');

  await initializeSkillsContext();
  const context = getSkillsContext();

  const checks = [
    { name: '自动触发规则', pattern: /Mandatory Skill Usage/, critical: true },
    { name: 'MUST call use_skill', pattern: /MUST call `use_skill` before doing any work/, critical: true },
    { name: 'When in doubt 指引', pattern: /When in doubt, prefer loading the skill first/, critical: true },
  ];

  let passed = 0, failed = 0;
  for (const check of checks) {
    const found = check.pattern.test(context);
    console.log(`${found ? '✅' : '❌'} ${check.name}: ${found ? 'FOUND' : 'NOT FOUND'}`);
    found ? passed++ : (check.critical && failed++);
  }

  console.log(`\n📊 结果: ${passed}/${checks.length} 通过`);
  if (failed > 0) {
    console.log(`❌ ${failed} 个关键检查失败`);
    process.exit(1);
  } else {
    console.log('✅ 所有关键检查通过！');
  }
}

testSkillTrigger().catch(err => {
  console.error('❌ 测试失败:', err);
  process.exit(1);
});
```

运行测试：

```bash
node test-skill-trigger.js
```

**预期输出：**

```
🧪 测试 Skills 自动触发规则注入...

✅ 自动触发规则: FOUND
✅ MUST call use_skill: FOUND
✅ When in doubt 指引: FOUND

📊 结果: 3/3 通过
✅ 所有关键检查通过！
```

**⚠️ 测试完成后立即删除此临时脚本：**

```bash
rm test-skill-trigger.js
```

> 注意：根据项目规范，临时测试脚本完成验证后必须删除，不应提交到代码仓库。

### 集成测试

在实际对话中测试：

```bash
easycode
# 输入测试用例
> 我们来讨论一下系统重构
```

**预期行为：**
AI 应该自动调用 `use_skill(skillName="superpowers:superpowers:brainstorming")`

如果 AI 没有自动调用，检查：
1. 是否使用了最新构建的版本
2. system prompt 是否包含自动触发规则（见上文验证命令）

---

## 🤝 贡献指南

如需修改 Skills Context 注入机制，请：

1. 阅读本文档了解现有架构
2. 修改代码前先更新单元测试
3. 验证所有场景（启动、新会话、压缩、MCP更新）
4. **验证自动触发机制** - 使用上述测试脚本
5. 更新本文档的相关章节
6. 提交时注明影响范围

---

**维护联系：** Otto Team
**问题反馈：** https://github.com/OrionStarAI/OttoCode/issues
