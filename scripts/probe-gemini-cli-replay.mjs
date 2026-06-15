/**
 * 终极差分：尽量贴近 CLI 的真实请求来复现「Gemini 不出 reasoning」
 *
 * 根据 17:23 用户日志：
 *   - model: gemini-3.1-pro-preview
 *   - history: 3 messages（user 6632 + model 31 + user 143）
 *   - tools: 31
 *   - first byte: 31 秒后才到
 *   - 全程 partsKeys=[["text"]] 没有 reasoning
 *
 * 我们重现一次：构造同等长度的 history + 31 工具 + 同样 prompt，看能否复现。
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

// 构造 ~6632 字节的"系统提示"放进第一个 user message（粗略模拟 CLI 那条 6632 user）
const fakeSystemEcho = '# Environment\nYou are an expert coding assistant.\n'
  + 'You have these tools available: list_directory, read_file, search_file_content, glob, replace, write_file, delete_file, web_fetch, read_many_files, run_shell_command, save_memory, google_web_search, todo_write, read_lints, lint_fix, use_skill, list_available_skills, get_skill_details, ppt_outline, ppt_generate, codesearch, lsp, multiedit, patch, batch, ask_user_question, local_time, goal_achieved, task, resolve-library-id, query-docs.\n'
  + 'Project structure:\n'
  + Array.from({ length: 80 }, (_, i) => `  - file_${i}.ts (some description here for padding to reach ~6600 bytes total)`).join('\n')
  + '\n\nPlease be concise and use tools when appropriate.';
console.log(`fakeSystemEcho length: ${fakeSystemEcho.length}`);

const PROMPT = `请仅依靠你自己的数学推理能力一步步思考下面这道题，期间禁止调用任何工具（不要 run_shell_command，不要写代码计算，不要 web 搜索）。请把完整思考过程展示出来，再给出最终答案。

题目：在所有不超过 1000 的正整数中，存在多少个 n，使得 n 的十进制各位数字之和恰好等于 13？`;

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
    description: `Mock declaration of ${name} for probe testing. This is a tool that performs the operation associated with its name. Use it when needed.`,
    parameters: { type: 'object', properties: {}, required: [] },
  })),
}];

const reqBody = {
  model: 'gemini-3.1-pro-preview',
  contents: [
    { role: 'user', parts: [{ text: fakeSystemEcho }] },
    { role: 'model', parts: [{ text: '好的，我了解了。请告诉我您的需求。' }] },
    { role: 'user', parts: [{ text: PROMPT }] },
  ],
  config: {
    generationConfig: {
      thinkingConfig: { thinkingLevel: 'medium', includeThoughts: true },
    },
    stream: true,
    tools: fakeTools,
  },
};

console.log(`Total request body length: ${JSON.stringify(reqBody).length}`);
console.log('Sending...\n');
const start = Date.now();

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
  console.error(`HTTP ${resp.status}: ${(await resp.text()).substring(0, 500)}`);
  process.exit(1);
}

const reader = resp.body.getReader();
const decoder = new TextDecoder();
let buffer = '';
let reasoningCount = 0, reasoningBytes = 0, textCount = 0, textBytes = 0;
let firstByte = null, chunkIdx = 0;
const fieldKeys = new Set();
const sigLens = [];
const firstTextSnippet = [];
const firstReasoningSnippet = [];

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
        if (firstReasoningSnippet.length < 2) firstReasoningSnippet.push((p.reasoning || '').substring(0, 80));
      } else if (typeof p.text === 'string') {
        textCount++;
        textBytes += p.text.length;
        if (firstTextSnippet.length < 2) firstTextSnippet.push(p.text.substring(0, 80));
      }
    }
  }
}

const ms = Date.now() - start;
console.log('=== RESULTS ===');
console.log(`First byte: ${firstByte} ms`);
console.log(`Total time: ${ms} ms`);
console.log(`Chunks: ${chunkIdx}`);
console.log(`Reasoning chunks: ${reasoningCount} (${reasoningBytes} bytes)`);
if (firstReasoningSnippet.length) console.log(`  First reasoning: ${JSON.stringify(firstReasoningSnippet[0])}…`);
console.log(`Text chunks: ${textCount} (${textBytes} bytes)`);
if (firstTextSnippet.length) console.log(`  First text: ${JSON.stringify(firstTextSnippet[0])}…`);
console.log(`Field keys: [${[...fieldKeys].join(', ')}]`);
console.log(`thoughtSignature: ${sigLens.length} occurrence(s)`);
