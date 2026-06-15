// End-to-end ACP probe against the GLOBAL `dvcode` install.
//
// Unlike scripts/test-acp-live.mjs which invokes
// `packages/cli/dist/index.js` directly from this repo, this script spawns
// whatever `dvcode --acp` resolves to on PATH — i.e. the exact binary the
// user (and OpenClaw) will actually call.
//
// What it verifies:
//   1. initialize / authenticate / session/new happy path
//   2. server-authoritative model catalogue is visible (surfaces the count
//      so you can see whether `/web-api/models` was preloaded)
//   3. session/set_config_option(model=X) actually changes who answers
//      "what model are you?" on the SAME session
//   4. multi-turn prompts stay alive on the same sessionId
//
// Usage:
//   node scripts/test-acp-live-global.mjs [targetModelId]
//
// Default target model is "claude-sonnet-4-6". Known-good ids, verified
// against the current proxy catalogue:
//   auto, claude-opus-4-7, claude-sonnet-4-6, deepseek-v4-pro,
//   deepseek-v4-flash, gpt-5
//
// Notes:
//   - We do NOT read the local repo's settings. The global dvcode reads its
//     own `~/.deepvcode/settings.json`, which is what matters for the real
//     user scenario.
//   - All stderr from dvcode is surfaced with an [ERR] prefix so you can
//     see `[acp] loaded N models`, `[switchModel] ...`, compression logs,
//     and any other diagnostic output.

import { spawn } from 'node:child_process';
import { platform } from 'node:process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// ────────────────────────────────────────────────────────────────────────────
// Config
// ────────────────────────────────────────────────────────────────────────────

const TEST_MODEL = process.argv[2] ?? 'claude-sonnet-4-6';

// On Windows `dvcode` is a .cmd launcher; spawn() needs `shell: true` to
// resolve it via PATHEXT. On POSIX the launcher is an executable script.
const isWin = platform === 'win32';
const DVCODE_CMD = 'dvcode';

// ────────────────────────────────────────────────────────────────────────────
// Boot the global dvcode in ACP mode
// ────────────────────────────────────────────────────────────────────────────

const child = spawn(DVCODE_CMD, ['--acp'], {
  stdio: ['pipe', 'pipe', 'pipe'],
  shell: isWin,
});

// Surface every stderr line — that's where all the interesting
// switchModel/compression/[acp] logs live now that ACP mode redirects
// console.* to stderr.
child.stderr.on('data', (chunk) => {
  const s = chunk.toString('utf8');
  for (const line of s.split(/\r?\n/)) {
    if (line.trim()) process.stderr.write('[ERR] ' + line + '\n');
  }
});

child.on('error', (err) => {
  console.error('\n❌ Failed to spawn `dvcode`:', err.message);
  console.error(
    '   Make sure `dvcode` is installed globally and on PATH. ' +
      'On Windows, try `where dvcode`.',
  );
  process.exit(1);
});

child.on('exit', (code, sig) => {
  console.log(`\n[child-exit] code=${code} signal=${sig}`);
});

// ────────────────────────────────────────────────────────────────────────────
// ACP stdio framing
// ────────────────────────────────────────────────────────────────────────────

let buf = '';
let sid = null;
let currentTurn = null; // 'before' | 'after' | 'second' while streaming a reply
const answers = { before: '', after: '', second: '' };

function send(m) {
  const p = JSON.stringify(m.params ?? {});
  console.log('[->]', m.method, p.length > 120 ? p.slice(0, 117) + '...' : p);
  child.stdin.write(JSON.stringify(m) + '\n');
}

function fail(msg) {
  console.error('\n❌ FAIL:', msg);
  child.kill();
  process.exit(1);
}

function ask(id, text) {
  return {
    jsonrpc: '2.0',
    id,
    method: 'session/prompt',
    params: {
      sessionId: sid,
      prompt: [{ type: 'text', text }],
    },
  };
}

const IDENTITY_PROMPT =
  'IMPORTANT: answer in ONE short sentence, no tool calls. ' +
  'What model are you? Include your name and provider.';

