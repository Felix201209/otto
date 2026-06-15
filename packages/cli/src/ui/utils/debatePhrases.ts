/**
 * @license
 * Copyright 2026 Easy Code team
 * SPDX-License-Identifier: Apache-2.0
 *
 * Debate mediator phrases — multilingual support.
 *
 * The mediator is injected as a user-role message between rounds. Its job is
 * to mimic the human host nudging the next model to speak. Since the system
 * already injects `[Model switched from X to Y]` into history on each switch,
 * the mediator phrases deliberately do NOT name models — keeping them short,
 * natural, and close to how a real user would nudge.
 */

// ============================================================================
// CHINESE PHRASES
// ============================================================================

const CHINESE_OPENING_PHRASES: string[] = [
  '咱们聊个事：{topic}。请先报出你的模型名称（如：我是 GPT-4o），然后调用工具把相关代码读一遍，以你自己的阅读为准，言简意赅说结论，不要来回纠结。',
  '有个问题想让你看看：{topic}。请先报出你的模型名，然后开始读代码，不要凭印象推断，读完直接说你的判断，保持简练。',
  '{topic}。请先自报家门，说明你是哪个模型。然后用工具读一下相关代码，确认实现细节后给出结论，不准长篇大论。',
  '来帮我分析下：{topic}。请先说明你是哪个模型，然后必须调用工具读代码，以实际代码为依据说结论，不要绕圈子。',
  '{topic}，请先报出模型名称。然后把代码读一遍，以你自己的阅读结果为准，言简意赅地说出你的看法。',
];

const CHINESE_FOLLOWUP_PHRASES: string[] = [
  '换你了。请先报出你的模型名称。不要直接评价上面的说法——先自己调用工具把代码读一遍，以你的阅读为准，言简意赅说结论，不要来回纠结。',
  '现在换你了。请先说明你是哪个模型。请先用工具读代码，确认实现后直接评论对错，不要绕圈子。',
  '该你了。请先自报家门。先读代码，不要凭印象推断，读完直接说你同不同意上面的观点，保持简练。',
  '轮到你了。请先报出模型名。请先独立阅读相关代码，以你自己读到的为准，言简意赅地给出判断。',
  '换你说说。请先自报家门。先调用工具看看代码实际怎么写的，再简要评价刚才那段说得对不对。',
  '你来看看。请先报出模型名称。别只依赖上面的描述，自己读一遍代码，然后直接给出结论，不要纠结。',
  '接着说。请先自报家门。先用工具读代码，以实际代码为依据，言简意赅地说明你是否同意上面的分析。',
  '现在轮到你了。请先报出模型名。请先独立阅读代码，不要直接沿用上面的结论，读完后直奔重点。',
  '该你了。请先自报家门。调用工具把代码读一遍，以你自己的阅读结果为准，言简意赅地评价。',
  '你呢？请先报出模型名称。先自己读代码，不要被上面的说法带偏，以你读到的实现为准，直接给结论。',
];

const CHINESE_LAST_TURN_PHRASES: string[] = [
  '这是你最后一次发言机会。请先报出你的模型名称，并高度重视这次发言，先调用工具复核代码，然后说出你的最终结论。',
  '辩论进入最后一轮，这是你最后定调的机会。请先报出模型名，务必读透代码，给出你最严谨、最终的判断。',
  '最后轮到你了。请先自报家门。珍惜这最后一次表达机会，以实际代码为准，为这场辩论给出最终结论。',
];

// ============================================================================
// ENGLISH PHRASES
// ============================================================================

const ENGLISH_OPENING_PHRASES: string[] = [
  'Let\'s discuss: {topic}. Please start by stating your model name (e.g., "I am GPT-4o"), then call tools to read the relevant code thoroughly. Base your conclusion on your own reading, and keep it concise.',
  'I have a question for you: {topic}. Please state your model name first, then read the code—don\'t speculate. After reading, state your judgment directly.',
  '{topic}. Please identify yourself with your model name. Then use tools to read the relevant code and confirm the implementation details before drawing a conclusion.',
  'Help me analyze this: {topic}. Please state which model you are, then you must call tools to read the code first. Base your conclusion on the actual code.',
  '{topic}. Please state your model name first. Read the code thoroughly, base your response on your own reading, and state your view concisely.',
];

