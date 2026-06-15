/**
 * 第二层 probe：复用 probe-gemini-thinking.mjs 抓到的真实 SSE chunks
 * （probe-output.jsonl），按 packages/core/src/core/turn.ts:303-343 的
 * 判断顺序，模拟 Turn.run 会 yield 出什么事件。
 *
 * 用途：定位是不是 core 在解析阶段把 reasoning 误判/丢弃了。
 *
 * 用法：
 *   先跑：node scripts/probe-gemini-thinking.mjs gemini-2.5-flash
 *   再跑：node scripts/probe-gemini-thinking-pipeline.mjs
 */

import fs from 'node:fs';
import path from 'node:path';

const inFile = path.join(process.cwd(), 'probe-output.jsonl');
if (!fs.existsSync(inFile)) {
  console.error('❌ probe-output.jsonl 不存在，请先运行 probe-gemini-thinking.mjs');
  process.exit(1);
}

const lines = fs.readFileSync(inFile, 'utf8').split('\n').filter(Boolean);
console.log(`📂 Loaded ${lines.length} chunks from ${inFile}\n`);

// --- 1. 模拟 OttoServerAdapter.convertStreamChunkToGenAI ----------------
// 实现见 OttoServerAdapter.ts:1474-1521
function convertStreamChunkToGenAI(chunk) {
  if (!chunk?.candidates || !Array.isArray(chunk.candidates) || chunk.candidates.length === 0) {
    return null;
  }
  // 唯一的副作用：补 functionCall.id（与 reasoning 无关）
  return {
    candidates: chunk.candidates,
    usageMetadata: chunk.usageMetadata,
  };
}

// --- 2. 模拟 turn.ts:303-343 的判断顺序 ---------------------------------
// 关键：客户端先判 thoughtPart?.thought，再判 'reasoning' in thoughtPart，
//       最后才走 part.text。
function simulateTurnDispatch(genaiResponse) {
  const events = [];
  const thoughtPart = genaiResponse?.candidates?.[0]?.content?.parts?.[0];

  // 分支 A：Gemini 原生 thought
  if (thoughtPart?.thought) {
    const rawText = thoughtPart.text ?? '';
    const subjectMatch = rawText.match(/\*\*(.*?)\*\*/s);
    events.push({
      type: 'Thought',
      value: { subject: subjectMatch ? subjectMatch[1].trim() : '', description: rawText.replace(/\*\*(.*?)\*\*/s, '').trim() },
    });
    return events;
  }

  // 分支 B：网关规范化 reasoning
  if (thoughtPart && 'reasoning' in thoughtPart) {
    events.push({
      type: 'Reasoning',
      value: { text: thoughtPart.reasoning || '' },
    });
    return events;
  }

  // 分支 C：正文 text
  // getResponseText 等价：把所有 part.text 拼起来
  const parts = genaiResponse?.candidates?.[0]?.content?.parts ?? [];
  const text = parts
    .filter((p) => typeof p?.text === 'string')
    .map((p) => p.text)
    .join('');
  if (text) {
    events.push({ type: 'Content', value: text });
  }

  // 分支 D：finishReason
  const finishReason = genaiResponse?.candidates?.[0]?.finishReason;
  if (finishReason && events.length === 0) {
    events.push({ type: 'Finished', value: { finishReason } });
  }

  return events;
}

// --- 3. 跑全部 chunks ---------------------------------------------------
const tally = { Thought: 0, Reasoning: 0, Content: 0, Finished: 0, Empty: 0 };
const reasoningTexts = [];
const contentTexts = [];

for (const line of lines) {
  const { idx, chunk } = JSON.parse(line);
  const genai = convertStreamChunkToGenAI(chunk);
  if (!genai) {
    tally.Empty++;
    console.log(`#${String(idx).padStart(3, '0')}  ⚠ convertStreamChunkToGenAI returned null`);
    continue;
  }
  const events = simulateTurnDispatch(genai);
  if (events.length === 0) {
    tally.Empty++;
    console.log(`#${String(idx).padStart(3, '0')}  ❌ NO EVENT (chunk would be silently dropped!)`);
    continue;
  }
  for (const ev of events) {
    tally[ev.type] = (tally[ev.type] || 0) + 1;
    const preview =
      ev.type === 'Reasoning'
        ? `"${ev.value.text.substring(0, 60).replace(/\n/g, '\\n')}${ev.value.text.length > 60 ? '…' : ''}"`
        : ev.type === 'Content'
        ? `"${ev.value.substring(0, 60).replace(/\n/g, '\\n')}${ev.value.length > 60 ? '…' : ''}"`
        : ev.type === 'Thought'
        ? `subject="${ev.value.subject}" desc="${ev.value.description.substring(0, 40)}…"`
        : JSON.stringify(ev.value);
    console.log(`#${String(idx).padStart(3, '0')}  → yield ${ev.type.padEnd(10)} ${preview}`);
    if (ev.type === 'Reasoning') reasoningTexts.push(ev.value.text);
    if (ev.type === 'Content') contentTexts.push(ev.value);
  }
}

// --- 4. 总结 ------------------------------------------------------------
console.log('\n━━━━━━━━━━━━━━━━━━━━━━━ PIPELINE SUMMARY ━━━━━━━━━━━━━━━━━━━━━━');
console.log(`Reasoning events yielded:  ${tally.Reasoning}`);
console.log(`Content   events yielded:  ${tally.Content}`);
console.log(`Thought   events yielded:  ${tally.Thought}`);
console.log(`Finished  events yielded:  ${tally.Finished}`);
console.log(`Empty / dropped chunks:    ${tally.Empty}`);
console.log(`Total reasoning text len:  ${reasoningTexts.reduce((a, b) => a + b.length, 0)}`);
console.log(`Total content   text len:  ${contentTexts.reduce((a, b) => a + b.length, 0)}`);
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

if (tally.Reasoning > 0) {
  console.log('\n✅ core 解析层路径正常：reasoning chunks 会被正确 yield 为 GeminiEventType.Reasoning。');
  console.log('   bug 一定在更上层（CLI useGeminiStream 或 VSCode aiService 的事件消费）。');
} else if (tally.Thought > 0) {
  console.log('\n⚠ core 走的是 Thought 分支，没走 Reasoning 分支。需要查 turn.ts 判断顺序。');
} else {
  console.log('\n❌ core 在解析阶段就把 reasoning 全丢了，需要查 convertStreamChunkToGenAI 或更早。');
}
