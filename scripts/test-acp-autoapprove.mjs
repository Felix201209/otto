// Verify that ACP mode auto-approves routine tool calls (like write_file)
// without calling requestPermission on the client. This was broken: the
// runtime always forwarded the confirmation to the caller, and OpenClaw
// returned "Permission prompt unavailable in non-interactive mode".
//
// Strategy:
//   - Boot dvcode --acp
//   - Ask it to write a small file in a temp location
//   - Track whether we received any `session/request_permission` requests
//   - Assert: the tool call finishes successfully AND we never had to
//     answer a permission request for the routine write_file.
//
// Run: node scripts/test-acp-autoapprove.mjs

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const cliEntry = path.resolve(repoRoot, 'packages/cli/dist/index.js');

const tmpFile = path.join(os.tmpdir(), `dvcode-acp-smoke-${Date.now()}.txt`);
const tmpContent = 'hello from acp smoke test';

const child = spawn(process.execPath, [cliEntry, '--acp'], {
  stdio: ['pipe', 'pipe', 'pipe'],
});

child.stderr.on('data', (chunk) => {
  const s = chunk.toString('utf8');
  for (const line of s.split(/\r?\n/)) {
    if (line.trim()) process.stderr.write('[ERR] ' + line + '\n');
  }
});

let buf = '';
let sid = null;
let permissionRequestsSeen = 0;
const assistantText = { turn: '' };
let currentTurn = null;

function send(m) {
  const p = JSON.stringify(m.params ?? {});
  console.log('[->]', m.method, p.length > 120 ? p.slice(0, 117) + '...' : p);
  child.stdin.write(JSON.stringify(m) + '\n');
}

function fail(m) { console.error('\n❌', m); child.kill(); process.exit(1); }

child.stdout.on('data', (chunk) => {
  buf += chunk.toString('utf8');
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
    if (!line) continue;
    let m;
    try { m = JSON.parse(line); } catch {
      console.log('[stdout-noise]', line.slice(0, 140));
      continue;
    }

    // If server *sends* a request (not a response), its id is numeric AND
    // it carries a `method`. Track permission requests.
    if (m.method === 'session/request_permission') {
      permissionRequestsSeen++;
      console.log(
        `\n❌ server asked us to approve via session/request_permission (#${permissionRequestsSeen})`,
      );
      // Reject so dvcode doesn't hang; we expected ZERO of these for writes.
      send({ jsonrpc: '2.0', id: m.id, result: { outcome: { outcome: 'cancelled' } } });
      continue;
    }
    if (m.method === 'session/update') {
      const u = m.params?.update;
      if (u?.sessionUpdate === 'agent_message_chunk' && currentTurn) {
        assistantText.turn += u.content?.text ?? '';
      }
      continue;
    }

    if (m.id === 1) send({ jsonrpc: '2.0', id: 2, method: 'authenticate', params: { methodId: 'proxy-auth' } });
    else if (m.id === 2) send({ jsonrpc: '2.0', id: 3, method: 'session/new', params: { cwd: repoRoot, mcpServers: [] } });
    else if (m.id === 3) {
      sid = m.result?.sessionId;
      console.log('[session/new] sid =', sid);
      currentTurn = 'turn';
      send({
        jsonrpc: '2.0', id: 4,
        method: 'session/prompt',
        params: {
          sessionId: sid,
          prompt: [{
            type: 'text',
            text:
              `Use your write_file tool to create a file at exactly this path (do not modify the path):\n${tmpFile}\n` +
              `The file content should be exactly: ${tmpContent}\n` +
              `After writing, reply with ONE short sentence "done".`,
          }],
        },
      });
    } else if (m.id === 4) {
      currentTurn = null;
      console.log('\n[assistant reply]:', assistantText.turn.trim().slice(0, 300));

      let exists = false;
      let actualContent = '';
      try {
        actualContent = fs.readFileSync(tmpFile, 'utf-8');
        exists = true;
      } catch {}

      console.log('\n─────────────────────────────────────');
      console.log('[verdict]');
      console.log('  file exists at target path:            ', exists ? '✓' : '✗');
      console.log('  content matches:                       ', actualContent.includes(tmpContent) ? '✓' : '✗ actual=' + JSON.stringify(actualContent));
      console.log('  permission requests from dvcode:       ',
        permissionRequestsSeen === 0 ? '✓ 0 (auto-approved)' : '✗ ' + permissionRequestsSeen);
      console.log('─────────────────────────────────────');

      if (exists) {
        try { fs.unlinkSync(tmpFile); } catch {}
      }

      child.kill();
      process.exit(
        exists && permissionRequestsSeen === 0 ? 0 : 2,
      );
    }
  }
});

child.on('exit', () => process.exit());

send({
  jsonrpc: '2.0', id: 1, method: 'initialize',
  params: {
    protocolVersion: 1,
    clientCapabilities: {
      fs: { readTextFile: true, writeTextFile: true },
    },
  },
});

setTimeout(() => fail('timeout 120s'), 120_000);
