/**
 * @license
 * Copyright 2026 Easy Code team
 * https://github.com/OrionStarAI/DeepVCode
 * SPDX-License-Identifier: Apache-2.0
 */


/**
 * Emoji 检测和处理工具函数
 */

/**
 * 检测字符是否为emoji
 * 包括常见的emoji Unicode范围
 */
export function isEmoji(char: string): boolean {
  // 如果字符长度大于1，可能是组合emoji，也排除
  if (char.length > 1) {
    return true;
  }

  const codePoint = char.codePointAt(0);
  if (!codePoint) return false;

  // 常见emoji Unicode范围
  return (
    // 基本emoji和符号
    (codePoint >= 0x1F600 && codePoint <= 0x1F64F) || // 表情符号
    (codePoint >= 0x1F300 && codePoint <= 0x1F5FF) || // 杂项符号和象形文字
    (codePoint >= 0x1F680 && codePoint <= 0x1F6FF) || // 交通和地图符号
    (codePoint >= 0x1F1E0 && codePoint <= 0x1F1FF) || // 区域指示符号（国旗）
    (codePoint >= 0x2600 && codePoint <= 0x26FF) ||   // 杂项符号
    (codePoint >= 0x2700 && codePoint <= 0x27BF) ||   // 装饰符号
    (codePoint >= 0xFE00 && codePoint <= 0xFE0F) ||   // 变体选择器
    (codePoint >= 0x1F900 && codePoint <= 0x1F9FF) || // 补充符号和象形文字
    (codePoint >= 0x1F000 && codePoint <= 0x1F02F) || // 麻将牌
    (codePoint >= 0x1F0A0 && codePoint <= 0x1F0FF) || // 扑克牌
    // 常见的单字符符号
    codePoint === 0x203C ||   // ‼️
    codePoint === 0x2049 ||   // ⁉️
    codePoint === 0x2122 ||   // ™️
    codePoint === 0x2139 ||   // ℹ️
    codePoint === 0x2194 ||   // ↔️
    codePoint === 0x2195 ||   // ↕️
    codePoint === 0x2196 ||   // ↖️
    codePoint === 0x2197 ||   // ↗️
    codePoint === 0x2198 ||   // ↘️
    codePoint === 0x2199 ||   // ↙️
    codePoint === 0x21A9 ||   // ↩️
    codePoint === 0x21AA ||   // ↪️
    codePoint === 0x231A ||   // ⌚
    codePoint === 0x231B ||   // ⌛
    codePoint === 0x2328 ||   // ⌨️
    codePoint === 0x23CF ||   // ⏏️
    codePoint === 0x23E9 ||   // ⏩
    codePoint === 0x23EA ||   // ⏪
    codePoint === 0x23EB ||   // ⏫
    codePoint === 0x23EC ||   // ⏬
    codePoint === 0x23ED ||   // ⏭️
    codePoint === 0x23EE ||   // ⏮️
    codePoint === 0x23EF ||   // ⏯️
    codePoint === 0x23F0 ||   // ⏰
    codePoint === 0x23F1 ||   // ⏱️
    codePoint === 0x23F2 ||   // ⏲️
    codePoint === 0x23F3 ||   // ⏳
    codePoint === 0x25FD ||   // ◽
    codePoint === 0x25FE ||   // ◾
    codePoint === 0x2B50 ||   // ⭐
    codePoint === 0x2B55     // ⭕
  );
}

/**
 * 检测字符是否为常见的符号（如💡🚀等）
 */
export function isCommonSymbol(char: string): boolean {
  const commonSymbols = ['💡', '🚀', '⚡', '🔥', '⭐', '✨', '🎯', '🎉', '🎊', '🌟', '💯', '🔧', '⚙️', '🛠️', '🔨', '⚒️', '🧰', '✌️', '🆅', 'Ⓥ'];
  return commonSymbols.includes(char);
}

/**
 * 过滤文本，标记哪些字符应该排除在高亮之外
 */
export interface FilteredChar {
  char: string;
  index: number;
  isEmoji: boolean;
  shouldHighlight: boolean; // 是否应该参与高亮
}

/**
 * 分析文本，标记每个字符是否应该参与高亮
 */
export function analyzeTextForHighlight(text: string): FilteredChar[] {
  return Array.from(text).map((char, index) => {
    const isEmojiChar = isEmoji(char) || isCommonSymbol(char);

    return {
      char,
      index,
      isEmoji: isEmojiChar,
      shouldHighlight: !isEmojiChar // emoji和常见符号不参与高亮
    };
  });
}

/**
 * 计算实际应该高亮的字符数量（排除emoji）
 */
export function calculateHighlightableLength(text: string): number {
  const analyzed = analyzeTextForHighlight(text);
  return analyzed.filter(item => item.shouldHighlight).length;
}