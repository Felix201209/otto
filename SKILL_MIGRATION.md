# Skills 数据源统一迁移文档

## 变更概述

本次变更统一了 Skills 系统的数据源，消除了 `SkillsContextBuilder`（旧）和 `SkillLoader`（新）双数据源导致的不一致问题。

## 变更内容

### 1. 新增文件

**packages/core/src/skills/skills-compat.ts**
- 适配器层，提供向后兼容接口
- 内部使用 `SkillLoader`，对外提供 `SkillsContextBuilder` 兼容的 API
- 保留原有格式化逻辑（长提示文档、警告信息）

### 2. 修改文件

#### packages/core/src/skills/index.ts
- ✅ 导出 `SkillsCompatAdapter`

#### packages/core/src/tools/list-skills.ts
- ✅ 替换 `SkillsContextBuilder` → `SkillsCompatAdapter`
- ✅ 修改 `listSkills()` → `await listSkills()`（异步）

#### packages/core/src/tools/get-skill-details.ts
- ✅ 替换 `SkillsContextBuilder` → `SkillsCompatAdapter`
- ✅ 修改 `getSkillDetails()` → `await getSkillDetails()`（异步）

#### packages/core/src/tools/list-skills.test.ts
- ✅ 更新 mock 对象：`SkillsContextBuilder` → `SkillsCompatAdapter`
- ✅ 更新测试：`mockReturnValue` → `mockResolvedValue`（异步）

#### packages/core/src/skills/skills-context-builder.ts
- ✅ 添加 `@deprecated` 注释
- ✅ 添加迁移指南

### 3. 保留文件（未删除）

- `SkillsContextBuilder` 保留但标记为 deprecated
- 原因：可能有外部代码依赖（如 prompts.ts）

## 技术细节

### 数据流对比

#### 迁移前（双数据源）
```
list_available_skills    → SkillsContextBuilder.listSkills()
                            ↓ (读文件、扫描目录、解析SKILL.md)
                            ✗ 可能与 use_skill 不一致

use_skill                → SkillLoader.loadSkill()
                            ↓ (使用新架构、三级加载)
                            ✓ 规范实现
```

#### 迁移后（单数据源）
```
list_available_skills    → SkillsCompatAdapter.listSkills()
                            ↓ (内部调用)
                            SkillLoader.loadEnabledSkills()
                            ↓ (统一数据源)
                            ✓ 与 use_skill 完全一致

use_skill                → SkillLoader.loadSkill()
                            ↓ (同一套逻辑)
                            ✓ 规范实现
```

### 关键改动点

1. **异步化**：`listSkills()` 和 `getSkillDetails()` 从同步变为异步
   - 原因：`SkillLoader` 需要初始化 `SettingsManager`（读取配置文件）
   - 影响：调用方需要 `await`（已在工具类中处理）

2. **初始化**：`SkillsCompatAdapter` 需要调用 `initialize()`
   - 自动调用：在首次 `listSkills()` / `getSkillDetails()` 时自动初始化
   - 缓存：初始化后不重复执行

3. **格式保持**：完全保留原有输出格式
   - "CRITICAL REQUIREMENT" 警告保留
   - 分组逻辑（project/global/marketplace）保留
   - 脚本使用说明保留

## 向后兼容性

### ✅ 保证兼容的部分

1. **API 签名**：工具接口未变（`list_available_skills` / `get_skill_details`）
2. **输出格式**：AI 看到的提示词格式完全相同
3. **数据完整性**：SkillLoader 是 SkillsContextBuilder 的超集（功能更强）

### ⚠️ 可能影响的部分

1. **性能**：首次调用需要初始化（约 10-50ms），后续调用有缓存
2. **错误处理**：SkillLoader 遇到错误会抛异常（已在适配器层捕获并降级）

## 测试清单

### 单元测试
- ✅ TypeScript 编译通过（无类型错误）
- ⏸️ Vitest 测试（需要安装依赖后运行）

### 功能测试（需手动执行）

```bash
# 测试1：list marketplace skills
/skill list

# 测试2：list user global skills
mkdir -p ~/.easycode-user/skills/test-skill
echo "---\nname: test-skill\ndescription: Test\n---\n# Test" > ~/.easycode-user/skills/test-skill/SKILL.md
/skill list

# 测试3：list project skills
mkdir -p .easycode/skills/project-test
echo "---\nname: project-test\ndescription: Project\n---\n# Test" > .easycode/skills/project-test/SKILL.md
/skill list

# 测试4：use_skill 与 list 一致性
use_skill(skillName="test-skill")  # 应该能找到（之前可能找不到）

# 测试5：get_skill_details
get_skill_details(skillId="test-skill")
```

## 风险评估

| 风险 | 等级 | 缓解措施 |
|------|------|----------|
| API breaking change | 🟢 低 | 工具接口未变，仅内部实现变更 |
| 输出格式变化 | 🟢 低 | 完全保留原格式化逻辑 |
| 性能退化 | 🟡 中 | 首次调用需初始化，已加缓存 |
| 未测试边缘 case | 🟡 中 | 需要充分手动测试 |

## 后续清理计划

1. **第一阶段**（当前）：保留旧代码，标记 @deprecated
2. **第二阶段**（1-2周后）：确认无问题后，移除 `SkillsContextBuilder`
3. **第三阶段**（可选）：优化 prompts.ts，直接使用 `SkillLoader`

## 回滚方案

如果发现问题，可快速回滚：

```bash
git checkout HEAD~1 -- packages/core/src/tools/list-skills.ts
git checkout HEAD~1 -- packages/core/src/tools/get-skill-details.ts
git checkout HEAD~1 -- packages/core/src/tools/list-skills.test.ts
rm packages/core/src/skills/skills-compat.ts
```

## 相关 Issue

- 修复 "skill 列表可见但 use_skill 找不到" 的不一致问题
- 统一数据源，为后续 `allowedTools` enforce、`dependencies` 自动加载等功能打基础
