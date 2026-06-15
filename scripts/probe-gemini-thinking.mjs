#!/usr/bin/env node
/**
 * Verify GenAI native streaming on EasyRouter actually returns thinking parts
 * for gemini-2.5-pro (with thinkingConfig).
 *
 * Run:  node scripts/probe-gemini-thinking.mjs <KEY>
 */
const apiKey = process.argv[2];
if (!apiKey) {
  console.error('Usage: node scripts/probe-gemini-thinking.mjs <KEY>');
  process.exit(2);
}

const PROMPT =
  '一个农夫有 17 只羊，除了 9 只之外都死了。还剩多少只？请逐步推理。';

async function probe(modelId, thinkingBudget) {
  const body = {
    contents: [{ role: 'user', parts: [{ text: PROMPT }] }],
    generationConfig: {
      thinkingConfig: { thinkingBudget, includeThoughts: true },
    },
  };
  const url = `https://llm-endpoint.net/v1beta/models/${modelId}:streamGenerateContent?key=${apiKey}&alt=sse`;
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    console.error(`HTTP ${r.status}:`, await r.text());
    return;
  }

  const reader = r.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let thoughtChars = 0;
  let textChars = 0;
  const thoughtSnips = [];

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop() || '';
    for (const line of lines) {
      const t = line.trim();
      if (!t.startsWith('data:')) continue;
      const d = t.slice(5).trim();
      if (!d || d === '[DONE]') continue;
      try {
        const j = JSON.parse(d);
        const parts = j.candidates?.[0]?.content?.parts || [];
        for (const p of parts) {
          if (p.thought === true && typeof p.text === 'string') {
            thoughtChars += p.text.length;
            if (thoughtSnips.length < 3) thoughtSnips.push(p.text.slice(0, 80));
          } else if (typeof p.text === 'string') {
            textChars += p.text.length;
          }
        }
      } catch {}
    }
  }

  console.log('━'.repeat(70));
  console.log(`${modelId}  budget=${thinkingBudget}`);
  console.log(`thoughtChars : ${thoughtChars}  ${thoughtChars > 0 ? '✅ THINKING' : '❌ NO THINKING'}`);
  console.log(`textChars    : ${textChars}`);
  for (const s of thoughtSnips) console.log(`  • ${s}`);
}

await probe('gemini-2.5-pro', -1);  // dynamic thinking
await probe('gemini-3.5-flash', -1);
