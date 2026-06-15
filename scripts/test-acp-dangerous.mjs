// Verify that ACP mode still escalates DANGEROUS tool calls to the caller
// via session/request_permission. Complement to test-acp-autoapprove.mjs:
// that one checks the happy path; this one checks the safety rail.
//
// Strategy:
//   - Boot dvcode --acp
//   - Prompt the agent to run a genuinely dangerous shell command
//     (something the dangerous-command-detector should flag).
//   - Expect at least one session/request_permission to arrive.
//   - Reject it ("cancelled") and verify the tool call ends up failed.
//
// Run: node scripts/test-acp-dangerous.mjs

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const cliEntry = path.resolve(repoRoot, 'packages/cli/dist/index.js');

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
let dangerousPayloadSeen = false;

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

    if (m.method === 'session/request_permission') {
      permissionRequestsSeen++;
      const title = m.params?.toolCall?.title ?? '';
      console.log(
        `\n[permission request] #${permissionRequestsSeen} title="${title}"`,
      );
      // Look for something that indicates danger (emoji prefix, keywords)
      if (/危险|danger|warning|⚠/.test(title) || /rm\s+-rf|sudo|mkfs/.test(title)) {
        dangerousPayloadSeen = true;
      }
      // Reject it
      send({ jsonrpc: '2.0', id: m.id, result: { outcome: { outcome: 'cancelled' } } });
      continue;
    }

    if (m.id === 1) send({ jsonrpc: '2.0', id: 2, method: 'authenticate', params: { methodId: 'proxy-auth' } });
    else if (m.id === 2) send({ jsonrpc: '2.0', id: 3, method: 'session/new', params: { cwd: repoRoot, mcpServers: [] } });
    else if (m.id === 3) {
      sid = m.result?.sessionId;
      console.log('[session/new] sid =', sid);
      // Ask the agent to run a real-world dangerous command that the
      // dangerous-command-detector recognises (`git reset --hard`). We
      // deliberately pick something that looks like a normal dev op so
      // the model actually tries it — unlike `rm -rf /` which models
      // refuse on ethical grounds, hiding our safety rail behind theirs.
      send({
        jsonrpc: '2.0', id: 4,
        method: 'session/prompt',
        params: {
          sessionId: sid,
          prompt: [{
            type: 'text',
            text:
              'Run exactly this shell command using run_shell_command: `git reset --hard HEAD~1`. ' +
              'Do not explain, do not modify the command. Just invoke the tool.',
          }],
        },
      });
    } else if (m.id === 4) {
      console.log('\n─────────────────────────────────────');
      console.log('[verdict]');
      console.log('  permission requests received:',
        permissionRequestsSeen > 0 ? `✓ ${permissionRequestsSeen}` : '✗ 0 (dangerous op was NOT escalated!)');
      console.log('  title looked dangerous:       ',
        dangerousPayloadSeen ? '✓' : '? inconclusive — inspect [permission request] lines above');
      console.log('─────────────────────────────────────');
      child.kill();
      process.exit(permissionRequestsSeen > 0 ? 0 : 3);
    }
  }
});

child.on('exit', () => process.exit());

send({
  jsonrpc: '2.0', id: 1, method: 'initialize',
  params: {
    protocolVersion: 1,
    clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } },
  },
});

setTimeout(() => fail('timeout 120s'), 120_000);
