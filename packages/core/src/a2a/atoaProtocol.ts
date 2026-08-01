/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

export const ATOA_REQUEST_PREFIX = 'OTTO_ATOA_REQUEST ';
export const ATOA_RESPONSE_PREFIX = 'OTTO_ATOA_RESPONSE ';
export const ATOA_DIRECT_MESSAGE_MAX_LENGTH = 4000;

export const ATOA_CONTEXT_SOURCES = [
  'current_chat',
  'enterprise_knowledge',
  'work_logs',
  'schedules',
] as const;

export type AtoaContextSource = (typeof ATOA_CONTEXT_SOURCES)[number];
export type AtoaMode = 'answer' | 'consult';

export interface AtoaRequestPayload {
  v: 1;
  id: string;
  question: string;
  createdAt: string;
  mode: AtoaMode;
  requestedSources: AtoaContextSource[];
  /** consult 时由发起方 Otto 先基于本方授权资料形成的提案。 */
  initiatorProposal?: string;
}

export interface AtoaResponsePayload {
  v: 1;
  requestId: string;
  question: string;
  answer: string;
  createdAt: string;
  mode: AtoaMode;
  grantedSources: AtoaContextSource[];
  /** Digest of the locally signed, already-consumed one-time authorization. */
  authorizationGrantDigest?: string;
}

export type ParsedAtoaMessage =
  | { kind: 'request'; payload: AtoaRequestPayload }
  | { kind: 'response'; payload: AtoaResponsePayload };

export interface BuildAtoaRequestOptions {
  id?: string;
  mode?: AtoaMode;
  requestedSources?: readonly AtoaContextSource[];
  initiatorProposal?: string;
}

const UTF8_ENCODER = new TextEncoder();

function fitsDirectMessage(content: string): boolean {
  return (
    content.length <= ATOA_DIRECT_MESSAGE_MAX_LENGTH &&
    UTF8_ENCODER.encode(content).byteLength <=
      ATOA_DIRECT_MESSAGE_MAX_LENGTH
  );
}

function truncateCodeUnits(value: string, maxLength: number): string {
  let result = '';
  for (const character of value) {
    if (result.length + character.length > maxLength) break;
    result += character;
  }
  return result;
}

