/**
 * @license
 * Copyright 2026 Felix
 * SPDX-License-Identifier: Apache-2.0
 */

import { FinishReason } from '@google/genai';
import { MESSAGE_ROLES } from '../config/messageRoles.js';
import { cleanOpenAICompatibleSchema } from './customModelOpenAISchema.js';
import { pairToolCallIds } from './customModelToolCallIds.js';

interface ConverterFunctionCall { id?: string; name?: string; args?: unknown }
interface ConverterFunctionResponse { name?: string; response?: unknown }
interface ConverterPart {
  text?: string;
  reasoning?: string;
  inlineData?: { mimeType?: string; data?: string };
  functionCall?: ConverterFunctionCall;
  functionResponse?: ConverterFunctionResponse;
}
interface ConverterContent { role?: string; parts?: ConverterPart[] }
interface OpenAIToolCall { id?: string; type: 'function'; function: { name?: string; arguments: string } }
interface OpenAIMessage {
  role?: string;
  content?: unknown;
  tool_call_id?: string;
  tool_calls?: OpenAIToolCall[];
  reasoning_content?: string;
  [key: string]: unknown;
}
interface OpenAIToolDefinition {
  name?: string;
  description?: string;
  parameters?: unknown;
  functionDeclarations?: Array<{ name?: string; description?: string; parameters?: unknown }>;
}

/**
 * OpenAI 格式转换工具
 */
function closeOpenAIToolCallGaps(messages: OpenAIMessage[]): OpenAIMessage[] {
  const closed: OpenAIMessage[] = [];
  let pendingToolIds: Set<string> | null = null;

  const appendMissingToolResults = () => {
    if (!pendingToolIds || pendingToolIds.size === 0) {
      pendingToolIds = null;
      return;
    }

    for (const id of pendingToolIds) {
      closed.push({
        role: 'tool',
        tool_call_id: id,
        content: JSON.stringify({
          result: 'tool result unavailable',
          error: 'The previous tool call was interrupted before a tool result was recorded.',
        }),
      });
    }
    pendingToolIds = null;
  };

  for (const msg of messages) {
    if (msg?.role === 'tool') {
      const toolCallId = msg.tool_call_id;
      if (typeof toolCallId === 'string' && pendingToolIds?.has(toolCallId)) {
        closed.push(msg);
        pendingToolIds.delete(toolCallId);
        if (pendingToolIds.size === 0) {
          pendingToolIds = null;
        }
      } else {
        console.warn(`[OpenAIConverter] Dropping orphaned tool message: ${toolCallId || 'unknown'}`);
      }
      continue;
    }

    appendMissingToolResults();
    closed.push(msg);

    if (msg?.role === 'assistant' && Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
      pendingToolIds = new Set(
        msg.tool_calls
          .map((toolCall) => toolCall?.id)
          .filter((id: unknown): id is string => typeof id === 'string' && id.length > 0),
      );
      if (pendingToolIds.size === 0) {
        pendingToolIds = null;
      }
    }
  }

  appendMissingToolResults();
  return closed;
}

