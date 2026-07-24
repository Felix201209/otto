#!/usr/bin/env node
/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 *
 * Synthetic multi-agent memory benchmark. It never calls model APIs.
 */

const PROFILES = {
  low4gb: {
    agents: 4,
    turnsPerAgent: 40,
    charsPerTurn: 900,
    retainedHistoryChars: 80_000,
    maxRssMb: 384,
    maxHeapMb: 128,
    maxElapsedMs: 2_500,
  },
  standard8gb: {
    agents: 8,
    turnsPerAgent: 60,
    charsPerTurn: 1_200,
    retainedHistoryChars: 160_000,
    maxRssMb: 640,
    maxHeapMb: 192,
    maxElapsedMs: 4_000,
  },
  high: {
    agents: 12,
    turnsPerAgent: 80,
    charsPerTurn: 1_600,
    retainedHistoryChars: 320_000,
    maxRssMb: 896,
    maxHeapMb: 256,
    maxElapsedMs: 6_500,
  },
};

const requested = process.argv.find((arg) => arg.startsWith('--profile='))?.split('=')[1];
const profiles = requested ? { [requested]: PROFILES[requested] } : PROFILES;
if (requested && !PROFILES[requested]) {
  console.error(`Unknown profile: ${requested}`);
  console.error(`Available profiles: ${Object.keys(PROFILES).join(', ')}`);
  process.exit(2);
}

function mb(bytes) {
  return bytes / 1048576;
}

function makePayload(profileName, agentIndex, turnIndex, chars) {
  const seed = `[${profileName}] agent=${agentIndex} turn=${turnIndex} `;
  return seed + 'x'.repeat(Math.max(0, chars - seed.length));
}

async function runProfile(name, profile) {
  const started = performance.now();
  const agents = Array.from({ length: profile.agents }, (_, index) => ({
    id: `agent-${index + 1}`,
    history: '',
    digests: [],
  }));
  let peakRss = 0;
  let peakHeap = 0;

  for (let turn = 0; turn < profile.turnsPerAgent; turn += 1) {
    await Promise.all(agents.map(async (agent, agentIndex) => {
      const payload = makePayload(name, agentIndex, turn, profile.charsPerTurn);
      agent.history += `\n${payload}`;
      if (agent.history.length > profile.retainedHistoryChars) {
        agent.digests.push(agent.history.slice(0, Math.floor(profile.retainedHistoryChars / 8)));
        agent.history = agent.history.slice(-profile.retainedHistoryChars);
      }
      await Promise.resolve();
    }));
    const usage = process.memoryUsage();
    peakRss = Math.max(peakRss, usage.rss);
    peakHeap = Math.max(peakHeap, usage.heapUsed);
  }

  const elapsedMs = performance.now() - started;
  const retainedHistoryChars = agents.reduce((sum, agent) => sum + agent.history.length, 0);
  const result = {
    profile: name,
    agentCount: profile.agents,
    elapsedMs: Math.round(elapsedMs),
    peakRssMb: Number(mb(peakRss).toFixed(1)),
    peakHeapMb: Number(mb(peakHeap).toFixed(1)),
    retainedHistoryChars,
    pass: mb(peakRss) <= profile.maxRssMb &&
      mb(peakHeap) <= profile.maxHeapMb &&
      elapsedMs <= profile.maxElapsedMs,
    budget: {
      maxRssMb: profile.maxRssMb,
      maxHeapMb: profile.maxHeapMb,
      maxElapsedMs: profile.maxElapsedMs,
    },
  };
  return result;
}

const results = [];
for (const [name, profile] of Object.entries(profiles)) {
  results.push(await runProfile(name, profile));
}

console.log('Otto low-resource multi-agent benchmark');
for (const result of results) {
  console.log(`${result.pass ? 'PASS' : 'FAIL'} ${result.profile}`);
  console.log(`  agents=${result.agentCount} elapsedMs=${result.elapsedMs} peakRssMb=${result.peakRssMb} peakHeapMb=${result.peakHeapMb} retainedHistoryChars=${result.retainedHistoryChars}`);
  console.log(`  budget rss<=${result.budget.maxRssMb}MB heap<=${result.budget.maxHeapMb}MB elapsed<=${result.budget.maxElapsedMs}ms`);
}

if (results.some((result) => !result.pass)) process.exit(1);
