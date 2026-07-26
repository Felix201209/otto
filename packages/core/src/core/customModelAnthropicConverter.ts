/**
 * @license
 * Copyright 2026 Felix
 * SPDX-License-Identifier: Apache-2.0
 */

import { FinishReason } from '@google/genai';
import { MESSAGE_ROLES } from '../config/messageRoles.js';
import { pairToolCallIds } from './customModelToolCallIds.js';

/**
 * Anthropic 格式转换工具
 * 完整支持 Anthropic Messages API 格式，包括：
 * - system 数组格式（带 cache_control）
 * - extended thinking 配置
 * - 完整的 input_schema（含 additionalProperties）
 * @see https://docs.anthropic.com/en/api/messages
 */
export const AnthropicConverter = {
  /**
   * 将 Gemini 格式内容转换为 Anthropic 格式
   * 自动添加 cache_control 以利用 Anthropic prompt caching：
   * - 所有 system 消息块添加 cache_control: { type: 'ephemeral' }
   * - 用户消息的最后一个文本块添加 cache_control: { type: 'ephemeral' }
   * @see https://docs.anthropic.com/en/docs/build-with-claude/prompt-caching
   */
  contentsToAnthropic(contents: any[]): { messages: any[], system?: any[] } {
    const messages: any[] = [];
    const systemBlocks: any[] = [];

    // 🆕 跨模型迁移 → Anthropic：tool_use / tool_result 必须 id 严格一致
    //
    // Gemini 原生历史里的 functionCall / functionResponse 大多是「无 id」的
    // （Gemini 协议本身不强制要求 callId）。如果直接把这种历史塞给 Claude，
    // 旧实现里：
    //
    //   - functionCall.id  缺失 → tool_use.id  退化成 `toolu_${Date.now()}_${rand}`
    //   - functionResponse.id 缺失 → tool_result.tool_use_id 退化成 `toolu_${name}`
    //
    // 两个 fallback 各自独立、永不可能相等 → Bedrock / Anthropic 直接 400：
    //   ValidationException: unexpected `tool_use_id` found in `tool_result`
    //   blocks: toolu_<name>. Each `tool_result` block must have a corresponding
    //   `tool_use` block in the previous message.
    //
    // 修复策略：在生成 anthropic 协议之前，先做一次「FIFO id 配对」预扫描——
    // 把同名的 functionCall / functionResponse 按出现顺序一一配对，让每一对
    // 共享同一个「权威 id」，从根上保证 tool_use.id === tool_result.tool_use_id。
    //
    // 🐛 二次修复（2026-06-04）：旧实现只给「无 id」的 fc/fr 造合成 id 并配对，
    //   却把「fc 无 id 但 fr 带真实 id」这种最常见的脏状态漏掉了：
    //   functionResponse 的 id 由 coreToolScheduler 用 `${name}-${ts}-${rand}`
    //   强制写入（见 createFunctionResponsePart），几乎总是存在；而 Gemini 原生
    //   functionCall 通常无 id。旧逻辑给 fc 造了 `toolu_synth_read_file_1`、却
    //   因为 fr「已有 id」而跳过它，于是：
    //     tool_use.id = toolu_synth_read_file_1
    //     tool_result.tool_use_id = read_file-<ts>-<rand>
    //   两侧永不相等 → Bedrock/Anthropic 400:
    //     unexpected `tool_use_id` found in `tool_result` blocks.
    //
    //   现在改为：每对 fc·fr 的权威 id 优先级 = fc 原始 id > fr 原始 id（CLI callId）
    //   > 确定性合成 id；解析出来后同时写回 fc 和 fr 对应的 part，严格一致。
    //
    // 设计要点：
    //   - 已自洽（fc.id === fr.id）的配对先剔除，绝不被 FIFO 误配。
    //   - 队列按 name 分桶 → 一条 model turn 里多个同名 fc 也能正确配对。
    //   - 合成 id 仅在 fc/fr 双方都无 id 时才用，且基于稳定 counter（幂等，不依赖
    //     Date.now()/Math.random()，避免 retry 路径产生不同 id）。
    //   - 兜底：完全孤立的 fr（无任何同名 fc）仍退回原 `toolu_${name}` 行为；
    //     这种情况通常已被上游 sanitizeRequestContents 过滤，这里只是最后一道保险。
    const synthIdByPart = pairToolCallIds(contents, 'toolu_synth');

    for (const content of contents) {
      const parts = content.parts || [];

      if (content.role === 'system') {
        // 转换为 Anthropic system 数组格式
        for (const p of parts) {
          if (p.text && p.text.trim() !== '') {
            const block: any = { type: 'text', text: p.text };
            // 🆕 自动添加 cache_control（与 Claude Code 行为一致）
            block.cache_control = p.cache_control || { type: 'ephemeral' };
            systemBlocks.push(block);
          }
        }
        continue;
      }

      const role = content.role === MESSAGE_ROLES.MODEL ? 'assistant' : 'user';
      const anthropicParts: any[] = [];

      for (const part of parts) {
        if (part.text && part.text.trim() !== '') {
          const textBlock: any = { type: 'text', text: part.text };
          // 透传已有的 cache_control（后续会为最后一个文本块自动添加）
          if (part.cache_control) {
            textBlock.cache_control = part.cache_control;
          }
          anthropicParts.push(textBlock);
        }
        if (part.inlineData) {
          // 转换 Gemini inlineData 格式为 Anthropic image 格式
          anthropicParts.push({
            type: 'image',
            source: {
              type: 'base64',
              media_type: part.inlineData.mimeType,
              data: part.inlineData.data,
            },
          });
        }
        if (part.functionCall) {
          // id 解析优先级：配对预扫描算出的「权威 id」> 原始 id > 退化随机 id
          // （权威 id 优先，是为了让一对 fc/fr 即便原始 id 不一致也强制对齐到同一个）
          const synth = synthIdByPart.get(part);
          const resolvedId =
            synth ||
            ((typeof part.functionCall.id === 'string' && part.functionCall.id.length > 0)
              ? part.functionCall.id
              : `toolu_${Date.now()}_${Math.random().toString(36).slice(2)}`);
          anthropicParts.push({
            type: 'tool_use',
            id: resolvedId,
            name: part.functionCall.name,
            input: part.functionCall.args || {},
          });
        }
        if (part.functionResponse) {
          // tool_use_id 解析优先级：配对预扫描算出的「权威 id」> 原始 id > 退化 `toolu_${name}`
          const synth = synthIdByPart.get(part);
          if (synth === undefined) {
            // 孤立的 functionResponse：前文找不到对应的 functionCall。
            // 降级为纯文本块，避免 Anthropic 400
            // (ValidationException: unexpected tool_use_id found in tool_result blocks).
            const frName = part.functionResponse?.name || 'unknown';
            const frContent = typeof part.functionResponse.response === 'string'
              ? part.functionResponse.response
              : JSON.stringify(part.functionResponse.response || {});
            console.warn(`[AnthropicConverter] Orphaned functionResponse for '${frName}' (no matching functionCall) - downgrading to text block`);
            anthropicParts.push({
              type: 'text',
              text: `[Tool result for ${frName}: ${frContent.substring(0, 500)}]`,
            });
          } else {
            const resolvedToolUseId =
              synth ||
              ((typeof part.functionResponse.id === 'string' && part.functionResponse.id.length > 0)
                ? part.functionResponse.id
                : `toolu_${part.functionResponse.name}`);
            anthropicParts.push({
              type: 'tool_result',
              tool_use_id: resolvedToolUseId,
              content: typeof part.functionResponse.response === 'string'
                ? part.functionResponse.response
                : JSON.stringify(part.functionResponse.response || {}),
            });
          }
        }
      }

      if (anthropicParts.length > 0) {
        messages.push({ role, content: anthropicParts });
      }
    }

    if (messages.length > 0 && messages[0].role === 'assistant') {
      messages.unshift({ role: 'user', content: '...' });
    }

    const merged: any[] = [];
    for (const msg of messages) {
      const prev = merged[merged.length - 1];
      if (prev && prev.role === msg.role) {
        const prevContent = Array.isArray(prev.content) ? prev.content : [{type:'text', text: prev.content}];
        const msgContent = Array.isArray(msg.content) ? msg.content : [{type:'text', text: msg.content}];
        prev.content = [...prevContent, ...msgContent];
      } else {
        merged.push(msg);
      }
    }

    // 🆕 为最后一条用户消息的最后一个块添加 cache_control
    // 与 Claude Code 行为一致，利用 prompt caching 减少 token 消耗
    // 优先寻找非空/非空白文本块，若无，则寻找其他有效内容块（如 image 或 tool_result），彻底杜绝空 text 块的注入
    for (let i = merged.length - 1; i >= 0; i--) {
      if (merged[i].role === 'user' && Array.isArray(merged[i].content)) {
        const content = merged[i].content;
        let targetBlock = null;

        // 1. 优先寻找最后一个非空非空白的文本块
        for (let j = content.length - 1; j >= 0; j--) {
          const block = content[j];
          if (
            block.type === 'text' &&
            typeof block.text === 'string' &&
            block.text.trim() !== '' &&
            !block.cache_control
          ) {
            targetBlock = block;
            break;
          }
        }

        // 2. 如果没找到符合条件的文本块，则附加到最后一个任意类型的有效块上（如 image 或 tool_result）
        if (!targetBlock) {
          for (let j = content.length - 1; j >= 0; j--) {
            const block = content[j];
            if (block && !block.cache_control) {
              targetBlock = block;
              break;
            }
          }
        }

        // 3. 注入 cache_control
        if (targetBlock) {
          targetBlock.cache_control = { type: 'ephemeral' };
        }
        break; // 只处理最后一条用户消息
      }
    }

    return {
      messages: merged,
      system: systemBlocks.length > 0 ? systemBlocks : undefined
    };
  },

  /**
   * 将工具定义转换为 Anthropic 格式
   * 完整支持 input_schema（含 additionalProperties: false）
   */
  toolsToAnthropicTools(tools: any[]): any[] | undefined {
    if (!tools || tools.length === 0) return undefined;

    const cleanSchema = (schema: any, isRoot: boolean = false): any => {
      if (!schema || typeof schema !== 'object') return schema;
      const cleaned: any = {};
      const validFields = ['type', 'properties', 'required', 'items', 'enum', 'description', 'default', 'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'minLength', 'maxLength', 'pattern', 'format', 'minItems', 'maxItems', 'uniqueItems', 'additionalProperties', 'anyOf', 'oneOf', 'allOf', 'not'];
      for (const key of validFields) {
        if (schema[key] !== undefined) {
          if (key === 'type' && typeof schema[key] === 'string') cleaned[key] = schema[key].toLowerCase();
          else if (['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'minLength', 'maxLength', 'minItems', 'maxItems'].includes(key)) {
            const val = parseFloat(schema[key]);
            if (!isNaN(val)) cleaned[key] = val;
          }
          else if (key === 'properties' && typeof schema[key] === 'object') {
            cleaned[key] = {};
            for (const k in schema[key]) cleaned[key][k] = cleanSchema(schema[key][k], false);
          } else if (key === 'items') cleaned[key] = cleanSchema(schema[key], false);
          else cleaned[key] = schema[key];
        }
      }
      return cleaned;
    };

    return tools.flatMap((tool: any) => {
      const decls = tool.functionDeclarations || [tool];
      return decls.map((fd: any) => {
        const cleaned = cleanSchema(fd.parameters || {}, true);
        return {
          name: fd.name,
          description: fd.description || '',
          input_schema: {
            $schema: 'https://json-schema.org/draft/2020-12/schema',
            type: 'object',
            properties: cleaned.properties || {},
            ...(cleaned.required && { required: cleaned.required }),
            // 🔧 关键：添加 additionalProperties: false 以匹配 Claude Code 的行为
            additionalProperties: false,
          },
        };
      });
    });
  },

  mapFinishReason(reason: string): FinishReason {
    switch (reason) {
      case 'end_turn': return FinishReason.STOP;
      case 'max_tokens': return FinishReason.MAX_TOKENS;
      case 'tool_use': return FinishReason.STOP;
      default: return FinishReason.OTHER;
    }
  }
};
