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
}

export interface AtoaResponsePayload {
  v: 1;
  requestId: string;
  question: string;
  answer: string;
  createdAt: string;
}

export type ParsedAtoaMessage =
  | { kind: 'request'; payload: AtoaRequestPayload }
  | { kind: 'response'; payload: AtoaResponsePayload };

export function buildAtoaRequest(
  question: string,
  id: string = crypto.randomUUID(),
): string {
  const cleanQuestion = (question.trim() || '请判断你现在是否方便处理这件事，并给出简短建议。')
    .slice(0, 1200);
  const payload: AtoaRequestPayload = {
    v: 1,
    id,
    question: cleanQuestion,
    createdAt: new Date().toISOString(),
  };
  return `${ATOA_REQUEST_PREFIX}${JSON.stringify(payload)}`;
}

export function buildAtoaResponse(input: {
  requestId: string;
  question: string;
  answer: string;
}): string {
  const payload: AtoaResponsePayload = {
    v: 1,
    requestId: input.requestId,
    question: input.question.trim().slice(0, 1200),
    answer: input.answer.trim().slice(0, 2400),
    createdAt: new Date().toISOString(),
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
  if (parsed.kind === 'request') {
    return `向对方 Otto 提问：${parsed.payload.question}\n\n等待对方确认后由其 Otto 回答；本次不会自动读取对方的工作日志或文件。`;
  }
  return `对方 Otto 回复：\n${parsed.payload.answer}`;
}
