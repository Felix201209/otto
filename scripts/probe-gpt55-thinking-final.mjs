#!/usr/bin/env node
/**
 * Final verification: After the customModelAdapter fix, gpt-5.5 should
 * actually emit reasoning chunks via /v1/responses + summary='detailed'.
 *
 * This emulates the EXACT request body customModelAdapter now sends.
 *
 * Run:  node scripts/probe-gpt55-thinking-final.mjs <KEY>
 */
const apiKey = process.argv[2];
if (!apiKey) {
  console.error('Usage: node scripts/probe-gpt55-thinking-final.mjs <KEY>');
  process.exit(2);
}

const PROMPT =
  '一个农夫有 17 只羊，除了 9 只之外都死了。还剩多少只？请逐步推理。';

async function probe() {
  // Mirrors callOpenAIResponsesModelStream exactly:
  const body = {
    model: 'gpt-5.5',
    input: [{ role: 'user', content: PROMPT }],
    stream: true,
    store: false,
    reasoning: { effort: 'medium', summary: 'detailed' },
  };
  const r = await fetch('https://llm-endpoint.net/v1/responses', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    console.error(`HTTP ${r.status}:`, await r.text());
    process.exit(1);
  }

  const reader = r.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let reasoningChars = 0;
  let textChars = 0;
  const reasoningSnippets = [];

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop() || '';
    for (const line of lines) {
      const t = line.trim();
      if (!t.startsWith('data: ')) continue;
      const d = t.slice(6);
      if (d === '[DONE]') continue;
      try {
        const e = JSON.parse(d);
        if (e.type === 'response.reasoning_summary_text.delta' && e.delta) {
          reasoningChars += e.delta.length;
          if (reasoningSnippets.length < 5) reasoningSnippets.push(e.delta.slice(0, 60));
        }
        if (e.type === 'response.output_text.delta' && e.delta) {
          textChars += e.delta.length;
        }
      } catch {}
    }
  }

  console.log('━'.repeat(70));
  console.log('FINAL VERIFICATION — gpt-5.5 via /v1/responses + summary=detailed');
  console.log('━'.repeat(70));
  console.log(`reasoningChars : ${reasoningChars}  ${reasoningChars > 0 ? '✅ THINKING WORKS' : '❌ STILL BROKEN'}`);
  console.log(`textChars      : ${textChars}`);
  if (reasoningSnippets.length) {
    console.log('reasoning snippets:');
    for (const s of reasoningSnippets) console.log(`  • ${s}`);
  }
  console.log('━'.repeat(70));
}

await probe();