child.stdout.on('data', (chunk) => {
  buf += chunk.toString('utf8');
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;

    let m;
    try {
      m = JSON.parse(line);
    } catch {
      // Anything non-JSON on stdout in ACP mode = corrupted framing. Shout.
      console.log('[stdout-noise]', line.slice(0, 160));
      continue;
    }

    // session/update notifications carry the streamed assistant text
    if (m.method === 'session/update') {
      const u = m.params?.update;
      if (u?.sessionUpdate === 'agent_message_chunk' && currentTurn) {
        answers[currentTurn] += u.content?.text ?? '';
      }
      continue;
    }

    // RPC responses
    if (m.id === 1) {
      console.log('[initialize] OK. agent =', m.result?.agentInfo?.name, m.result?.agentInfo?.version);
      send({
        jsonrpc: '2.0',
        id: 2,
        method: 'authenticate',
        params: { methodId: 'proxy-auth' },
      });
    } else if (m.id === 2) {
      if (m.error) fail('authenticate failed: ' + JSON.stringify(m.error));
      console.log('[authenticate] OK');
      send({
        jsonrpc: '2.0',
        id: 3,
        method: 'session/new',
        params: { cwd: process.cwd(), mcpServers: [] },
      });
    } else if (m.id === 3) {
      if (m.error) fail('session/new failed: ' + JSON.stringify(m.error));
      sid = m.result?.sessionId;
      const initModel = m.result?.models?.currentModelId;
      const modelCount = (m.result?.models?.availableModels ?? []).length;
      const configOptions = m.result?.configOptions ?? [];
      const modelCfg = configOptions.find((o) => o.id === 'model');
      const cfgOptCount = modelCfg?.options?.length ?? 0;

      console.log('─────────────────────────────────────');
      console.log('[session/new] sid =', sid);
      console.log('  currentModelId  =', initModel);
      console.log('  availableModels =', modelCount, 'entries');
      console.log('  configOptions[model].options =', cfgOptCount, 'entries');
      console.log('─────────────────────────────────────');

      currentTurn = 'before';
      console.log('[>>] ask #1 (before switch)');
      send(ask(4, IDENTITY_PROMPT));
    } else if (m.id === 4) {
      currentTurn = null;
      console.log('\n[ANSWER before switch]');
      console.log('>>>', answers.before.trim().slice(0, 300));
      console.log('');
      console.log('─────────────────────────────────────');
      console.log(`[>>] set_config_option model=${TEST_MODEL}`);
      send({
        jsonrpc: '2.0',
        id: 5,
        method: 'session/set_config_option',
        params: { sessionId: sid, configId: 'model', value: TEST_MODEL },
      });
    } else if (m.id === 5) {
      if (m.error) {
        console.error(
          '\n❌ set_config_option returned RPC error:',
          JSON.stringify(m.error),
        );
        console.error(
          '   This usually means the server does not support that model id.',
        );
        child.kill();
        process.exit(4);
      }
      const opt = (m.result?.configOptions ?? []).find((o) => o.id === 'model');
      console.log('[set_config_option] OK. currentValue =', opt?.currentValue);
      console.log('─────────────────────────────────────');
      currentTurn = 'after';
      console.log('[>>] ask #2 (after switch, same session)');
      send(ask(6, IDENTITY_PROMPT));
    } else if (m.id === 6) {
      currentTurn = null;
      console.log('\n[ANSWER after switch]');
      console.log('>>>', answers.after.trim().slice(0, 300));
      console.log('');
      console.log('─────────────────────────────────────');
      console.log('[>>] ask #3 (multi-turn check — still same session?)');
      currentTurn = 'second';
      send(
        ask(
          7,
          'Answer in one short sentence: is this still the same conversation as before?',
        ),
      );
    } else if (m.id === 7) {
      if (m.error) {
        console.error(
          '\n❌ Third prompt failed — session appears to be single-turn:',
          JSON.stringify(m.error),
        );
        child.kill();
        process.exit(5);
      }
      currentTurn = null;
      console.log('\n[ANSWER multi-turn]');
      console.log('>>>', answers.second.trim().slice(0, 300));

      // ─── Heuristic verdict ────────────────────────────────────────────
      const before = answers.before.toLowerCase();
      const after = answers.after.toLowerCase();
      const identical = before === after;

      console.log('\n─────────────────────────────────────');
      console.log('[verdict]');
      console.log(
        '  answers differ after switch:',
        identical ? '✗ IDENTICAL — model switch did NOT take effect' : '✓',
      );
      console.log('  multi-turn on same session: ✓ (three prompts succeeded)');
      console.log('─────────────────────────────────────');

      child.kill();
      process.exit(identical ? 3 : 0);
    }
  }
});

// ────────────────────────────────────────────────────────────────────────────
// Kick off
// ────────────────────────────────────────────────────────────────────────────

console.log(`[config] target model for switch = ${TEST_MODEL}`);
console.log(`[config] binary = \`${DVCODE_CMD}\` (from PATH)\n`);

send({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: 1,
    clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } },
  },
});

setTimeout(() => fail('timeout 120s'), 120_000);