const ENGLISH_FOLLOWUP_PHRASES: string[] = [
  'Your turn. Please start by stating your model name. Don\'t just evaluate the previous statement—call tools and read the code independently first.',
  'Now it\'s your turn. Please identify yourself first. Read the code with tools first, confirm the implementation, then comment directly on what\'s right or wrong.',
  'Your turn. Please state your model name. Read the code first—don\'t speculate. After reading, state directly whether you agree with the previous point.',
  'Your turn now. Please identify yourself. Read the relevant code independently. Base your judgment on what you actually read.',
  'Go ahead and share. Please state your model name first. Call tools to see how the code is actually written, then briefly comment on the previous statement.',
  'Take a look. Please state your model name first. Don\'t just rely on the description above—read the code yourself, then state your conclusion directly.',
  'Continue. Please identify yourself. Use tools to read the code, and base your analysis on the actual code to state concisely whether you agree.',
  'Your turn now. Please state your model name first. Read the code independently. Don\'t just echo the previous conclusion. Get to the point.',
  'Your turn. Please identify yourself. Call tools and read the code. Base your assessment on your own reading, and comment concisely.',
  'What do you think? Please state your model name first. Read the code yourself first. Don\'t be swayed by the previous statement.',
];

const ENGLISH_LAST_TURN_PHRASES: string[] = [
  'This is your last chance to speak. Please state your model name first and take this seriously. Call tools to double-check the code, and state your final conclusion.',
  'The debate is in its final round. Please identify yourself first. This is your last opportunity to set the tone. Read the code thoroughly and give your final judgment.',
  'Last turn for you. Please state your model name. Make it count. Base your response on the actual code and provide a definitive final conclusion.',
];

// ============================================================================
// PHRASE POOLS BY LANGUAGE
// ============================================================================

interface DebatePhrasesPool {
  opening: readonly string[];
  followup: readonly string[];
  lastTurn: readonly string[];
}

/**
 * 判断是否是中文语言标识。
 * 涵盖 'zh'、'zh-CN'、'中文'、'Chinese' 等常见形式。
 */
function isChineseLanguage(lang: string): boolean {
  const lower = lang.toLowerCase().trim();
  return (
    lower === 'zh' ||
    lower.startsWith('zh-') ||
    lower.startsWith('zh_') ||
    lang === '中文' ||
    lower === 'chinese' ||
    lower === 'cn'
  );
}

/**
 * 判断是否是英文语言标识。
 */
function isEnglishLanguage(lang: string): boolean {
  const lower = lang.toLowerCase().trim();
  return (
    lower === 'en' ||
    lower.startsWith('en-') ||
    lower.startsWith('en_') ||
    lower === 'english'
  );
}

function getPhrasesPool(language: string): DebatePhrasesPool {
  if (isChineseLanguage(language)) {
    return {
      opening: CHINESE_OPENING_PHRASES,
      followup: CHINESE_FOLLOWUP_PHRASES,
      lastTurn: CHINESE_LAST_TURN_PHRASES,
    };
  }
  // 英文或其他语言都用英文模板作为基座，再靠 language 指令兜底
  return {
    opening: ENGLISH_OPENING_PHRASES,
    followup: ENGLISH_FOLLOWUP_PHRASES,
    lastTurn: ENGLISH_LAST_TURN_PHRASES,
  };
}

/**
 * 构造"请用 X 语言发言"的指令，作为开场白 / 推进提示的一部分追加到末尾。
 *
 * 策略：
 * - 'zh' / 中文 / zh-CN → 不追加（模板本身已是中文）
 * - 'en' / en-US → 不追加（模板本身已是英文）
 * - 其他自定义值（如 "日语"、"Japanese"、"Français"）→ 追加明确的语言指令
 *
 * 指令用双语（中文 + 英文）同时说明，保证不同模型都能理解，避免只写一种语言
 * 时小模型绕不过去。
 */