function longestFittingPrefix(
  value: string,
  serialize: (candidate: string) => string,
  required: boolean,
): string {
  const characters = Array.from(value);
  let low = required ? 1 : 0;
  let high = characters.length;
  let best = '';
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const candidate = characters.slice(0, middle).join('');
    if (fitsDirectMessage(serialize(candidate))) {
      best = candidate;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  if (required && !best) {
    throw new Error('A2A 消息固定字段超过私聊长度上限');
  }
  return best;
}

function normalizeSources(
  sources: readonly AtoaContextSource[] | undefined,
): AtoaContextSource[] {
  return ATOA_CONTEXT_SOURCES.filter((source) => sources?.includes(source));
}

export function buildAtoaRequest(
  question: string,
  optionsOrId: BuildAtoaRequestOptions | string = {},
): string {
  const options =
    typeof optionsOrId === 'string' ? { id: optionsOrId } : optionsOrId;
  let cleanQuestion = truncateCodeUnits(
    question.trim() ||
      '请判断你现在是否方便处理这件事，并给出简短建议。',
    1200,
  );
  let proposal =
    options.mode === 'consult' && options.initiatorProposal?.trim()
      ? truncateCodeUnits(options.initiatorProposal.trim(), 4000)
      : '';
  const fixed = {
    v: 1 as const,
    id: truncateCodeUnits(options.id?.trim() || crypto.randomUUID(), 200),
    createdAt: new Date().toISOString(),
    mode: options.mode ?? 'answer',
    requestedSources: normalizeSources(options.requestedSources),
  };
  const serialize = (nextQuestion: string, nextProposal: string): string =>
    `${ATOA_REQUEST_PREFIX}${JSON.stringify({
      ...fixed,
      question: nextQuestion,
      ...(nextProposal ? { initiatorProposal: nextProposal } : {}),
    } satisfies AtoaRequestPayload)}`;

  let content = serialize(cleanQuestion, proposal);
  if (fitsDirectMessage(content)) return content;

  if (proposal) {
    proposal = longestFittingPrefix(
      proposal,
      (candidate) => serialize(cleanQuestion, candidate),
      false,
    );
    if (proposal) return serialize(cleanQuestion, proposal);

    const minimumProposal = Array.from(
      truncateCodeUnits(options.initiatorProposal!.trim(), 4000),
    )[0]!;
    cleanQuestion = longestFittingPrefix(
      cleanQuestion,
      (candidate) => serialize(candidate, minimumProposal),
      true,
    );
    proposal = longestFittingPrefix(
      truncateCodeUnits(options.initiatorProposal!.trim(), 4000),
      (candidate) => serialize(cleanQuestion, candidate),
      true,
    );
    content = serialize(cleanQuestion, proposal);
  } else {
    cleanQuestion = longestFittingPrefix(
      cleanQuestion,
      (candidate) => serialize(candidate, ''),
      true,
    );
    content = serialize(cleanQuestion, '');
  }
  return content;
}

export function buildAtoaResponse(input: {
  requestId: string;
  question: string;
  answer: string;
  mode?: AtoaMode;
  grantedSources?: readonly AtoaContextSource[];
  authorizationGrantDigest?: string;
}): string {
  let question = truncateCodeUnits(input.question.trim(), 1200);
  let answer = truncateCodeUnits(input.answer.trim(), 2400);
  const fixed = {
    v: 1 as const,
    requestId: truncateCodeUnits(input.requestId.trim(), 200),
    createdAt: new Date().toISOString(),
    mode: input.mode ?? 'answer',
    grantedSources: normalizeSources(input.grantedSources),
    ...(input.authorizationGrantDigest
      ? { authorizationGrantDigest: input.authorizationGrantDigest }
      : {}),
  };
  const serialize = (nextQuestion: string, nextAnswer: string): string =>
    `${ATOA_RESPONSE_PREFIX}${JSON.stringify({
      ...fixed,
      question: nextQuestion,
      answer: nextAnswer,
    } satisfies AtoaResponsePayload)}`;

  let content = serialize(question, answer);
  if (fitsDirectMessage(content)) return content;

  const minimumQuestion = Array.from(question)[0] ?? '（';
  answer = longestFittingPrefix(
    answer || '对方 Otto 未返回有效内容。',
    (candidate) => serialize(minimumQuestion, candidate),
    true,
  );
  question = longestFittingPrefix(
    question || '（问题已省略）',
    (candidate) => serialize(candidate, answer),
    true,
  );
  content = serialize(question, answer);
  return content;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isBoundedText(
  value: unknown,
  maxLength: number,
  allowEmpty = false,
): value is string {
  return (
    typeof value === 'string' &&
    value.length <= maxLength &&
    (allowEmpty || value.trim().length > 0)
  );
}

function parseMode(value: unknown): AtoaMode | null {
  if (value === undefined) return 'answer';
  return value === 'answer' || value === 'consult' ? value : null;
}

function parseSources(value: unknown): AtoaContextSource[] | null {
  if (value === undefined) return [];
  if (
    !Array.isArray(value) ||
    value.length > ATOA_CONTEXT_SOURCES.length ||
    value.some(
      (source) =>
        typeof source !== 'string' ||
        !ATOA_CONTEXT_SOURCES.includes(source as AtoaContextSource),
    )
  ) {
    return null;
  }
  return normalizeSources(value as AtoaContextSource[]);
}

function isIsoDate(value: unknown): value is string {
  return (
    isBoundedText(value, 64) &&
    Number.isFinite(Date.parse(value))
  );
}

export function parseAtoaMessage(content: string): ParsedAtoaMessage | null {
  if (content.startsWith(ATOA_REQUEST_PREFIX)) {
    try {
      const raw = JSON.parse(content.slice(ATOA_REQUEST_PREFIX.length)) as unknown;
      if (!isRecord(raw)) return null;
      const mode = parseMode(raw.mode);
      const requestedSources = parseSources(raw.requestedSources);
      if (
        raw.v === 1 &&
        isBoundedText(raw.id, 200) &&
        isBoundedText(raw.question, 1200) &&
        isIsoDate(raw.createdAt) &&
        mode &&
        requestedSources &&
        (raw.initiatorProposal === undefined ||
          (mode === 'consult' && isBoundedText(raw.initiatorProposal, 4000)))
      ) {
        return {
          kind: 'request',
          payload: {
            v: 1,
            id: raw.id,
            question: raw.question,
            createdAt: raw.createdAt,
            mode,
            requestedSources,
            ...(typeof raw.initiatorProposal === 'string'
              ? { initiatorProposal: raw.initiatorProposal }
              : {}),
          },
        };
      }
    } catch {
      // 非法协议消息按普通文本处理。
    }
  }
  if (content.startsWith(ATOA_RESPONSE_PREFIX)) {
    try {
      const raw = JSON.parse(content.slice(ATOA_RESPONSE_PREFIX.length)) as unknown;
      if (!isRecord(raw)) return null;
      const mode = parseMode(raw.mode);
      const grantedSources = parseSources(raw.grantedSources);
      if (
        raw.v === 1 &&
        isBoundedText(raw.requestId, 200) &&
        isBoundedText(raw.question, 1200) &&
        isBoundedText(raw.answer, 2400) &&
        isIsoDate(raw.createdAt) &&
        mode &&
        grantedSources &&
        (raw.authorizationGrantDigest === undefined ||
          (typeof raw.authorizationGrantDigest === 'string' &&
            /^[0-9a-f]{64}$/u.test(raw.authorizationGrantDigest)))
      ) {
        return {
          kind: 'response',
          payload: {
            v: 1,
            requestId: raw.requestId,
            question: raw.question,
            answer: raw.answer,
            createdAt: raw.createdAt,
            mode,
            grantedSources,
            ...(typeof raw.authorizationGrantDigest === 'string'
              ? { authorizationGrantDigest: raw.authorizationGrantDigest }
              : {}),
          },
        };
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
    const label =
      parsed.payload.mode === 'consult'
        ? '发起双方 Otto 协商'
        : '向对方 Otto 提问';
    return `${label}：${parsed.payload.question}\n\n等待对方明确选择资料范围或拒绝；未经授权不会读取其聊天、知识、工作日志或日程。`;
  }
  const sourceLabels: Record<AtoaContextSource, string> = {
    current_chat: '当前聊天',
    enterprise_knowledge: '企业知识',
    work_logs: '工作日志',
    schedules: '日程',
  };
  const scope =
    parsed.payload.grantedSources.length > 0
      ? `（已授权：${parsed.payload.grantedSources
          .map((source) => sourceLabels[source])
          .join('、')}）`
      : '';
  const label =
    parsed.payload.mode === 'consult' ? '双方 Otto 协商结果' : '对方 Otto 回复';
  return `${label}${scope}：\n${parsed.payload.answer}`;
}
