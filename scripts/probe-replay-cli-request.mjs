/**
 * 字节级对账：拿 CLI 真实出站请求 body 重新发，看现象是否复现。
 *
 * 通用诊断流程（任意模型 / 任意"X 现象不对"问题）：
 *   1. 让用户在 CLI 里复现一次失败请求
 *      → 出站请求体会自动落盘到：
 *        - ~/.deepv/last-stream-request.json （流式路径，兼容旧脚本）
 *        - ~/.deepv/last-requests/<timestamp>_<kind>.json （滚动保留最近 5 次）
 *   2. 跑这个脚本 → 直接照搬真实 body 重发，对比客户端 vs probe 行为差异
 *
 * 用法：
 *   node scripts/probe-replay-cli-request.mjs                # 默认读 last-stream-request.json
 *   node scripts/probe-replay-cli-request.mjs <path-to.json> # 读指定 ring 文件
 *
 * 实验设计（针对 Gemini reasoning 问题，可按需扩展）：
 *   ① 完全照抄重发 → 看是否复现失败
 *   ② 修一项：把 thinkingConfig 从 generationConfig 移到 config 顶层
 *   ③ 修一项：thinkingLevel 大写
 *   ④ 修一项：去掉所有 tools
 *   ⑤ 修一项：history 只保留最后一条 user
 *
 * 这套思路也适用于其他诊断：拿真实 body，每次只改一项，看哪个变量是决定因素。
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

const dumpPath = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.join(os.homedir(), '.deepv', 'last-stream-request.json');
if (!fs.existsSync(dumpPath)) {
  console.error(`❌ ${dumpPath} 不存在`);
  console.error('   请先在 CLI 里跑一次失败请求让它落盘，或传入 ~/.deepv/last-requests/ 下的具体文件路径');
  process.exit(1);
}
const baseBody = JSON.parse(fs.readFileSync(dumpPath, 'utf8'));
console.log(`=== loaded baseline from ${dumpPath} ===`);
console.log(`model: ${baseBody.model}`);
console.log(`contents count: ${baseBody.contents?.length}`);
console.log(`contents lengths: ${baseBody.contents?.map((c) => c.parts?.[0]?.text?.length ?? '(non-text)').join(', ')}`);
console.log(`config keys: ${Object.keys(baseBody.config || {}).join(', ')}`);
console.log(`generationConfig: ${JSON.stringify(baseBody.config?.generationConfig)}`);
console.log(`tools count: ${baseBody.config?.tools?.[0]?.functionDeclarations?.length ?? 0}`);
console.log(`baseline body size: ${JSON.stringify(baseBody).length} bytes\n`);

async function send(label, body, timeoutMs = 180000) {
  console.log(`\n━━━━━━━━━━━━ ${label} ━━━━━━━━━━━━`);
  const start = Date.now();
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const resp = await fetch(`${proxyUrl}/v1/chat/stream`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
        Authorization: `Bearer ${token}`,
        'User-Agent': 'deepv-probe/1.0',
      },
      body: JSON.stringify(body),
      signal: ac.signal,
    });
    if (!resp.ok) {
      console.error(`HTTP ${resp.status}: ${(await resp.text()).substring(0, 300)}`);
      return null;
    }
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let r = 0, rB = 0, tx = 0, txB = 0, n = 0, fb = null, thoughtsTok = null;
    const fields = new Set();
    let firstReason = null;
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
        let chunk;
        try { chunk = JSON.parse(data); } catch { continue; }
        n++;
        if (chunk?.usageMetadata?.thoughtsTokenCount !== undefined) thoughtsTok = chunk.usageMetadata.thoughtsTokenCount;
        const parts = chunk?.candidates?.[0]?.content?.parts ?? [];
        for (const p of parts) {
          if (!p || typeof p !== 'object') continue;
          Object.keys(p).forEach((k) => fields.add(k));
          if ('reasoning' in p) {
            r++; rB += (p.reasoning || '').length;
            if (firstReason === null) firstReason = (p.reasoning || '').substring(0, 60);
          } else if (typeof p.text === 'string') { tx++; txB += p.text.length; }
        }
      }
    }
    const ms = Date.now() - start;
    const result = `reasoning=${r}/${rB}B  text=${tx}/${txB}B  thoughtsTok=${thoughtsTok}  fields=[${[...fields].join(',')}]  fb=${fb}ms total=${ms}ms`;
    console.log(result);
    if (firstReason) console.log(`first reasoning: ${JSON.stringify(firstReason)}…`);
    return { r, rB, tx, txB, thoughtsTok, fields: [...fields], fb, ms };
  } finally {
    clearTimeout(t);
  }
}

const results = {};

// ① 完全照抄
results['① replay 完全照抄'] = await send('① REPLAY (照抄 CLI 真实 body)', baseBody);

// ② thinkingConfig 移到 config 顶层
const body2 = JSON.parse(JSON.stringify(baseBody));
const tc = body2.config?.generationConfig?.thinkingConfig;
if (tc) {
  delete body2.config.generationConfig.thinkingConfig;
  if (Object.keys(body2.config.generationConfig).length === 0) delete body2.config.generationConfig;
  body2.config.thinkingConfig = tc;
  results['② 移到 config.thinkingConfig'] = await send(
    '② thinkingConfig 移到 config 顶层（不嵌套 generationConfig）',
    body2,
  );
}

// ③ 大写 thinkingLevel
const body3 = JSON.parse(JSON.stringify(baseBody));
const tc3 = body3.config?.generationConfig?.thinkingConfig;
if (tc3?.thinkingLevel) {
  tc3.thinkingLevel = String(tc3.thinkingLevel).toUpperCase();
  results['③ thinkingLevel 大写'] = await send('③ thinkingLevel 大写（位置不变）', body3);
}

// ④ 去掉 tools
const body4 = JSON.parse(JSON.stringify(baseBody));
if (body4.config?.tools) {
  delete body4.config.tools;
  results['④ 无 tools'] = await send('④ 去掉所有 tools', body4);
}

// ⑤ 只保留最后一条 user
const body5 = JSON.parse(JSON.stringify(baseBody));
const lastUser = body5.contents.findLast?.((c) => c.role === 'user') ?? body5.contents[body5.contents.length - 1];
body5.contents = [lastUser];
results['⑤ 只留最后一条 user'] = await send('⑤ 只留最后一条 user message', body5);

console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━ SUMMARY ━━━━━━━━━━━━━━━━━━━━━━━━━━');
for (const [k, v] of Object.entries(results)) {
  if (!v) continue;
  console.log(
    `${k.padEnd(32)} | r=${String(v.r).padStart(2)}/${String(v.rB).padStart(4)}B  text=${String(v.tx).padStart(3)}/${String(v.txB).padStart(4)}B  thoughtsTok=${v.thoughtsTok ?? '?'}`,
  );
}
