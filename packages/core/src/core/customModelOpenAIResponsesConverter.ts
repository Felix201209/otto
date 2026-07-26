/**
 * @license
 * Copyright 2026 Felix
 * SPDX-License-Identifier: Apache-2.0
 */

import { FinishReason } from '@google/genai';
import { MESSAGE_ROLES } from '../config/messageRoles.js';
import { parseJSONSafe } from './customModelJson.js';
import { cleanOpenAICompatibleSchema } from './customModelOpenAISchema.js';
import { pairToolCallIds } from './customModelToolCallIds.js';

/**
 * OpenAI Responses API 格式转换工具
 * Responses API 使用 input/output 而非 messages/choices
 * @see https://platform.openai.com/docs/api-reference/responses
 */
export const OpenAIResponsesConverter = {
  /**
   * 将内部内容格式转换为 Responses API 的 input 格式
   * Responses API 使用扁平化的 items 数组，与 Chat Completions 的 messages 格式不同：
   * - 文本消息: { role: "user"|"assistant"|"system", content: "..." }
   * - 函数调用: { type: "function_call", call_id: "...", name: "...", arguments: "..." }
   * - 函数输出: { type: "function_call_output", call_id: "...", output: "..." }
   */
  contentsToInput(contents: any[]): any[] {
    const items: any[] = [];

    // 🆕 与 Anthropic / Chat 路径一致：先做 tool_call ↔ tool_result 的 id 配对。
    // Responses API 同样强制 function_call_output.call_id 必须能在前文的
    // function_call.call_id 里找到对应项，否则 400。
    const idByPart = pairToolCallIds(contents, 'call_synth');

    for (const content of contents) {
      const parts = content.parts || [];
      const role = content.role === MESSAGE_ROLES.MODEL ? 'assistant'
                 : content.role === 'system' ? 'system'
                 : 'user';

      // 收集当前 content 的各类部分（保留 part 引用以便查权威配对 id）
      const textParts: string[] = [];
      const functionCalls: Array<{ part: any; fc: any }> = [];
      const functionResponses: Array<{ part: any; fr: any }> = [];
      const imageParts: any[] = [];

      for (const part of parts) {
        if (part.functionCall) {
          functionCalls.push({ part, fc: part.functionCall });
        } else if (part.functionResponse) {
          functionResponses.push({ part, fr: part.functionResponse });
        } else if (part.text) {
          textParts.push(part.text);
        } else if (part.inlineData) {
          imageParts.push(part.inlineData);
        }
      }

      // 如果有文本或图片，先输出文本消息
      if (textParts.length > 0 || imageParts.length > 0) {
        if (imageParts.length > 0) {
          // 混合内容：文本 + 图片
          const contentParts: any[] = [];
          for (const text of textParts) {
            contentParts.push({ type: 'input_text', text });
          }
          for (const img of imageParts) {
            contentParts.push({
              type: 'input_image',
              image_url: `data:${img.mimeType};base64,${img.data}`,
            });
          }
          items.push({ role, content: contentParts });
        } else {
          items.push({ role, content: textParts.join('\n') });
        }
      }

      // 函数调用作为独立的 function_call items（不包裹在 message 中）
      for (const { part, fc } of functionCalls) {
        items.push({
          type: 'function_call',
          call_id: idByPart.get(part) || fc.id || `call_${Date.now()}_${Math.random().toString(36).slice(2)}`,
          name: fc.name,
          arguments: typeof fc.args === 'string' ? fc.args : JSON.stringify(fc.args || {}),
        });
      }

      // 函数响应作为独立的 function_call_output items
      for (const { part, fr } of functionResponses) {
        items.push({
          type: 'function_call_output',
          call_id: idByPart.get(part) || fr.id || `call_${fr.name}`,
          output: typeof fr.response === 'string'
            ? fr.response
            : JSON.stringify(fr.response || {}),
        });
      }
    }

    return items;
  },

  /**
   * 将工具定义转换为 Responses API 格式
   * Responses API 使用 type: "function" 包装，内部标记 (internally-tagged)
   * 注意：Responses API 的 schema 校验比 Chat Completions 更严格，
   * 必须将 Google GenAI 的大写类型转为小写
   */
  toolsToResponsesTools(tools: any[]): any[] | undefined {
    if (!tools || tools.length === 0) return undefined;
    return tools.flatMap((tool: any) => {
      if (tool.functionDeclarations && Array.isArray(tool.functionDeclarations)) {
        return tool.functionDeclarations.map((fd: any) => ({
          type: 'function',
          name: fd.name,
          description: fd.description,
          parameters: cleanOpenAICompatibleSchema(fd.parameters),
          strict: false, // Responses API defaults to strict: true, set false for compatibility
        }));
      }
      return [{
        type: 'function',
        name: tool.name,
        description: tool.description,
        parameters: cleanOpenAICompatibleSchema(tool.parameters),
        strict: false,
      }];
    });
  },

  /**
   * 从 Responses API 的 output items 中提取 parts
   *
   * 项目类型对照：
   * - reasoning  → 含 summary[] 数组（gpt-5.x 思考摘要），映射为 { reasoning } parts
   * - message    → 内含 content[] 含 output_text，映射为 { text } parts
   * - function_call → 直接映射为 { functionCall } part
   */
  outputToParts(output: any[]): any[] {
    const parts: any[] = [];
    if (!output || !Array.isArray(output)) return parts;

    for (const item of output) {
      if (item.type === 'reasoning') {
        // Reasoning items hold one or more summary blocks: { type:'summary_text', text:'…' }
        if (Array.isArray(item.summary)) {
          for (const s of item.summary) {
            if (s?.type === 'summary_text' && typeof s.text === 'string' && s.text) {
              parts.push({ reasoning: s.text });
            }
          }
        }
      } else if (item.type === 'message') {
        // message item contains content array
        if (item.content && Array.isArray(item.content)) {
          for (const c of item.content) {
            if (c.type === 'output_text') {
              parts.push({ text: c.text });
            }
          }
        }
      } else if (item.type === 'function_call') {
        parts.push({
          functionCall: {
            name: item.name?.trim() || item.name,
            args: parseJSONSafe(item.arguments || '{}'),
            id: item.call_id || item.id,
          },
        });
      }
    }
    return parts;
  },

  mapFinishReason(status: string): FinishReason {
    switch (status) {
      case 'completed': return FinishReason.STOP;
      case 'incomplete': return FinishReason.MAX_TOKENS;
      case 'failed': return FinishReason.OTHER;
      default: return FinishReason.OTHER;
    }
  }
};
