<!-- LLM Wiki Entry for Debate UI Enhancement -->

# 辩论功能国际化和语言选择

**日期**：2026-01-23
**状态**：✅ 已完成
**涉及文件**：9 个核心文件修改 + 2 个新增文件

## 概述

对 Easy Code 的辩论功能进行了全面的国际化（i18n）改进，包括：

1. **多语言界面支持** - 自动检测系统语言（中文/英文），切换所有向导文本
2. **语言选择流程** - 用户首次进行辩论时可选择辩论语言，后续自动使用已选语言
3. **智能 preferredLanguage 管理** - 如果已设置，跳过选择步骤直接使用
4. **双语提示词** - 提供中英文两套完整的开场白和推进提示词
5. **自定义语言支持** - 用户可输入任意语言名称（如 "日语"、"法语"）

## 新增文件

### 1. `packages/cli/src/ui/utils/debateI18n.ts`
- **功能**：集中式 i18n 配置和文本管理
- **内容**：
  - `DebateI18nTexts` 接口定义所有向导文本
  - `CHINESE_TEXTS` - 完整中文本地化
  - `ENGLISH_TEXTS` - 完整英文本地化
  - `getDebateI18nTexts(language)` - 根据语言返回相应文本集合
  - `isPredefinedLanguage()` - 判断是否为预定义语言

### 2. `packages/cli/src/ui/utils/debateLanguageUtils.ts`
- **功能**：语言检测、规范化和格式化
- **主要函数**：
  - `detectUILanguage()` - 从 `preferredLanguage` 或环境变量检测 UI 语言
  - `normalizeDebateLanguage()` - 规范化语言代码（zh/en/custom）
  - `formatDebateLanguage()` - 格式化显示（中文 → "中文"，en → "English"）

## 修改的核心文件

### 3. `packages/cli/src/ui/utils/debateState.ts`
```typescript
// 新增 language 字段
export interface ActiveDebate {
  // ... 其他字段
  language: string;  // 'zh' | 'en' | custom
}

// 修改 startDebate 签名
export function startDebate(args: {
  topic: string;
  models: string[];
  rounds: number;
  language: string;  // 新增
}): ActiveDebate
```

### 4. `packages/cli/src/ui/utils/debatePhrases.ts`
**重大改进**：支持多语言提示词

```typescript
// 原有函数签名
export function pickOpening(topic: string, language: string = 'en'): string
export function pickFollowup(language: string = 'en'): string

// 提示词池按语言组织
const CHINESE_OPENING_PHRASES: string[]    // 5 个中文开场白
const ENGLISH_OPENING_PHRASES: string[]    // 5 个英文开场白
const CHINESE_FOLLOWUP_PHRASES: string[]   // 10 个中文推进提示
const ENGLISH_FOLLOWUP_PHRASES: string[]   // 10 个英文推进提示

// 自动选择合适的提示词池
function getPhrasesPool(language: string): DebatePhrasesPool
```

**中文提示词特点**：
- 强调"先调用工具读代码"
- 使用自然的中文对话风格
- 避免模型名称重复（已由系统消息注入）

**英文提示词特点**：
- "Please call tools to read the code"
- 正式但自然的英文学术风格
- 确保代码优先阅读的原则一致

### 5. `packages/cli/src/ui/components/DebateWizard.tsx`
**完全重写**，新增语言选择步骤

**流程改进**：
```
旧流程：PICK_PRESET → MODELS → ROUNDS → TOPIC → CONFIRM
新流程：PICK_PRESET → PICK_LANGUAGE → MODELS → ROUNDS → TOPIC → CONFIRM
        (可选)      (按需)
```

**关键变化**：
```typescript
enum Step {
  PICK_PRESET = 'pickPreset',
  PICK_LANGUAGE = 'pickLanguage',  // 新增
  MODELS = 'models',
  ROUNDS = 'rounds',
  TOPIC = 'topic',
  CONFIRM = 'confirm',
}

export interface DebateWizardResult {
  topic: string;
  models: string[];
  rounds: number;
  language: DebateLanguage;  // 新增
}

export interface DebateWizardProps {
  // ...
  preferredLanguage?: string;        // 用户已设置的语言
  onLanguageSelected?: (language: DebateLanguage) => void;  // 回调保存设置
}
```

**语言选择逻辑**：
```typescript
// 自动检测 UI 语言（中文/英文）用于向导文本显示
const uiLang = detectUILanguage(preferredLanguage);
const uiTexts = getDebateI18nTexts(uiLang);

// 决定初始步骤
const initialStep = (() => {
  if (presets.length > 0) return Step.PICK_PRESET;
  if (!preferredLanguage) return Step.PICK_LANGUAGE;  // 需要选择
  return Step.MODELS;
})();
```

**PICK_LANGUAGE 步骤**：
- 选项：🇨🇳 中文、🇬🇧 English、✏️ 自定义语言
- 自定义选项打开文本输入框
- 选择后立即调用 `onLanguageSelected` 保存到 settings

