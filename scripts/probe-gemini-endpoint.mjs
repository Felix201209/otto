#!/usr/bin/env node
/**
 * Probe: does EasyRouter expose Google's native GenAI endpoint
 * (`/v1beta/models/{id}:streamGenerateContent`) for Gemini models,
 * or only the OpenAI-compat shim?
 *
 * Also checks the OpenAI-compat path's thinking field plumbing
 * (Gemini via OpenAI shim doesn't usually expose `thinkingConfig`).
 *
 * Run:  node scripts/probe-gemini-endpoint.mjs <KEY>
 */
const apiKey = process.argv[2];
if (!apiKey) {
  console.error('Usage: node scripts/probe-gemini-endpoint.mjs <KEY>');
  process.exit(2);
}

const BASE = 'https://llm-endpoint.net';
const PROMPT = '简短回答：1+1等于几？';

// First: list available models so we know what gemini ids exist on this gateway.
async function listModels() {
  const r = await fetch(`${BASE}/v1/models`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!r.ok) {
    console.error(`/v1/models HTTP ${r.status}`);
    return [];
  }
  const j = await r.json();
  const ids = (j.data || []).map(m => m.id).filter(id => id.toLowerCase().includes('gemini'));
  return ids;
}

async function probeGenAINative(modelId) {
  const url = `${BASE}/v1beta/models/${modelId}:streamGenerateContent?key=${apiKey}`;
  const body = {
    contents: [{ role: 'user', parts: [{ text: PROMPT }] }],
    generationConfig: { thinkingConfig: { thinkingBudget: -1, includeThoughts: true } },
  };
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return {
      label: `GenAI native /v1beta/models/${modelId}:streamGenerateContent`,
      status: r.status,
      ok: r.ok,
      body: r.ok ? '(stream skipped, succeeded)' : (await r.text()).slice(0, 400),
    };
  } catch (e) {
    return { label: `native ${modelId}`, error: e.message };
  }
}

async function probeAlternateGenAIPath(modelId) {
  // Some gateways mount native API under /v1/models/{id}:generateContent
  const url = `${BASE}/v1/models/${modelId}:streamGenerateContent`;
  const body = {
    contents: [{ role: 'user', parts: [{ text: PROMPT }] }],
    generationConfig: { thinkingConfig: { thinkingBudget: -1, includeThoughts: true } },
  };
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
    });
    return {
      label: `alt /v1/models/${modelId}:streamGenerateContent (Bearer)`,
      status: r.status,
      ok: r.ok,
      body: r.ok ? '(stream skipped, succeeded)' : (await r.text()).slice(0, 400),
    };
  } catch (e) {
    return { label: `alt ${modelId}`, error: e.message };
  }
}

async function probeOpenAIShim(modelId) {
  // The current path: /v1/chat/completions, no thinking field (Gemini via shim).
  const url = `${BASE}/v1/chat/completions`;
  const body = {
    model: modelId,
    messages: [{ role: 'user', content: PROMPT }],
    stream: false,
  };
  const r = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    return {
      label: `OpenAI shim /v1/chat/completions ${modelId}`,
      status: r.status,
      body: (await r.text()).slice(0, 400),
    };
  }
  const j = await r.json();
  const msg = j.choices?.[0]?.message || {};
  return {
    label: `OpenAI shim /v1/chat/completions ${modelId}`,
    status: 200,
    hasContent: !!msg.content,
    hasReasoning: !!msg.reasoning_content,
    contentLen: msg.content?.length || 0,
  };
}

const geminiIds = await listModels();
console.log('Available Gemini ids on EasyRouter:', geminiIds);
if (!geminiIds.length) process.exit(0);

const sample = geminiIds.find(i => i.toLowerCase().includes('pro')) || geminiIds[0];
console.log(`\nProbing with sample id: ${sample}\n`);

const results = await Promise.all([
  probeGenAINative(sample),
  probeAlternateGenAIPath(sample),
  probeOpenAIShim(sample),
]);
for (const r of results) {
  console.log('━'.repeat(70));
  console.log('▶', r.label);
  console.log(JSON.stringify(r, null, 2));
}
