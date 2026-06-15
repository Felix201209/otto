/**
 * 仅跑「带 31 工具」单次，超时放宽到 5 分钟
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const model = process.argv[2] || 'gemini-2.5-flash';
const isGemini3 = model.toLowerCase().includes('gemini-3');
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

const PROMPT = `请仅依靠你自己的数学推理能力一步步思考下面这道题，期间禁止调用任何工具。请把完整思考过程展示出来，再给出最终答案。

题目：在所有不超过 1000 的正整数中，存在多少个 n，使得 n 的十进制各位数字之和恰好等于 13？`;

const generationConfig = isGemini3
  ? { thinkingConfig: { thinkingLevel: 'medium', includeThoughts: true } }
  : { thinkingConfig: { thinkingBudget: 2048, includeThoughts: true } };

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

console.log(`Model: ${model}, with 31 tools`);
const start = Date.now();
const resp = await fetch(`${proxyUrl}/v1/chat/stream`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json', Accept: 'text/event-stream',
    Authorization: `Bearer ${token}`, 'User-Agent': 'deepv-probe/1.0',
  },
  body: JSON.stringify({
    model,
    contents: [{ role: 'user', parts: [{ text: PROMPT }] }],
    config: { generationConfig, stream: true, tools: fakeTools },
  }),
});

if (!resp.ok) {
  console.error(`HTTP ${resp.status}: ${(await resp.text()).substring(0, 500)}`);
  process.exit(1);
}

const reader = resp.body.getReader();
const decoder = new TextDecoder();
let buffer = '';
let reasoningCount = 0, reasoningBytes = 0, textCount = 0, textBytes = 0, fnCount = 0;
let firstByte = null, chunkIdx = 0;
const fieldKeys = new Set();
const sigLens = [];

while (true) {
  const { value, done } = await reader.read();
  if (done) break;
  if (firstByte === null) firstByte = Date.now() - start;
  buffer += decoder.decode(value, { stream: true });
  const lines = buffer.split('\n');
  buffer = lines.pop() || '';
  for (const line of lines) {
    if (!line.startsWith('data: ')) continue;
    const data = line.slice(6);
    if (data === '[DONE]') break;
    let chunk;
    try { chunk = JSON.parse(data); } catch { continue; }
    chunkIdx++;
    const parts = chunk?.candidates?.[0]?.content?.parts ?? [];
    for (const p of parts) {
      if (!p || typeof p !== 'object') continue;
      Object.keys(p).forEach((k) => fieldKeys.add(k));
      if (typeof p.thoughtSignature === 'string') sigLens.push(p.thoughtSignature.length);
      if ('reasoning' in p) {
        reasoningCount++;
        reasoningBytes += (p.reasoning || '').length;
        if (reasoningCount <= 3) console.log(`  reasoning #${reasoningCount}: ${JSON.stringify((p.reasoning || '').substring(0, 80))}…`);
      } else if (typeof p.text === 'string') {
        textCount++;
        textBytes += p.text.length;
      } else if (p.functionCall) {
        fnCount++;
        console.log(`  functionCall: ${p.functionCall.name}`);
      }
    }
  }
}

const ms = Date.now() - start;
console.log('\n=== RESULTS (with 31 tools) ===');
console.log(`First byte: ${firstByte} ms`);
console.log(`Total time: ${ms} ms`);
console.log(`Chunks: ${chunkIdx}`);
console.log(`Reasoning chunks: ${reasoningCount} (${reasoningBytes} bytes)`);
console.log(`Text chunks: ${textCount} (${textBytes} bytes)`);
console.log(`FunctionCall: ${fnCount}`);
console.log(`Field keys seen: [${[...fieldKeys].join(', ')}]`);
console.log(`thoughtSignature: ${sigLens.length} occurrence(s), lengths=${sigLens.join(',')}`);
