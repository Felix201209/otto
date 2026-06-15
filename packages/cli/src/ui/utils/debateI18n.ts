/**
 * @license
 * Copyright 2026 Easy Code team
 * SPDX-License-Identifier: Apache-2.0
 *
 * Debate i18n configuration — Chinese and English prompts with language support.
 * Used by DebateWizard and debate phrases to localize UI and mediator messages.
 */

export type DebateLanguage = 'zh' | 'en' | string; // string for custom user input

export interface DebateI18nTexts {
  // Wizard UI texts
  wizardTitle: string;
  stepPickPreset: string;
  stepPickLang: string;
  stepModels: string;
  stepRounds: string;
  stepTopic: string;
  stepConfirm: string;

  // Descriptions
  descPickPreset: string;
  descPickLang: string;
  descModels: string;
  descRounds: string;
  descTopic: string;
  descConfirm: string;
  /**
   * CONFIRM 步骤的费用/token 警告。独立出来是为了在 UI 里用醒目的颜色
   * （黄色加粗）单独渲染，避免和普通 descConfirm 的暗色说明混为一谈。
   */
  descConfirmWarning: string;

  // Options
  roundOption1: string;
  roundOption2: string;

  // Buttons
  btnNewDebate: string;
  btnStart: string;
  btnBack: string;
  btnCancel: string;

  // Labels
  labelTopic: string;
  labelModels: string;
  labelRounds: string;
  labelTotalTurns: string;
  labelLanguage: string;

  // Messages
  msgMinModels: string;
  msgMaxModels: string;
  msgInsufficientModels: string;
  msgEmptyTopic: string;
  msgEmptyCustomLang: string;
  msgConfigureModels: string;
  msgPressEnter: string;
  msgPressEsc: string;

  // Language options
  optChinese: string;
  optEnglish: string;
  optCustom: string;

  // For custom language input
  customLangPrompt: string;
  customLangDesc: string;

  // Preset loading
  presetTopic: string;
  presetModels: string;
  presetRounds: string;
  presetAgo: string;
  agoDaysAgo: string;
  agoHoursAgo: string;
  agoMinsAgo: string;
  agoJustNow: string;

  // DebateIndicator
  indicatorRunning: string;
  indicatorPaused: string;
  indicatorSpeaking: string;
  indicatorProgress: string;

  // Post-debate summary
  summaryGenerating: string;
}

const CHINESE_TEXTS: DebateI18nTexts = {
  wizardTitle: '🎭 辩论模式配置',
  stepPickPreset: '选择历史设定',
  stepPickLang: '选择辩论语言',
  stepModels: '选择参赛模型',
  stepRounds: '每人发言轮数',
  stepTopic: '辩论话题',
  stepConfirm: '确认开始',

  descPickPreset: '你之前保存过辩论设定，可以直接复用，或新建一次。',
  descPickLang: '选择辩论所用的语言。这会影响开场白、推进提示词和模型回复的预期语言。',
  descModels: `至少 2 个，最多 3 个。按空格勾选，回车确认。`,
  descRounds: '每个模型在整场辩论中最多发言的次数。',
  descTopic: '一句话描述你想辩论什么。例如：这段压缩修复的代码是否健壮。',
  descConfirm: '再看一眼就开始。辩论会按显示顺序轮流发言。',
  descConfirmWarning: '⚠️ 注意：辩论涉及多次模型切换，会破坏 Prompt 缓存并消耗大量 Token，价格可能较高。当前上限为 3 模型 × 2 轮（最多 6 次发言），建议按不同档次（便宜 / 中档 / 高档）选模型，避免全选高档。',

  roundOption1: '1 轮（每人各自陈述）',
  roundOption2: '2 轮（推荐：陈述 + 反驳）',

  btnNewDebate: '➕ 新建辩论',
  btnStart: '✓ 开始辩论',
  btnBack: '↩ 返回修改',
  btnCancel: '✗ 取消',

  labelTopic: '话题：',
  labelModels: '模型：',
  labelRounds: '每人轮数：',
  labelTotalTurns: '总发言次数：',
  labelLanguage: '辩论语言：',

  msgMinModels: '至少选 2 个模型',
  msgMaxModels: '最多选 3 个模型',
  msgInsufficientModels: '✗ 当前可用模型不足 2 个，无法进行辩论。',
  msgEmptyTopic: '话题不能为空',
  msgEmptyCustomLang: '请输入语言名称，或按 Esc 返回',
  msgConfigureModels: '请先通过 /model 或 /add-model 配置更多模型。',
  msgPressEnter: '回车确认',
  msgPressEsc: '按 Esc 返回',

  optChinese: '🇨🇳 中文',
  optEnglish: '🇬🇧 English',
  optCustom: '✏️ 自定义语言',

  customLangPrompt: '输入自定义语言（如 "日语" 或 "法语"）',
  customLangDesc: '模型会用这个语言进行辩论。',

  presetTopic: '话题',
  presetModels: '模型',
  presetRounds: '轮',
  presetAgo: '时间',
  agoDaysAgo: '天前',
  agoHoursAgo: '小时前',
  agoMinsAgo: '分钟前',
  agoJustNow: '刚刚',

  indicatorRunning: '辩论进行中',
  indicatorPaused: '辩论已暂停',
  indicatorSpeaking: '当前发言',
  indicatorProgress: '进度',

  summaryGenerating: '🎭 辩论结束，正在生成总结报告……',
};

