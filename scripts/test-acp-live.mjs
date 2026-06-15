// ACP live-mode probe — verifies dvcode --acp in-process:
//   1. model switch via session/set_config_option actually changes which
//      model answers (not just the cached value in responses)
//   2. ACP session survives multiple prompts on the same sessionId
//      (refutes the "single-turn session" claim)
//
// This is a *pure* ACP probe that talks JSON-RPC directly to
// `dvcode --acp` over stdio, with NO wrapping by OpenClaw / acpx /
// any client-side session manager. It exists to isolate dvcode bugs
// from bugs in the calling client.
//
// Requires:
//   - Node.js 22+
//   - network access to the DeepV proxy (https://api-code.deepvlab.ai)
//   - Proxy auth already signed in (otherwise authenticate will 401)
//
// Run from the repo root:
//   node test-acp-live.mjs
//
// To test a different model id, edit TEST_MODEL below. Known-good ids:
//   auto, claude-opus-4-7, claude-sonnet-4-6, deepseek-v4-pro,
//   deepseek-v4-flash, gpt-5

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// ────────────────────────────────────────────────────────────────────────────
// Config
// ────────────────────────────────────────────────────────────────────────────

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const cliEntry = path.resolve(repoRoot, 'packages/cli/dist/index.js');

// Model we'll switch TO. Override via first CLI arg if supplied.
const TEST_MODEL = process.argv[2] ?? 'deepseek-v4-pro';

// ────────────────────────────────────────────────────────────────────────────
// Boot dvcode in ACP mode
// ────────────────────────────────────────────────────────────────────────────

const child = spawn(process.execPath, [cliEntry, '--acp'], {
  stdio: ['pipe', 'pipe', 'pipe'],
});

child.stderr.on('data', (chunk) => {
  const s = chunk.toString('utf8');
  if (/\[switchModel\]|\[CompressionService\]|error|ERROR|Error/i.test(s)) {
    process.stderr.write('[dvcode] ' + s);
  }
});

child.on('exit', (code, sig) => {
  console.log(`\n[child-exit] code=${code} signal=${sig}`);
});

// ────────────────────────────────────────────────────────────────────────────
// ACP stdio framing
// ────────────────────────────────────────────────────────────────────────────

let buf = '';
let sid = null;
let currentTurn = null; // 'before' | 'after' | 'second' when streaming a reply
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
      // Anything non-JSON on stdout in ACP mode is a bug — surface it.
      console.log('[stdout-noise]', line.slice(0, 140));
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
      send({
        jsonrpc: '2.0',
        id: 2,
        method: 'authenticate',
        params: { methodId: 'proxy-auth' },
      });
    } else if (m.id === 2) {
      send({
        jsonrpc: '2.0',
        id: 3,
        method: 'session/new',
        params: { cwd: repoRoot, mcpServers: [] },
      });
    } else if (m.id === 3) {
      sid = m.result?.sessionId;
      const initModel = m.result?.models?.currentModelId;
      console.log('─────────────────────────────────────');
      console.log('[session/new] sid =', sid, 'initial model =', initModel);
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
        fail('set_config_option error: ' + JSON.stringify(m.error));
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
      console.log('[>>] ask #3 (second prompt on same session — multi-turn check)');
      currentTurn = 'second';
      send(
        ask(
          7,
          'Answer in one short sentence: is this still the same conversation?',
        ),
      );
    } else if (m.id === 7) {
      if (m.error) {
        console.error(
          '\n❌ Second prompt after switch failed with RPC error:',
          JSON.stringify(m.error),
        );
        console.error('   This would confirm a "single-turn" session bug.');
        child.kill();
        process.exit(2);
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
console.log(`[config] cli entry = ${cliEntry}\n`);

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
