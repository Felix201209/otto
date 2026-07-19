/**
 * Native Utils - 便捷工具函数
 *
 * 提供简洁的 API 封装，让 otto-core 可以无痛使用 Rust 核心
 */

import { getNativeInstance, initNativeUtils } from './index.js';

export { initNativeUtils };

/**
 * 本地 token 计数（自动选择精确/快速模式）
 */
export async function countTokensLocal(text: string, model: string = 'gpt-4'): Promise<number> {
  try {
    const native = getNativeInstance();
    return await native.countTokens(text, model);
  } catch (e) {
    // fallback: 简单估算
    return estimateTokensFallback(text);
  }
}

/**
 * 精确 token 计数（tiktoken）
 */
export async function countTokensPrecise(text: string, model: string = 'gpt-4'): Promise<number> {
  try {
    const native = getNativeInstance();
    return await native.countTokensPrecise(text, model);
  } catch (e) {
    return estimateTokensFallback(text);
  }
}

/**
 * 快速 token 估算
 */
export async function countTokensFast(text: string, model: string = 'gpt-4'): Promise<number> {
  try {
    const native = getNativeInstance();
    return await native.countTokensFast(text, model);
  } catch (e) {
    return estimateTokensFallback(text);
  }
}

/**
 * 存储加密密钥
 */
export async function storeSecret(key: string, value: string): Promise<void> {
  const native = getNativeInstance();
  await native.secretStore(key, value);
}

/**
 * 加载加密密钥
 */
export async function loadSecret(key: string): Promise<string | null> {
  try {
    const native = getNativeInstance();
    return await native.secretLoad(key);
  } catch (e) {
    return null;
  }
}

/**
 * 获取 agent pool 统计
 */
export async function getAgentPoolStats(): Promise<any> {
  try {
    const native = getNativeInstance();
    return await native.poolStats();
  } catch (e) {
    return { active_agents: 0, total_memory_mb: 0, error: String(e) };
  }
}

/**
 * 获取 session 统计
 */
export async function getSessionStats(): Promise<any> {
  try {
    const native = getNativeInstance();
    return await native.sessionStats();
  } catch (e) {
    return { session_count: 0, error: String(e) };
  }
}

/**
 * Fallback: 简单 token 估算（当 native 不可用时）
 */
function estimateTokensFallback(text: string): number {
  let cjk = 0;
  let other = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0) || 0;
    if (
      (cp >= 0x4E00 && cp <= 0x9FFF) ||
      (cp >= 0x3400 && cp <= 0x4DBF) ||
      (cp >= 0xFF00 && cp <= 0xFFEF) ||
      (cp >= 0x3000 && cp <= 0x303F)
    ) {
      cjk++;
    } else {
      other++;
    }
  }
  return Math.ceil(cjk / 2) + Math.ceil(other / 4);
}