const ENGLISH_TEXTS: DebateI18nTexts = {
  wizardTitle: '🎭 Debate Mode Configuration',
  stepPickPreset: 'Select Saved Preset',
  stepPickLang: 'Select Debate Language',
  stepModels: 'Select Competing Models',
  stepRounds: 'Speaking Rounds per Model',
  stepTopic: 'Debate Topic',
  stepConfirm: 'Confirm & Start',

  descPickPreset: 'You have saved debate presets. Pick one to reuse, or start a new debate.',
  descPickLang: 'Choose the language for the debate. This affects the opening phrase, follow-up prompts, and expected model responses.',
  descModels: `Select 2–3 models. Press space to toggle, Enter to confirm.`,
  descRounds: 'Maximum number of times each model speaks during the entire debate.',
  descTopic: 'Describe in one sentence what you want to debate. Example: Is this compression fix code robust?',
  descConfirm: 'Review the settings before starting. Models will speak in the order shown.',
  descConfirmWarning: '⚠️ Note: Multi-model debates frequently switch models, breaking prompt caches and increasing Token usage. Costs may be high. The current upper bound is 3 models × 2 rounds (up to 6 turns). We recommend mixing different price tiers (cheap / mid / high) rather than picking all high-tier models.',

  roundOption1: '1 Round (each model speaks once)',
  roundOption2: '2 Rounds (recommended: statement + rebuttal)',

  btnNewDebate: '➕ New Debate',
  btnStart: '✓ Start Debate',
  btnBack: '↩ Go Back',
  btnCancel: '✗ Cancel',

  labelTopic: 'Topic:',
  labelModels: 'Models:',
  labelRounds: 'Rounds per Model:',
  labelTotalTurns: 'Total Turns:',
  labelLanguage: 'Debate Language:',

  msgMinModels: 'Select at least 2 models',
  msgMaxModels: 'Select at most 3 models',
  msgInsufficientModels: '✗ Insufficient available models (need 2+) to start a debate.',
  msgEmptyTopic: 'Topic cannot be empty',
  msgEmptyCustomLang: 'Please enter a language name, or press Esc to go back',
  msgConfigureModels: 'Please configure more models via /model or /add-model first.',
  msgPressEnter: 'Press Enter to confirm',
  msgPressEsc: 'Press Esc to go back',

  optChinese: '🇨🇳 中文',
  optEnglish: '🇬🇧 English',
  optCustom: '✏️ Custom Language',

  customLangPrompt: 'Enter custom language (e.g. "Japanese" or "French")',
  customLangDesc: 'Models will conduct the debate in this language.',

  presetTopic: 'topic',
  presetModels: 'models',
  presetRounds: 'rounds',
  presetAgo: 'ago',
  agoDaysAgo: 'd ago',
  agoHoursAgo: 'h ago',
  agoMinsAgo: 'm ago',
  agoJustNow: 'now',

  indicatorRunning: 'Debate in Progress',
  indicatorPaused: 'Debate Paused',
  indicatorSpeaking: 'Speaking',
  indicatorProgress: 'Progress',

  summaryGenerating: '🎭 Debate concluded. Generating summary report…',
};

/**
 * Get localized texts for the given language.
 * If language is 'zh' or 'en', return the corresponding translation.
 * Otherwise, return English as fallback.
 */
export function getDebateI18nTexts(language: DebateLanguage): DebateI18nTexts {
  if (language === 'zh') {
    return CHINESE_TEXTS;
  }
  return ENGLISH_TEXTS; // Default to English for 'en' and unknown languages
}

/**
 * Check if language code is one of the predefined options ('zh' or 'en').
 */
export function isPredefinedLanguage(lang: string): lang is 'zh' | 'en' {
  return lang === 'zh' || lang === 'en';
}
