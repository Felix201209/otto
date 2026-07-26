/**
 * @license
 * Copyright 2026 Felix
 * SPDX-License-Identifier: Apache-2.0
 */

import { MESSAGE_ROLES } from '../config/messageRoles.js';

/**
 * 跨协议通用的「tool_call ↔ tool_result id 配对」预扫描器。
 *
 * 三家上游（Anthropic / OpenAI Chat / OpenAI Responses）都强制要求：
 *   工具结果块（tool_result / role:'tool' / function_call_output）携带的 id
 *   必须能在前文找到一个完全相同 id 的工具调用块（tool_use / tool_calls /
 *   function_call）。否则一律 400（Anthropic: invalid_request_error；OpenAI:
 *   "tool_call_id did not have a matching tool_calls"）。
 *
 * 但 Gemini 原生历史里 functionCall 通常无 id，functionResponse 又被
 * coreToolScheduler 强制写入了 `${name}-${ts}-${rand}` 形式的 callId。直接转换
 * 会导致两侧 id 错位。本函数统一在转换前把同名 fc/fr 按 FIFO 配对，给每一对
 * 选出唯一「权威 id」（优先 fc 原始 id，其次 fr 原始 id，最后确定性合成 id），
 * 并返回一个 part → 权威 id 的 WeakMap，供各转换器在产出 id 时优先采用。
 *
 * @param contents          Gemini 格式历史
 * @param synthPrefix       合成 id 前缀（Anthropic 用 'toolu_synth'，OpenAI 用 'call_synth'）
 * @returns WeakMap<part, canonicalId>
 */
export function pairToolCallIds(
  contents: any[],
  synthPrefix: string,
): WeakMap<object, string> {
  const idByPart = new WeakMap<object, string>();
  let synthCounter = 0;
  const hasId = (x: any) => x && typeof x.id === 'string' && x.id.length > 0;

  const callPartsByName: Map<string, Array<{ part: any; fc: any }>> = new Map();
  const respPartsByName: Map<string, Array<{ part: any; fr: any }>> = new Map();
  for (const content of contents || []) {
    const parts = content?.parts || [];
    if (content?.role === MESSAGE_ROLES.MODEL) {
      for (const part of parts) {
        if (!part || typeof part !== 'object') continue;
        const fc = part.functionCall;
        if (!fc || typeof fc !== 'object') continue;
        const name = typeof fc.name === 'string' ? fc.name : 'unknown';
        if (!callPartsByName.has(name)) callPartsByName.set(name, []);
        callPartsByName.get(name)!.push({ part, fc });
      }
    } else if (content?.role === MESSAGE_ROLES.USER) {
      for (const part of parts) {
        if (!part || typeof part !== 'object') continue;
        const fr = part.functionResponse;
        if (!fr || typeof fr !== 'object') continue;
        const name = typeof fr.name === 'string' ? fr.name : 'unknown';
        if (!respPartsByName.has(name)) respPartsByName.set(name, []);
        respPartsByName.get(name)!.push({ part, fr });
      }
    }
  }

  const allNames = new Set<string>([
    ...callPartsByName.keys(),
    ...respPartsByName.keys(),
  ]);
  for (const name of allNames) {
    const calls = callPartsByName.get(name) ?? [];
    const resps = respPartsByName.get(name) ?? [];

    // 步骤 A：剔除「fc.id === fr.id」的自洽配对，避免 FIFO 误配。
    const usedResp = new Set<number>();
    const pendingCalls: Array<{ part: any; fc: any }> = [];
    for (const c of calls) {
      if (hasId(c.fc)) {
        const matchIdx = resps.findIndex(
          (r, i) => !usedResp.has(i) && hasId(r.fr) && r.fr.id === c.fc.id,
        );
        if (matchIdx >= 0) {
          const r = resps[matchIdx];
          // 已自洽的原始 id 也必须写进映射。转换器把“没有映射”解释为
          // 孤立 response；此前这里只从 FIFO 队列剔除，导致合法的原始
          // fc/fr 配对被误降级为文本。
          idByPart.set(c.part, c.fc.id);
          idByPart.set(r.part, c.fc.id);
          usedResp.add(matchIdx);
          continue;
        }
      }
      pendingCalls.push(c);
    }
    const pendingResps = resps.filter((_, i) => !usedResp.has(i));

    // 步骤 B：剩余 fc·fr 按 FIFO 一一配对，共享权威 id（fc.id > fr.id > 合成 id）
    const n = Math.max(pendingCalls.length, pendingResps.length);
    for (let k = 0; k < n; k++) {
      const c = pendingCalls[k];
      const r = pendingResps[k];
      let canonical: string;
      if (c && hasId(c.fc)) canonical = c.fc.id;
      else if (r && hasId(r.fr)) canonical = r.fr.id;
      else if (c) canonical = `${synthPrefix}_${name}_${++synthCounter}`;
      else continue; // 多出来的孤立 fr：交给调用方各自的 fallback 处理
      if (c) idByPart.set(c.part, canonical);
      if (r) idByPart.set(r.part, canonical);
    }
  }

  return idByPart;
}