### 6. `packages/cli/src/ui/hooks/useDebateWizard.ts`
**改进**：
- 添加 `handleDebateLanguageSelected` 回调，持久化 `preferredLanguage` 到 settings
- 使用 `SettingScope.Workspace` 和 `settings.setValue()` 保存设置
- 传入 `language` 参数给 `startDebate()`
- 向用户展示辩论开始消息时包含语言信息
- 调用 `pickOpening(topic, language)` 和 `pickFollowup(language)`

```typescript
// 返回值新增
interface UseDebateWizardReturn {
  // ...
  debatePreferredLanguage: string | undefined;
  handleDebateLanguageSelected: (language: string) => void;
}
```

### 7. `packages/cli/src/ui/hooks/useGeminiStream.ts`
**改进**：
- 调用 `pickFollowup()` 时传入 `debate.language` 参数
- 确保自动推进时使用正确的语言

```typescript
// 自动推进块
advanceCursor();
const debate = getActiveDebate();
setTimeout(() => {
  if (getActiveDebate()?.status !== 'running') return;
  submitQuery(pickFollowup(debate?.language || 'en'));
}, 0);
```

### 8. `packages/cli/src/ui/App.tsx`
**集成新功能**：
```typescript
const {
  isDebateWizardOpen,
  debateWizardModels,
  debateWizardPresets,
  debatePreferredLanguage,    // 新增
  openDebateWizard,
  handleDebateWizardComplete,
  handleDebateWizardCancel,
  handleDebateLanguageSelected,  // 新增回调
  handleResumeDebate,
} = useDebateWizard({ /* ... */ });

// 传入 DebateWizard 组件
<DebateWizard
  availableModels={debateWizardModels}
  presets={debateWizardPresets}
  preferredLanguage={debatePreferredLanguage}        // 新增
  onComplete={handleDebateWizardComplete}
  onCancel={handleDebateWizardCancel}
  onLanguageSelected={handleDebateLanguageSelected}  // 新增
/>
```

### 9. `packages/cli/src/ui/utils/debateStorage.ts`
**微调**：
- 用 i18n 文本更新 preset 标签格式化
- 改进相对时间显示的国际化

## 使用流程

### 首次使用（未设置 preferredLanguage）

```
/debate
   ↓
[选择历史设定] (可选，有 preset 时显示)
   ↓
[选择辩论语言] ← 🇨🇳 中文 / 🇬🇧 English / ✏️ 自定义语言
   ↓
[选择参赛模型] (2-4个)
   ↓
[每人发言轮数] (1/2/3)
   ↓
[辩论话题] (输入)
   ↓
[确认开始]
   ↓
🎭 辩论开始，语言已保存到 preferredLanguage
```

### 后续使用（已设置 preferredLanguage）

```
/debate
   ↓
[选择历史设定] (可选)
   ↓
直接跳过语言选择，用已保存的 preferredLanguage
[选择参赛模型] (2-4个)
   ↓
...（同上）
```

## 技术细节

### 语言检测优先级
1. 用户提供的 `preferredLanguage` 设置
2. 系统环境变量 `LANG`、`LANGUAGE`
3. 默认值：英文

### 文本适配规则
- **向导 UI 文本**：根据 `detectUILanguage()` 自动选择
  - 中文系统 → 中文界面
  - 其他系统 → 英文界面
- **辩论提示词**：根据用户选择的 `debateLanguage` 选择
  - 支持 'zh'、'en' 或任意自定义字符串
  - 自定义语言按需处理（目前回退到英文）

### Settings 集成
```json
{
  "preferredLanguage": "zh"  // 或 "en"，或自定义如 "日语"
}
```
- 存储位置：`.easycode-user/settings.json`（用户级）或 `.easycode/settings.json`（工作区级）
- 使用 `settings.setValue(SettingScope.Workspace, 'preferredLanguage', lang)` 保存

## 完整 i18n 文本列表

**UI Texts**（向导步骤标题、按钮、错误提示）：
- 29 项中文文本
- 29 项英文文本
- 涵盖所有向导步骤和错误消息

**Debate Phrases**（开场白和推进提示）：
- 5 个中文开场白模板
- 10 个中文推进提示
- 5 个英文开场白模板
- 10 个英文推进提示

## 验证清单

- ✅ 编译通过（TypeScript 无错误）
- ✅ 中文界面完整本地化
- ✅ 英文界面完整本地化
- ✅ 语言选择流程工作正常
- ✅ preferredLanguage 持久化工作正常
- ✅ 辩论开场白和推进提示支持多语言
- ✅ 自定义语言支持
- ✅ UI 和 prompt 语言独立可配置

## 已知限制与未来改进

### 当前限制
1. 自定义语言目前按英文提示词处理（回退）
2. 仅支持向导中的两种预定义语言（中文和英文）

### 建议的未来改进
1. **高级配置**：允许为自定义语言指定对应的提示词集
2. **更多语言支持**：添加日文、法文、西班牙文等预定义支持
3. **Phrase 库管理**：用户可自定义辩论提示词集合
4. **语言偏好记忆**：在项目级别记住最后使用的语言

---

[[overview|查看整体架构]]
[[debatePhrases|查看原始 debatePhrases 文档]]
[[debate-module|查看辩论模块详解]]
