/**
 * 第三层 probe：验证「Gemini + functionDeclarations 是否抑制 reasoning chunks」
 *
 * 同一 prompt（禁用工具的纯逻辑题），分两次跑：
 *   ① 裸请求：无 tools
 *   ② 带 31 个工具（模拟 CLI 的 chat scene）
 *
 * 对比两次抓到的 chunks 里 reasoning 字段的数量和长度。
 *
 * 用法：node scripts/probe-gemini-tools-vs-naked.mjs [model]
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const model = process.argv[2] || 'gemini-2.5-flash';
const isGemini3 = model.toLowerCase().includes('gemini-3');
const proxyUrl = process.env.DEEPX_SERVER_URL || 'https://api-code.deepvlab.ai';

// 读 jwt
function loadJwt() {
  const isDev = (process.env.DEEPX_SERVER_URL || '').includes('localhost');
  const fname = isDev ? 'jwt-token-dev.json' : 'jwt-token.json';
  const p = path.join(os.homedir(), '.deepv', fname);
  return JSON.parse(fs.readFileSync(p, 'utf8')).accessToken;
}
const token = loadJwt();

const PROMPT = `请仅依靠你自己的数学推理能力一步步思考下面这道题，期间禁止调用任何工具。请把完整思考过程展示出来，再给出最终答案。

题目：在所有不超过 1000 的正整数中，存在多少个 n，使得 n 的十进制各位数字之和恰好等于 13？`;

const generationConfig = isGemini3
  ? { thinkingConfig: { thinkingLevel: 'medium', includeThoughts: true } }
  : { thinkingConfig: { thinkingBudget: 2048, includeThoughts: true } };

// 模拟 CLI 的 31 个工具
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
    description: `Mock declaration of ${name} for probe testing`,
    parameters: { type: 'object', properties: {}, required: [] },
  })),
}];

async function runOne(label, withTools) {
  console.log(`\n━━━━━━━━━━━ ${label} ━━━━━━━━━━━`);
  const reqBody = {
    model,
    contents: [{ role: 'user', parts: [{ text: PROMPT }] }],
    config: {
      generationConfig,
      stream: true,
      ...(withTools ? { tools: fakeTools } : {}),
      httpOptions: { headers: { 'X-Scene-Type': 'CHAT_CONVERSATION' } },
    },
  };

  const resp = await fetch(`${proxyUrl}/v1/chat/stream`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'text/event-stream',
      Authorization: `Bearer ${token}`,
      'User-Agent': 'deepv-probe/1.0',
    },
    body: JSON.stringify(reqBody),
  });

  if (!resp.ok) {
    const t = await resp.text();
    console.error(`HTTP ${resp.status}: ${t.substring(0, 500)}`);
    return null;
  }

  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let reasoningCount = 0,
    textCount = 0,
    fnCount = 0;
  let reasoningBytes = 0,
    textBytes = 0;
  let firstByteAt = null;
  const start = Date.now();
  let chunkIdx = 0;
  const fieldKeys = new Set();
  const seenSig = new Set();

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
        continue;
      }
      chunkIdx++;
      const parts = chunk?.candidates?.[0]?.content?.parts ?? [];
      for (const p of parts) {
        if (!p || typeof p !== 'object') continue;
        Object.keys(p).forEach((k) => fieldKeys.add(k));
        if (typeof p.thoughtSignature === 'string') seenSig.add(p.thoughtSignature.length);
        if ('reasoning' in p) {
          reasoningCount++;
          reasoningBytes += (p.reasoning || '').length;
        } else if (typeof p.text === 'string') {
          textCount++;
          textBytes += p.text.length;
        } else if (p.functionCall) {
          fnCount++;
        }
      }
    }
  }
  const totalMs = Date.now() - start;
  console.log(`Tools sent: ${withTools ? '✅ 31 tools' : '❌ none'}`);
  console.log(`First byte:        ${firstByteAt} ms`);
  console.log(`Total stream time: ${totalMs} ms`);
  console.log(`Total chunks:      ${chunkIdx}`);
  console.log(`Reasoning chunks:  ${reasoningCount}  (${reasoningBytes} bytes total)`);
  console.log(`Text chunks:       ${textCount}  (${textBytes} bytes total)`);
  console.log(`FunctionCall:      ${fnCount}`);
  console.log(`All field keys:    [${[...fieldKeys].join(', ')}]`);
  console.log(`thoughtSignature seen: ${seenSig.size > 0 ? `${seenSig.size} unique blob(s)` : 'no'}`);
  return { reasoningCount, reasoningBytes, textCount, fnCount, fieldKeys: [...fieldKeys] };
}

console.log(`Model: ${model}  ${isGemini3 ? '(Gemini 3.x schema)' : '(Gemini 2.x schema)'}`);
console.log(`Config: ${JSON.stringify(generationConfig)}`);

const naked = await runOne('① NAKED (no tools)', false);
const withTools = await runOne('② WITH 31 TOOLS', true);

console.log('\n━━━━━━━━━━━━━━━━━━━━━━ DIFFERENTIAL ━━━━━━━━━━━━━━━━━━━━━━');
if (naked && withTools) {
  console.log(`Reasoning chunks:  naked=${naked.reasoningCount}  vs  withTools=${withTools.reasoningCount}`);
  console.log(`Reasoning bytes:   naked=${naked.reasoningBytes}  vs  withTools=${withTools.reasoningBytes}`);
  if (naked.reasoningCount > 0 && withTools.reasoningCount === 0) {
    console.log('\n🎯 CONFIRMED: 添加 functionDeclarations 后 Gemini 完全停止下发 reasoning chunks');
    console.log('   这是 Google 上游/网关行为差异，不是客户端 bug。');
  } else if (naked.reasoningCount > 0 && withTools.reasoningCount > 0) {
    console.log('\n📣 两种情况都有 reasoning。tools 数量不影响 reasoning 下发。');
  } else if (naked.reasoningCount === 0 && withTools.reasoningCount === 0) {
    console.log('\n📣 两种情况都没有 reasoning。可能 prompt 太简单或模型不支持。');
  }
}
