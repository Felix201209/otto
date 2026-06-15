#!/usr/bin/env node
/**
 * Replay the most recent Gemini native request dump against EasyRouter
 * to see exactly which part fails (or succeeds).
 *
 * Reads `~/.deepv/last-requests/*_gemini-*.json` — picks the newest by
 * filename (timestamp prefix sorts lexicographically). The model id is
 * taken from the dump's `modelId` field (added so we don't have to guess).
 *
 * Run: node scripts/replay-gemini-dump.mjs <KEY> [path/to/specific-dump.json]
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

const apiKey = process.argv[2];
if (!apiKey) {
  console.error('Usage: node scripts/replay-gemini-dump.mjs <KEY> [dumpFile]');
  process.exit(2);
}

let dumpPath = process.argv[3];
if (!dumpPath) {
  const dir = path.join(os.homedir(), '.deepv', 'last-requests');
  if (!fs.existsSync(dir)) {
    console.error(`No dump directory at ${dir} — make a real Gemini call first.`);
    process.exit(1);
  }
  const candidates = fs
    .readdirSync(dir)
    .filter((f) => /_gemini-(stream|unary)_.+\.json$/.test(f))
    .sort()
    .reverse();
  if (!candidates.length) {
    console.error(`No Gemini dumps in ${dir}.`);
    process.exit(1);
  }
  dumpPath = path.join(dir, candidates[0]);
}

const dump = JSON.parse(fs.readFileSync(dumpPath, 'utf8'));
const body = dump.body;
const modelId = dump.modelId || 'gemini-3.5-flash';
const url = `https://llm-endpoint.net/v1beta/models/${modelId}:streamGenerateContent?alt=sse&key=${apiKey}`;

console.log(`▶ Replaying: ${path.basename(dumpPath)}`);
console.log(`▶ kind=${dump.kind}  ts=${dump.ts}  modelId=${modelId}`);
console.log(`▶ contents.length=${body.contents.length}, tools=${body.tools?.length ?? 0}`);

const r = await fetch(url, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});
console.log(`◀ HTTP ${r.status}`);
if (!r.ok) {
  const text = await r.text();
  console.log(text.slice(0, 2000));
} else {
  console.log('OK — first 500 bytes of stream:');
  const reader = r.body.getReader();
  const decoder = new TextDecoder();
  let total = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    total += decoder.decode(value, { stream: true });
    if (total.length > 500) break;
  }
  console.log(total.slice(0, 500));
}
