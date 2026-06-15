#!/usr/bin/env markdown

# 辩论功能国际化 - 快速参考

## 核心改进

```
✨ 多语言 UI（中文/英文 自动适配）
✨ 语言选择步骤（首次配置时，后续跳过）
✨ 双语提示词（开场白 + 推进提示）
✨ 自定义语言支持（如 "日语"、"法语"）
✨ preferredLanguage 持久化（.easycode-user/settings.json）
```

## 流程对比

### 旧流程
```
/debate
  ↓ [PICK_PRESET]
  ↓ [MODELS]
  ↓ [ROUNDS]
  ↓ [TOPIC]
  ↓ [CONFIRM]
  ↓ 辩论开始 (默认英文)
```

### 新流程
```
/debate
  ↓ [PICK_PRESET] ← 可选
  ↓ [PICK_LANGUAGE] ← 可选（有 preferredLanguage 时跳过）
  ↓ [MODELS]
  ↓ [ROUNDS]
  ↓ [TOPIC]
  ↓ [CONFIRM]
  ↓ 辩论开始 (用户选择的语言)
```

## 使用示例

### 首次使用（新用户）
```
$ easycode
> /debate
  🎭 辩论模式配置

  选择辩论语言:
  ○ 🇨🇳 中文
  ● 🇬🇧 English
  ○ ✏️ 自定义语言

  [选择 "中文" 后 ↓]

  选择参赛模型: [继续向导...]
```

### 后续使用（已设置 preferredLanguage）
```
$ easycode
> /debate
  🎭 辩论模式配置

  选择历史设定:   ← 如果有保存的 preset
  ○ 【话题】模型1 + 模型2, 2轮 · 刚刚
  ● ➕ 新建辩论

  [选择 "新建辩论" 后，直接进入模型选择]

  选择参赛模型: [继续向导...]
```

## 文件映射

| 文件 | 职责 |
|------|------|
| `debateI18n.ts` | i18n 文本配置（中英双语） |
| `debateLanguageUtils.ts` | 语言检测和规范化 |
| `debateState.ts` | 运行时状态（+language 字段） |
| `debatePhrases.ts` | 双语提示词库 |
| `DebateWizard.tsx` | UI 向导（+PICK_LANGUAGE 步骤） |
| `useDebateWizard.ts` | 向导控制逻辑（+language 持久化） |
| `useGeminiStream.ts` | 自动推进（+language 参数） |
| `App.tsx` | 组件集成 |

## 关键决策

### 1. 何时显示语言选择步骤
```typescript
const needsLanguageSelection = !preferredLanguage;
// 如果用户已设置 preferredLanguage，直接跳过 PICK_LANGUAGE 步骤
```

### 2. UI 语言 vs 辩论语言
```typescript
// UI 语言：向导界面、按钮、标题的显示语言
const uiLang = detectUILanguage(preferredLanguage);  // 'zh' 或 'en'
const uiTexts = getDebateI18nTexts(uiLang);

// 辩论语言：开场白和推进提示词使用的语言
const debateLanguage = result.language;  // 用户选择的语言
pickOpening(topic, debateLanguage);
pickFollowup(debateLanguage);
```

### 3. 语言持久化位置
```json
// 存储在 .easycode-user/settings.json（用户级）或 .easycode/settings.json（工作区级）
{
  "preferredLanguage": "zh"
}
```

## 测试检查表

- [ ] 中文系统上，向导界面显示中文
- [ ] 英文系统上，向导界面显示英文
- [ ] 首次进行辩论时出现语言选择步骤
- [ ] 设置语言后，后续辩论直接跳过语言步骤
- [ ] 选择"中文"后，开场白和推进提示使用中文
- [ ] 选择"English"后，开场白和推进提示使用英文
- [ ] 选择自定义语言（如"日语"）后能正常开始辩论
- [ ] 语言设置正确保存到 preferredLanguage
- [ ] 辩论开始消息显示选定的语言
- [ ] 确认屏幕显示"辩论语言"字段

## 常见问题

### Q1: 如何修改已保存的语言？
**A:** 编辑 `.easycode-user/settings.json`：
```json
{
  "preferredLanguage": "en"  // 改为 "zh" 或任意自定义值
}
```
或在下次 `/debate` 时，删除该设置文件即会重新提示选择。

### Q2: 支持哪些语言？
**A:**
- 预定义：中文 (`zh`)、英文 (`en`)
- 自定义：任意字符串（如 "日语"、"法语"、"Spanish"）
- 自定义语言目前使用英文提示词回退

### Q3: UI 语言如何选择？
**A:** 优先级：
1. 用户的 `preferredLanguage` 设置
2. 系统环境变量 (`LANG`、`LANGUAGE`)
3. 默认英文

### Q4: 我想在一场辩论中改变语言？
**A:** 目前不支持中途改变。需要结束当前辩论 (`/debate end`)，然后删除 `preferredLanguage` 重新选择。

## 源代码位置

```
packages/cli/src/ui/
├── components/
│   └── DebateWizard.tsx          ← UI 向导主体
├── hooks/
│   ├── useDebateWizard.ts        ← 向导逻辑 + 语言持久化
│   └── useGeminiStream.ts        ← 自动推进 + 语言参数
├── utils/
│   ├── debateI18n.ts             ← i18n 配置
│   ├── debateLanguageUtils.ts    ← 语言工具
│   ├── debateState.ts            ← 状态 (+language)
│   ├── debatePhrases.ts          ← 双语提示词
│   └── debateStorage.ts          ← preset 存储
├── commands/
│   └── debateCommand.ts          ← /debate 命令
└── App.tsx                        ← 组件集成
```

## 编译 & 验证

```bash
# 编译检查
npm run build

# TypeScript 检查
cd packages/cli && npx tsc --noEmit

# 运行测试（如有）
npm test
```

✅ 所有改动已通过编译，无 TypeScript 错误

---

**最后更新**: 2026-01-23
**状态**: ✅ 已完成并通过编译
**涉及文件**: 9 修改 + 2 新增
