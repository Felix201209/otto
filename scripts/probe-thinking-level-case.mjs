/**
 * 验证服务端假设：thinkingLevel 大小写是否影响 Gemini 3 reasoning 下发？
 *
 * 4 组对照（同 prompt，gemini-3.1-pro-preview，无 tools 简化变量）：
 *   ① thinkingLevel: "medium"  (小写，CLI 现状)
 *   ② thinkingLevel: "MEDIUM"  (大写，服务端建议)
 *   ③ thinkingLevel: "high"    (小写)
 *   ④ thinkingLevel: "HIGH"    (大写)
 *
 * 看每组拿到几个 reasoning chunks。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const proxyUrl = process.env.DEEPX_SERVER_URL || 'https://api-code.deepvlab.ai';
const token = JSON.parse(
  fs.readFileSync(
    path.join(
      os.homedir(),
      '.deepv',
      (process.env.DEEPX_SERVER_URL || '').includes('localhost') ? 'jwt-token-dev.json' : 'jwt-token.json',
    ),
    'utf8',
  ),
).accessToken;

const PROMPT = '请仔细分步思考：前 50 个质数之和是多少？先把思考过程一步步列出来，再给出最终答案。';

async function runOne(label, thinkingLevel) {
  const start = Date.now();
  const reqBody = {
    model: 'gemini-3.1-pro-preview',
    contents: [{ role: 'user', parts: [{ text: PROMPT }] }],
    config: {
      generationConfig: {
        thinkingConfig: { thinkingLevel, includeThoughts: true },
      },
      stream: true,
    },
  };

  const resp = await fetch(`${proxyUrl}/v1/chat/stream`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
      Authorization: `Bearer ${token}`,
      'User-Agent': 'deepv-probe/1.0',
    },
    body: JSON.stringify(reqBody),
  });

  if (!resp.ok) {
    const t = await resp.text();
    return { label, thinkingLevel, error: `HTTP ${resp.status}: ${t.substring(0, 300)}` };
  }

  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let reasoningCount = 0;
  let reasoningBytes = 0;
  let textCount = 0;
  let textBytes = 0;
  let firstByteAt = null;
  let chunkIdx = 0;
  let parseErrCount = 0;
  let thoughtsTokenCount = null;
  const fieldKeys = new Set();
  const sigCount = { count: 0 };
  let firstReasoningPreview = null;
  let firstTextPreview = null;

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    if (firstByteAt === null) firstByteAt = Date.now() - start;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      const data = line.slice(6);
      if (data === '[DONE]') break;
      let chunk;
      try {
        chunk = JSON.parse(data);
      } catch {
        parseErrCount++;
        continue;
      }
      chunkIdx++;
      if (chunk?.usageMetadata?.thoughtsTokenCount !== undefined) {
        thoughtsTokenCount = chunk.usageMetadata.thoughtsTokenCount;
      }
      const parts = chunk?.candidates?.[0]?.content?.parts ?? [];
      for (const p of parts) {
        if (!p || typeof p !== 'object') continue;
        Object.keys(p).forEach((k) => fieldKeys.add(k));
        if (typeof p.thoughtSignature === 'string') sigCount.count++;
        if ('reasoning' in p) {
          reasoningCount++;
          reasoningBytes += (p.reasoning || '').length;
          if (firstReasoningPreview === null) firstReasoningPreview = (p.reasoning || '').substring(0, 60);
        } else if (typeof p.text === 'string') {
          textCount++;
          textBytes += p.text.length;
          if (firstTextPreview === null) firstTextPreview = p.text.substring(0, 60);
        }
      }
    }
  }

  const totalMs = Date.now() - start;
  return {
    label,
    thinkingLevel,
    firstByteAt,
    totalMs,
    chunkIdx,
    reasoningCount,
    reasoningBytes,
    textCount,
    textBytes,
    parseErrCount,
    thoughtsTokenCount,
    fieldKeys: [...fieldKeys],
    sigCount: sigCount.count,
    firstReasoningPreview,
    firstTextPreview,
  };
}

const trials = [
  ['① medium (lowercase, CLI 现状)', 'medium'],
  ['② MEDIUM (uppercase, 服务端建议)', 'MEDIUM'],
  ['③ high (lowercase)', 'high'],
  ['④ HIGH (uppercase)', 'HIGH'],
];

console.log('=== thinkingLevel case sensitivity probe ===');
console.log('Model: gemini-3.1-pro-preview, no tools, prompt = "前 50 质数之和"\n');

const results = [];
for (const [label, level] of trials) {
  console.log(`Running: ${label} ...`);
  try {
    const r = await runOne(label, level);
    results.push(r);
    if (r.error) {
      console.log(`  ❌ ${r.error}\n`);
    } else {
      console.log(
        `  reasoning=${r.reasoningCount}/${r.reasoningBytes}B  text=${r.textCount}/${r.textBytes}B  thoughtsTok=${r.thoughtsTokenCount}  parseErr=${r.parseErrCount}  fb=${r.firstByteAt}ms  total=${r.totalMs}ms`,
      );
      console.log(`  fields=[${r.fieldKeys.join(', ')}]  sig=${r.sigCount}`);
      if (r.firstReasoningPreview) console.log(`  reasoning preview: ${JSON.stringify(r.firstReasoningPreview)}…`);
      if (r.firstTextPreview) console.log(`  text preview:      ${JSON.stringify(r.firstTextPreview)}…`);
      console.log('');
    }
  } catch (e) {
    console.log(`  💥 ${e.message}\n`);
    results.push({ label, thinkingLevel: level, error: e.message });
  }
}

// 汇总
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━ SUMMARY ━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log(
  'Trial                                    | reasoning | text | thoughtsTok | fields',
);
console.log(
  '-----------------------------------------|-----------|------|-------------|----------------------------------',
);
for (const r of results) {
  if (r.error) {
    console.log(`${r.label.padEnd(40)} | ERROR: ${r.error.substring(0, 60)}`);
    continue;
  }
  console.log(
    `${r.label.padEnd(40)} | ${String(r.reasoningCount).padStart(4)}/${String(r.reasoningBytes).padStart(4)}B | ${String(r.textCount).padStart(2)}/${String(r.textBytes).padStart(4)}B | ${String(r.thoughtsTokenCount ?? '?').padStart(11)} | [${r.fieldKeys.join(',')}]`,
  );
}

// 结论判定
const lowerMedium = results.find((r) => r.thinkingLevel === 'medium');
const upperMEDIUM = results.find((r) => r.thinkingLevel === 'MEDIUM');
const lowerHigh = results.find((r) => r.thinkingLevel === 'high');
const upperHIGH = results.find((r) => r.thinkingLevel === 'HIGH');

console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━ VERDICT ━━━━━━━━━━━━━━━━━━━━━━━━━━');
const lowerHasReasoning =
  (lowerMedium?.reasoningCount ?? 0) > 0 || (lowerHigh?.reasoningCount ?? 0) > 0;
const upperHasReasoning =
  (upperMEDIUM?.reasoningCount ?? 0) > 0 || (upperHIGH?.reasoningCount ?? 0) > 0;

if (!lowerHasReasoning && upperHasReasoning) {
  console.log('🎯 服务端假设成立：小写 thinkingLevel 抑制 reasoning 下发，大写正常。');
} else if (lowerHasReasoning && !upperHasReasoning) {
  console.log('⚠️ 反转：小写正常，大写反而抑制。需要服务端进一步排查。');
} else if (lowerHasReasoning && upperHasReasoning) {
  console.log('📣 大小写均正常下发 reasoning。服务端的"大小写敏感"假设不成立。');
} else {
  console.log('⚠️ 两种大小写都没有 reasoning。问题在别处（不是大小写）。');
}

// HTTP 错误观察
const errs = results.filter((r) => r.error);
if (errs.length > 0) {
  console.log('\n⚠️ 注意：以下 trial 有 HTTP 错误（如果是 400/422，更直接证明大小写敏感）：');
  for (const e of errs) console.log(`  ${e.label}: ${e.error}`);
}