function buildLanguageDirective(language: string): string {
  if (!language) return '';
  if (isChineseLanguage(language)) return '';
  if (isEnglishLanguage(language)) return '';

  const trimmed = language.trim();
  // 双语兜底：英文 + 中文，确保任何模型都能理解
  return (
    ` (Please respond in ${trimmed}. ` +
    `请严格使用 ${trimmed} 进行这次辩论的发言。)`
  );
}

function pickRandom<T>(pool: readonly T[]): T {
  return pool[Math.floor(Math.random() * pool.length)]!;
}

/**
 * Pick an opening phrase for the first speaker of a debate.
 * - 中文/英文：使用对应语种模板，不追加额外指令
 * - 自定义语言（如"日语"、"Français"）：用英文模板 + 明确的"请用 X 语言发言"指令
 */
export function pickOpening(topic: string, language: string = 'en'): string {
  const pool = getPhrasesPool(language);
  const template = pickRandom(pool.opening);
  const base = template.replace('{topic}', topic);
  return base + buildLanguageDirective(language);
}

/**
 * Pick a follow-up phrase for any speaker after the first.
 * 规则同 pickOpening：自定义语言时会追加语言指令，确保辩论不会跑偏语种。
 *
 * @param language 辩论语种
 * @param isLastTurn 是否是最后一轮（最后一轮会使用更严肃的催促语）
 */
export function pickFollowup(
  language: string = 'en',
  isLastTurn: boolean = false,
): string {
  const pool = getPhrasesPool(language);
  const base = pickRandom(isLastTurn ? pool.lastTurn : pool.followup);
  return base + buildLanguageDirective(language);
}

// ============================================================================
// SUMMARY MODEL
// ============================================================================

/**
 * 辩论总结使用的模型。
 * 选择 gemini-3-flash-preview 的原因：当前最先进的大上下文模型，
 * 拥有极高的上下文窗口，确保能容纳并理解完整的辩论历史。
 */
export const DEBATE_SUMMARY_MODEL = 'gemini-3-flash-preview';

/**
 * 总结模型切换失败时的回退模型。
 */
export const DEBATE_SUMMARY_FALLBACK_MODEL = 'auto';

/**
 * Build the summary prompt sent after a debate finishes.
 *
 * The prompt asks the model to produce a structured report covering:
 * - Each model's core position
 * - Key points of disagreement
 * - An overall conclusion / synthesis
 *
 * Language rules mirror pickOpening: zh/en use native templates; custom
 * languages append an explicit language directive.
 */
export function buildSummaryPrompt(
  topic: string,
  models: string[],
  language: string = 'en',
): string {
  const modelList = models.join('、');
  const directive = buildLanguageDirective(language);

  if (isChineseLanguage(language)) {
    return (
      `辩论已全部结束。话题是：${topic}。\n` +
      `参与模型：${modelList}。\n\n` +
      `请你作为中立的主持人，根据上面的完整辩论记录，生成一份简洁的总结报告，包含以下部分：\n` +
      `1. 各模型的核心观点（逐一列出）\n` +
      `2. 主要争议点\n` +
      `3. 综合结论\n\n` +
      `要求：直接输出报告内容，不要加多余的开场白，保持简练。`
    );
  }

  return (
    `The debate has concluded. Topic: ${topic}.\n` +
    `Participating models: ${models.join(', ')}.\n\n` +
    `As a neutral moderator, please generate a concise summary report based on the full debate above, covering:\n` +
    `1. Each model's core position (listed individually)\n` +
    `2. Main points of disagreement\n` +
    `3. Overall conclusion / synthesis\n\n` +
    `Output the report directly without preamble. Keep it concise.` +
    directive
  );
}