export const OpenAIConverter = {
  /**
   * 将单个 part 转换为 OpenAI content 格式
   * 支持 text 和 inlineData (图片)
   */
  partToOpenAIContent(part: ConverterPart): OpenAIMessage['content'] | null {
    if (part.text) {
      return { type: 'text', text: part.text };
    }
    if (part.inlineData) {
      // 转换 Gemini inlineData 格式为 OpenAI image_url 格式
      const { mimeType, data } = part.inlineData;
      return {
        type: 'image_url',
        image_url: {
          url: `data:${mimeType};base64,${data}`,
        },
      };
    }
    return null;
  },

  contentsToMessages(contents: ConverterContent[]): OpenAIMessage[] {
    const messages: OpenAIMessage[] = [];
    let pendingReasoning = '';

    // 🆕 与 Anthropic 路径一致：先做一次 tool_call ↔ tool_result 的 id 配对。
    // OpenAI Chat 同样强制 role:'tool' 的 tool_call_id 必须能在前文 assistant
    // 消息的 tool_calls[].id 里找到对应项，否则 400
    // ("tool_call_id did not have a matching tool_calls")。Gemini 原生历史里
    // functionCall 多半无 id，而 functionResponse 带 CLI callId，直接转换会错位。
    const idByPart = pairToolCallIds(contents, 'call_synth');

    for (const content of contents) {
      const parts = content.parts || [];
      const role = content.role === MESSAGE_ROLES.MODEL ? 'assistant' : 'user';

      // 1. 检查是否为纯思考消息：
      // 在历史中，我们把流式输出的多个 reasoning 块通过 appendReasoningToOutput 聚合成纯 reasoning Content。
      // 它通常只有 parts 且都是带 reasoning 字段的对象。
      const isPureReasoning = role === 'assistant' && parts.length > 0 && parts.every((p) => p.reasoning !== undefined);
      if (isPureReasoning) {
        pendingReasoning += parts.map((p) => p.reasoning).join('');
        continue; // 过滤纯思考消息，使其不作为独立对话发送（避免 API 报错）
      }

      // 如果遇到用户消息，说明当前助手回合结束。如果还没用掉 pendingReasoning，则清空（未调用工具时不拼接）
      if (role === 'user') {
        pendingReasoning = '';
      }

      // 2. 处理包含工具调用的消息
      if (parts.some((p) => p.functionCall)) {
        const msg: OpenAIMessage = {
          role,
          content: null,
          tool_calls: parts
            .filter((p): p is ConverterPart & { functionCall: ConverterFunctionCall } => Boolean(p.functionCall))
            .map((p, idx) => ({
              // 权威配对 id 优先（保证与下游 tool 消息的 tool_call_id 严格一致）
              id: idByPart.get(p) || p.functionCall.id || `call_${Date.now()}_${idx}`,
              type: 'function',
              function: {
                name: p.functionCall.name,
                arguments: typeof p.functionCall.args === 'string'
                  ? p.functionCall.args
                  : JSON.stringify(p.functionCall.args || {}),
              },
            })),
        };

        // DeepSeek 思考模式规则：在进行了工具调用的轮次中，reasoning_content 必须随 assistant 消息回传。
        if (pendingReasoning) {
          msg.reasoning_content = pendingReasoning;
          pendingReasoning = ''; // 消费后清除
        }

        messages.push(msg);
        continue;
      }

      // 3. 处理工具执行结果消息
      if (parts.some((p) => p.functionResponse)) {
        const functionResponseParts = parts.filter((p): p is ConverterPart & { functionResponse: ConverterFunctionResponse } => Boolean(p.functionResponse));
        const toolMessages: OpenAIMessage[] = [];
        for (const p of functionResponseParts) {
          const mappedId = idByPart.get(p);
          if (mappedId === undefined) {
            // 孤立的 functionResponse：前文找不到对应的 functionCall。
            // 降级为纯文本消息，避免 OpenAI 400
            // ("Messages with role 'tool' must be a response to a preceding message with 'tool_calls'").
            const frName = p.functionResponse?.name || 'unknown';
            const frContent = typeof p.functionResponse.response === 'string'
              ? p.functionResponse.response
              : JSON.stringify(p.functionResponse.response || {});
            console.warn(`[OpenAIConverter] Orphaned functionResponse for '${frName}' (no matching functionCall) - downgrading to text message`);
            messages.push({
              role: 'user',
              content: `[Tool result for ${frName}: ${frContent.substring(0, 500)}]`,
            });
          } else {
            toolMessages.push({
              role: 'tool',
              tool_call_id: mappedId,
              content: typeof p.functionResponse.response === 'string'
                ? p.functionResponse.response
                : JSON.stringify(p.functionResponse.response || {}),
            });
          }
        }
        if (toolMessages.length > 0) {
          messages.push(...toolMessages);
        }
        continue;
      }

      // 4. 检查是否包含图片内容
      const hasImageContent = parts.some((p) => p.inlineData);

      if (hasImageContent) {
        const contentParts = parts
          .map((part) => OpenAIConverter.partToOpenAIContent(part))
          .filter(Boolean);

        const msg: OpenAIMessage = {
          role,
          content: contentParts,
        };
        messages.push(msg);
        continue;
      }

      // 5. 纯文本内容
      const textContent = parts.map((part) => part.text || '').join('\n');
      const msg: OpenAIMessage = {
        role,
        content: textContent,
      };
      messages.push(msg);
    }

    // 🔧 Post-merge: consolidate consecutive assistant messages into one.
    // When reasoning, text, and tool_calls arrive as separate content entries
    // (e.g., from OpenAI-compatible streaming), contentsToMessages produces
    // multiple consecutive assistant messages. Models like Kimi K2.6 require
    // a single assistant message with reasoning_content, content, and tool_calls
    // combined for the same turn. Without this merge, tools calls may be rejected
    // because reasoning_content is missing from the tool-call message.
    const merged: OpenAIMessage[] = [];
    for (const msg of messages) {
      const last = merged[merged.length - 1];
      if (last && last.role === 'assistant' && msg.role === 'assistant') {
        // Merge reasoning_content: later message may carry it from pendingReasoning
        if (msg.reasoning_content && !last.reasoning_content) {
          last.reasoning_content = msg.reasoning_content;
        }
        // Merge text content: prefer non-null/non-empty; don't overwrite with null
        if (msg.content && !last.content) {
          last.content = msg.content;
        } else if (msg.content && last.content) {
          last.content = last.content + '\n' + msg.content;
        }
        // Merge tool_calls from the later message into the previous one
        if (msg.tool_calls && msg.tool_calls.length > 0) {
          if (!last.tool_calls) {
            last.tool_calls = msg.tool_calls;
          } else {
            last.tool_calls.push(...msg.tool_calls);
          }
        }
      } else {
        merged.push(msg);
      }
    }
    return closeOpenAIToolCallGaps(merged);
  },

  toolsToOpenAITools(tools: OpenAIToolDefinition[]): OpenAIMessage[] | undefined {
    if (!tools || tools.length === 0) return undefined;
    return tools.flatMap((tool) => {
      if (tool.functionDeclarations && Array.isArray(tool.functionDeclarations)) {
        return tool.functionDeclarations.map((fd) => ({
          type: 'function',
          function: {
            name: fd.name,
            description: fd.description,
            // 🔧 与 Responses API 共用：把 Google GenAI 的大写 type
            // ("STRING" / "BOOLEAN" / ...) 转小写，并强转 integer 关键字。
            // 严格的 OpenAI 兼容网关（DeepSeek 等）会按 JSON Schema 校验，
            // 收到 "BOOLEAN" 直接 400 报错。
            parameters: cleanOpenAICompatibleSchema(fd.parameters),
          },
        }));
      }
      return [{
        type: 'function',
        function: {
          name: tool.name,
          description: tool.description,
          parameters: cleanOpenAICompatibleSchema(tool.parameters),
        },
      }];
    });
  },

  mapFinishReason(reason: string): FinishReason {
    switch (reason) {
      case 'stop': return FinishReason.STOP;
      case 'length': return FinishReason.MAX_TOKENS;
      case 'content_filter': return FinishReason.SAFETY;
      case 'tool_calls': return FinishReason.STOP;
      default: return FinishReason.OTHER;
    }
  }
};
