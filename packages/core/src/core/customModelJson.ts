/**
 * @license
 * Copyright 2026 Felix
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * 安全解析 JSON - 增强版
 * 专门针对流式工具调用场景优化，处理各种不完整或格式异常的 JSON
 *
 * 常见问题场景：
 * 1. 流式传输中 JSON 被截断：{"pattern": "TO  (缺少结尾)
 * 2. 模型返回空字符串或 undefined
 * 3. 模型返回非标准格式（如带有多余空格、换行）
 * 4. 嵌套 JSON 字符串（需要二次解析）
 */
export function parseJSONSafe(jsonStr: string): any {
  // 处理空值
  if (!jsonStr || jsonStr === 'null' || jsonStr === 'undefined') {
    return {};
  }

  // 如果已经是对象，直接返回
  if (typeof jsonStr === 'object') {
    return jsonStr;
  }

  // 清理字符串
  let cleanStr = jsonStr.trim();

  // 处理空对象字符串
  if (cleanStr === '{}' || cleanStr === '') {
    return {};
  }

  // 第一次尝试：直接解析
  try {
    return JSON.parse(cleanStr);
  } catch (firstError) {
    // 继续尝试修复
  }

  // 修复策略 1：处理不完整的 JSON 对象
  if (cleanStr.startsWith('{') && !cleanStr.endsWith('}')) {
    const repaired = repairIncompleteJSON(cleanStr);
    if (repaired) {
      try {
        return JSON.parse(repaired);
      } catch {
        // 继续尝试其他方法
      }
    }
  }

  // 修复策略 2：处理不完整的 JSON 数组
  if (cleanStr.startsWith('[') && !cleanStr.endsWith(']')) {
    // 尝试找到最后一个完整的元素
    const lastCompleteComma = cleanStr.lastIndexOf(',');
    if (lastCompleteComma > 0) {
      const repaired = cleanStr.substring(0, lastCompleteComma) + ']';
      try {
        return JSON.parse(repaired);
      } catch {
        // 继续尝试
      }
    }
    // 尝试直接补全
    try {
      return JSON.parse(cleanStr + ']');
    } catch {
      // 继续尝试
    }
  }

  // 修复策略 3：移除尾部可能的垃圾字符
  // 有时模型会在 JSON 后附加额外内容
  const jsonEndMatch = cleanStr.match(/^(\{[\s\S]*\}|\[[\s\S]*\])/);
  if (jsonEndMatch) {
    try {
      return JSON.parse(jsonEndMatch[1]);
    } catch {
      // 继续尝试
    }
  }

  // 修复策略 4：处理转义问题
  // 有时 JSON 字符串中的引号没有正确转义
  try {
    // 尝试修复常见的转义问题
    const fixedEscape = cleanStr
      .replace(/([^\\])\\([^"\\/bfnrtu])/g, '$1\\\\$2')  // 修复无效转义
      .replace(/\t/g, '\\t')  // 替换实际的 tab
      .replace(/\n/g, '\\n')  // 替换实际的换行
      .replace(/\r/g, '\\r'); // 替换实际的回车
    return JSON.parse(fixedEscape);
  } catch {
    // 继续尝试
  }

  // 所有修复尝试都失败，记录错误并返回带标记的对象
  console.error(`[CustomModel] Failed to parse tool arguments after all repair attempts`);
  console.error(`[CustomModel] Original string (first 500 chars): ${jsonStr.substring(0, 500)}`);

  // 返回一个标记了解析错误的对象
  // 使用 __parseError 前缀避免与正常工具参数冲突
  return {
    __parseError: true,
    __rawArgs: jsonStr,
    __errorMessage: `Failed to parse tool arguments as JSON. Raw value: ${jsonStr.substring(0, 200)}${jsonStr.length > 200 ? '...' : ''}`
  };
}

/**
 * 尝试修复不完整的 JSON 对象
 * 使用括号匹配和引号状态追踪来找到可以安全截断的位置
 */
function repairIncompleteJSON(jsonStr: string): string | null {
  let braceCount = 0;
  let bracketCount = 0;
  let inString = false;
  let escapeNext = false;
  let lastSafePosition = -1;
  let lastKeyValueEnd = -1;

  for (let i = 0; i < jsonStr.length; i++) {
    const char = jsonStr[i];

    if (escapeNext) {
      escapeNext = false;
      continue;
    }

    if (char === '\\') {
      escapeNext = true;
      continue;
    }

    if (char === '"' && !escapeNext) {
      inString = !inString;
      continue;
    }

    if (inString) continue;

    switch (char) {
      case '{':
        braceCount++;
        break;
      case '}':
        braceCount--;
        if (braceCount === 0) {
          lastSafePosition = i;
        }
        break;
      case '[':
        bracketCount++;
        break;
      case ']':
        bracketCount--;
        break;
      case ',':
        // 逗号后面可能是安全的截断点（如果不在嵌套结构中）
        if (braceCount === 1 && bracketCount === 0) {
          lastKeyValueEnd = i;
        }
        break;
    }
  }

  // 如果找到了完整的 JSON，直接返回
  if (lastSafePosition > 0 && braceCount === 0) {
    return jsonStr.substring(0, lastSafePosition + 1);
  }

  // 尝试在最后一个逗号处截断并补全
  if (lastKeyValueEnd > 0) {
    const truncated = jsonStr.substring(0, lastKeyValueEnd);
    // 补全缺失的括号
    let result = truncated;
    for (let i = 0; i < braceCount; i++) {
      result += '}';
    }
    for (let i = 0; i < bracketCount; i++) {
      result += ']';
    }
    return result;
  }

  // 尝试找到最后一个完整的键值对（以 " 结尾的值）
  // 例如: {"pattern": "TODO", "path": "/src  -> 截断到 "TODO"
  const patterns = [
    /^(.*"[^"]*"\s*:\s*"[^"]*")\s*,?\s*"[^"]*"\s*:\s*"?[^"}]*$/,  // 截断到上一个完整的字符串值
    /^(.*"[^"]*"\s*:\s*\d+)\s*,?\s*"[^"]*"\s*:\s*"?[^"}]*$/,       // 截断到上一个完整的数字值
    /^(.*"[^"]*"\s*:\s*(?:true|false|null))\s*,?\s*"[^"]*"\s*:\s*"?[^"}]*$/,  // 截断到布尔/null值
  ];

  for (const pattern of patterns) {
    const match = jsonStr.match(pattern);
    if (match && match[1]) {
      return match[1] + '}';
    }
  }

  // 最后的尝试：直接补全括号
  if (braceCount > 0) {
    let result = jsonStr;
    // 如果在字符串中间被截断，先补全引号
    if (inString) {
      result += '"';
    }
    // 补全括号
    for (let i = 0; i < braceCount; i++) {
      result += '}';
    }
    return result;
  }

  return null;
}
