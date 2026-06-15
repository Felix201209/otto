/**
 * 关键差分实验：thinkingConfig 字段位置
 *
 * 假设：CLI 把 thinkingConfig 放在 config.generationConfig.thinkingConfig，
 * 但 @google/genai SDK 类型定义要求放在 config.thinkingConfig（不嵌套 generationConfig）。
 *
 * 实验：同一 prompt + 31 工具，对比两种 schema：
 *   A. config: { generationConfig: { thinkingConfig: {...} } }   ← CLI 现状
 *   B. config: { thinkingConfig: {...} }                         ← SDK 标准
 *
 * 看 reasoning chunks 数量。
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

// 故意短 prompt，模拟用户那次"前 50 质数和"
const PROMPT = '前 50 质数和';

const fakeTools = [{
  functionDeclarations: [
    'list_directory', 'read_file', 'search_file_content', 'glob', 'replace',
    'write_file', 'delete_file', 'web_fetch', 'read_many_files', 'run_shell_command',
    'save_memory', 'google_web_search', 'todo_write', 'read_lints', 'lint_fix',
    'use_skill', 'list_available_skills', 'get_skill_details', 'ppt_outline',
    'ppt_generate', 'codesearch', 'lsp', 'multiedit', 'patch', 'batch',
    'ask_user_question', 'local_time', 'goal_achieved', 'task',
    'resolve-library-id', 'query-docs',
  ].map((name) => ({
    name,
    description: `Mock declaration of ${name}`,
    parameters: { type: 'object', properties: {}, required: [] },
  })),
}];

async function runOne(label, configBody) {
  console.log(`\n━━━━━━━━━━ ${label} ━━━━━━━━━━`);
  console.log('Request config:', JSON.stringify(configBody));
  const start = Date.now();
  const resp = await fetch(`${proxyUrl}/v1/chat/stream`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
      Authorization: `Bearer ${token}`,
      'User-Agent': 'deepv-probe/1.0',
    },
    body: JSON.stringify({
      model: 'gemini-3.1-pro-preview',
      contents: [{ role: 'user', parts: [{ text: PROMPT }] }],
      config: { ...configBody, stream: true, tools: fakeTools },
    }),
  });
  if (!resp.ok) {
    console.error(`HTTP ${resp.status}: ${(await resp.text()).substring(0, 300)}`);
    return null;
  }
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let r = 0, rB = 0, t = 0, tB = 0, n = 0, fb = null;
  let thoughtsTokens = null;
  const fields = new Set();
  let firstReasoning = null;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    if (fb === null) fb = Date.now() - start;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      const data = line.slice(6);
      if (data === '[DONE]') break;
      let chunk; try { chunk = JSON.parse(data); } catch { continue; }
      n++;
      if (chunk?.usageMetadata?.thoughtsTokenCount !== undefined) thoughtsTokens = chunk.usageMetadata.thoughtsTokenCount;
      const parts = chunk?.candidates?.[0]?.content?.parts ?? [];
      for (const p of parts) {
        if (!p || typeof p !== 'object') continue;
        Object.keys(p).forEach((k) => fields.add(k));
        if ('reasoning' in p) {
          r++; rB += (p.reasoning || '').length;
          if (firstReasoning === null) firstReasoning = (p.reasoning || '').substring(0, 60);
        } else if (typeof p.text === 'string') { t++; tB += p.text.length; }
      }
    }
  }
  const ms = Date.now() - start;
  console.log(`first byte: ${fb}ms  total: ${ms}ms  chunks: ${n}`);
  console.log(`reasoning: ${r}/${rB}B  text: ${t}/${tB}B  thoughtsTok: ${thoughtsTokens}`);
  console.log(`fields seen: [${[...fields].join(', ')}]`);
  if (firstReasoning) console.log(`first reasoning: ${JSON.stringify(firstReasoning)}…`);
  return { r, rB, t, tB, thoughtsTokens, fields: [...fields] };
}

console.log('===== thinkingConfig 字段位置差分实验 =====');
console.log(`Model: gemini-3.1-pro-preview, 31 tools, prompt = "${PROMPT}"`);

// A: CLI 现状
const A = await runOne(
  'A: CLI 现状 — config.generationConfig.thinkingConfig',
  { generationConfig: { thinkingConfig: { thinkingLevel: 'medium', includeThoughts: true } } },
);

// B: SDK 标准位置
const B = await runOne(
  'B: SDK 标准 — config.thinkingConfig (无 generationConfig 嵌套)',
  { thinkingConfig: { thinkingLevel: 'medium', includeThoughts: true } },
);

// C: 大写 + SDK 标准位置
const C = await runOne(
  'C: SDK 标准 + 大写 — config.thinkingConfig MEDIUM',
  { thinkingConfig: { thinkingLevel: 'MEDIUM', includeThoughts: true } },
);

console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━ VERDICT ━━━━━━━━━━━━━━━━━━━━━━━━━━');
const summary = (label, x) => `${label}: reasoning=${x?.r ?? 'ERR'}/${x?.rB ?? 0}B, thoughtsTok=${x?.thoughtsTokens ?? '?'}, fields=[${(x?.fields ?? []).join(',')}]`;
console.log(summary('A (CLI 现状)', A));
console.log(summary('B (SDK 标准位置)', B));
console.log(summary('C (大写 + SDK 标准)', C));

if (A?.r === 0 && (B?.r > 0 || C?.r > 0)) {
  console.log('\n🎯 BINGO! CLI 把 thinkingConfig 嵌套在 generationConfig 里，导致 thinkingConfig 没生效，上游不下发 reasoning。');
  console.log('   修复方案：移除 generationConfig 这层嵌套，直接 config.thinkingConfig = {...}');
} else if (A?.r > 0 && B?.r > 0) {
  console.log('\n📣 两种位置都能触发 reasoning，那 CLI 现状的问题应在别处。');
}
