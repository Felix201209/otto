/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

export const ATOA_REQUEST_PREFIX = 'OTTO_ATOA_REQUEST ';
export const ATOA_RESPONSE_PREFIX = 'OTTO_ATOA_RESPONSE ';

export interface AtoaRequestPayload {
  v: 1;
  id: string;
  question: string;
  createdAt: string;
  mode?: 'answer' | 'consult';
  contextScope?: 'otto_context' | 'current_chat';
}

export interface AtoaResponsePayload {
  v: 1;
  requestId: string;
  question: string;
  answer: string;
  createdAt: string;
  mode?: 'answer' | 'consult';
  contextScope?: 'otto_context' | 'current_chat';
}

export type ParsedAtoaMessage =
  | { kind: 'request'; payload: AtoaRequestPayload }
  | { kind: 'response'; payload: AtoaResponsePayload };

export function buildAtoaRequest(
  question: string,
  idOrOptions: string | {
    id?: string;
    mode?: AtoaRequestPayload['mode'];
    contextScope?: AtoaRequestPayload['contextScope'];
  } = crypto.randomUUID(),
): string {
  const options = typeof idOrOptions === 'string' ? { id: idOrOptions } : idOrOptions;
  const cleanQuestion = (question.trim() || '请判断你现在是否方便处理这件事，并给出简短建议。')
    .slice(0, 1200);
  const payload: AtoaRequestPayload = {
    v: 1,
    id: options.id ?? crypto.randomUUID(),
    question: cleanQuestion,
    createdAt: new Date().toISOString(),
    mode: options.mode ?? 'answer',
    contextScope: options.contextScope ?? 'otto_context',
  };
  return `${ATOA_REQUEST_PREFIX}${JSON.stringify(payload)}`;
}

export function buildAtoaResponse(input: {
  requestId: string;
  question: string;
  answer: string;
  mode?: AtoaResponsePayload['mode'];
  contextScope?: AtoaResponsePayload['contextScope'];
}): string {
  const payload: AtoaResponsePayload = {
    v: 1,
    requestId: input.requestId,
    question: input.question.trim().slice(0, 1200),
    answer: input.answer.trim().slice(0, 2400),
    createdAt: new Date().toISOString(),
    mode: input.mode ?? 'answer',
    contextScope: input.contextScope ?? 'otto_context',
  };
  return `${ATOA_RESPONSE_PREFIX}${JSON.stringify(payload)}`;
}

export function parseAtoaMessage(content: string): ParsedAtoaMessage | null {
  if (content.startsWith(ATOA_REQUEST_PREFIX)) {
    try {
      const payload = JSON.parse(content.slice(ATOA_REQUEST_PREFIX.length)) as AtoaRequestPayload;
      if (payload?.v === 1 && typeof payload.id === 'string' && typeof payload.question === 'string') {
        return { kind: 'request', payload };
      }
    } catch {
      // 非法协议消息按普通文本处理。
    }
  }
  if (content.startsWith(ATOA_RESPONSE_PREFIX)) {
    try {
      const payload = JSON.parse(content.slice(ATOA_RESPONSE_PREFIX.length)) as AtoaResponsePayload;
      if (
        payload?.v === 1
        && typeof payload.requestId === 'string'
        && typeof payload.question === 'string'
        && typeof payload.answer === 'string'
      ) {
        return { kind: 'response', payload };
      }
    } catch {
      // 非法协议消息按普通文本处理。
    }
  }
  return null;
}

export function displayDirectMessageContent(content: string): string {
  const parsed = parseAtoaMessage(content);
  if (!parsed) return content;
  const scope = parsed.payload.contextScope === 'current_chat'
    ? '仅当前聊天'
    : 'Otto 可用资料';
  if (parsed.kind === 'request') {
    const title = parsed.payload.mode === 'consult'
      ? '发起双方 Otto 协商'
      : '向对方 Otto 提问';
    const tail = parsed.payload.mode === 'consult'
      ? '等待对方同意后进入协商，不展开中间过程，只在聊天里显示最终摘要。'
      : '等待对方确认后由其 Otto 回答。';
    return `${title}：${parsed.payload.question}\n\n默认范围：${scope}。${tail}`;
  }
  const title = parsed.payload.mode === 'consult'
    ? '双方 Otto 协商结果'
    : '对方 Otto 回复';
  return `${title}（基于：${scope}）：\n${parsed.payload.answer}`;
}
