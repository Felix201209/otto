#!/usr/bin/env node
/**
 * Probe: gpt-5.5 thinking on EasyRouter
 * --------------------------------------
 * Same math reasoning prompt sent three ways. Prints whether each path emits
 * reasoning chunks (the chunks the CLI uses to render the "thinking" block):
 *
 *   1. /v1/responses  +  reasoning.effort='high'      (current client path)
 *   2. /v1/responses  +  reasoning.effort='medium'    (auto-default after fix)
 *   3. /v1/chat/completions + reasoning_effort='high' (alternative path)
 *
 * Run:  node scripts/probe-gpt55-thinking.mjs <EASY_ROUTER_API_KEY>
 */

const apiKey = process.argv[2];
if (!apiKey) {
  console.error('Usage: node scripts/probe-gpt55-thinking.mjs <EASY_ROUTER_API_KEY>');
  process.exit(2);
}

const BASE = 'https://llm-endpoint.net/v1';
const MODEL = 'gpt-5.5';
const PROMPT =
  '一个农夫有 17 只羊，除了 9 只之外都死了。还剩多少只？请逐步推理，先在脑中算清楚再给出答案。';

/**
 * Read an SSE stream, count which chunk types appear.
 * Returns { types: Map<string, count>, snippets: string[] }
 */
async function tallySSE(label, response) {
  if (!response.ok) {
    const txt = await response.text();
    return { error: `HTTP ${response.status}: ${txt.slice(0, 400)}`, label };
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const types = new Map();
  const snippets = [];
  let buf = '';
  let totalBytes = 0;
  let reasoningChars = 0;
  let textChars = 0;

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    const chunkStr = decoder.decode(value, { stream: true });
    totalBytes += chunkStr.length;
    buf += chunkStr;

    // Split SSE events on blank line.
    const events = buf.split(/\n\n/);
    buf = events.pop() || '';
    for (const ev of events) {
      // Each event has potentially `event:` and `data:` lines.
      let evType = null;
      let evData = '';
      for (const line of ev.split('\n')) {
        if (line.startsWith('event:')) evType = line.slice(6).trim();
        else if (line.startsWith('data:')) evData += line.slice(5).trim();
      }
      const key = evType || '(no-event-type)';
      types.set(key, (types.get(key) || 0) + 1);

      if (!evData || evData === '[DONE]') continue;
      try {
        const j = JSON.parse(evData);

        // Responses API: events of type response.reasoning_summary_text.delta /
        //                response.reasoning.delta etc.
        if (key.startsWith('response.reasoning')) {
          if (typeof j.delta === 'string') reasoningChars += j.delta.length;
          if (snippets.length < 3 && j.delta) snippets.push(`[reasoning] ${j.delta.slice(0, 80)}`);
        }
        // Responses API: text deltas
        if (key === 'response.output_text.delta' && typeof j.delta === 'string') {
          textChars += j.delta.length;
        }

        // Chat Completions: { choices: [{ delta: { reasoning_content, content } }] }
        if (j.choices?.[0]?.delta) {
          const d = j.choices[0].delta;
          if (typeof d.reasoning_content === 'string') {
            reasoningChars += d.reasoning_content.length;
            if (snippets.length < 3 && d.reasoning_content) {
              snippets.push(`[reasoning_content] ${d.reasoning_content.slice(0, 80)}`);
            }
          }
          if (typeof d.content === 'string') textChars += d.content.length;
        }
      } catch {
        // Non-JSON SSE data — ignore.
      }
    }
  }

  return {
    label,
    totalBytes,
    reasoningChars,
    textChars,
    eventTypes: Object.fromEntries(types),
    snippets,
  };
}

async function probeResponses(effort, summary) {
  const body = {
    model: MODEL,
    input: [{ role: 'user', content: PROMPT }],
    stream: true,
    store: false,
    reasoning: { effort, ...(summary ? { summary } : {}) },
  };
  const r = await fetch(`${BASE}/responses`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });
  return tallySSE(`/responses effort=${effort} summary=${summary || 'none'}`, r);
}

async function probeChat(effort) {
  const body = {
    model: MODEL,
    messages: [{ role: 'user', content: PROMPT }],
    stream: true,
    stream_options: { include_usage: true },
    reasoning_effort: effort,
  };
  const r = await fetch(`${BASE}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });
  return tallySSE(`/chat/completions effort=${effort}`, r);
}

const runs = await Promise.all([
  probeResponses('high', 'auto'),
  probeResponses('high', 'detailed'),
  probeResponses('medium', 'auto'),
  probeResponses('high'),
  probeChat('high'),
]);

for (const r of runs) {
  console.log('━'.repeat(70));
  console.log(`▶ ${r.label}`);
  if (r.error) {
    console.log(`  ✕ ${r.error}`);
    continue;
  }
  console.log(`  totalBytes      = ${r.totalBytes}`);
  console.log(`  reasoningChars  = ${r.reasoningChars}  ${r.reasoningChars > 0 ? '✅ HAS THINKING' : '❌ NO THINKING'}`);
  console.log(`  textChars       = ${r.textChars}`);
  console.log(`  eventTypes      = ${JSON.stringify(r.eventTypes)}`);
  if (r.snippets.length) {
    console.log(`  snippets:`);
    for (const s of r.snippets) console.log(`    ${s}`);
  }
}
console.log('━'.repeat(70));
