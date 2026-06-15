// One-shot ACP capability probe for the external bridges we drive as a client.
// Spawns each bridge over stdio, sends `initialize`, and prints the advertised
// agentCapabilities (loadSession, sessionCapabilities.list, etc.). Then, if
// `list` is advertised, tries `session/list` to confirm it actually answers.
//
// Usage:  node scripts/probe-acp-caps.mjs [claude|codex|both]
// Requires network (npx cold-download of the bridge on first run).

import * as acp from '@agentclientprotocol/sdk';
import { spawn } from 'node:child_process';
import { Readable, Writable } from 'node:stream';
import os from 'node:os';

const BRIDGES = {
  'claude-code': { command: 'npx', args: ['-y', '@agentclientprotocol/claude-agent-acp'] },
  codex: { command: 'npx', args: ['-y', '@zed-industries/codex-acp'] },
};

class ProbeClient {
  async requestPermission() {
    return { outcome: { outcome: 'cancelled' } };
  }
  async sessionUpdate() {}
  async readTextFile({ path }) {
    const fs = await import('node:fs/promises');
    return { content: await fs.readFile(path, 'utf8') };
  }
  async writeTextFile() {
    return {};
  }
}

async function probe(label, spec) {
  console.log(`\n=== ${label} (${spec.command} ${spec.args.join(' ')}) ===`);
  const child = spawn(spec.command, spec.args, {
    stdio: ['pipe', 'pipe', 'pipe'],
    shell: os.platform() === 'win32',
    env: process.env,
  });
  let stderr = '';
  child.stderr.on('data', (b) => {
    if (stderr.length < 4000) stderr += b.toString('utf8');
  });
  child.stdin.on('error', () => {});

  const stream = acp.ndJsonStream(
    Writable.toWeb(child.stdin),
    Readable.toWeb(child.stdout),
  );
  const conn = new acp.ClientSideConnection(() => new ProbeClient(), stream);

  const killTimer = setTimeout(() => child.kill(), 90_000);
  try {
    const init = await conn.initialize({
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: false },
    });
    const caps = init.agentCapabilities ?? {};
    console.log('protocolVersion:', init.protocolVersion);
    console.log('loadSession:', caps.loadSession ?? false);
    console.log('sessionCapabilities.list:', caps.sessionCapabilities?.list ?? false);
    console.log('full agentCapabilities:', JSON.stringify(caps));

    if (caps.sessionCapabilities?.list) {
      try {
        const page = await conn.listSessions({});
        console.log(`session/list OK — ${page.sessions.length} sessions, sample:`,
          JSON.stringify(page.sessions.slice(0, 2)));
      } catch (e) {
        console.log('session/list FAILED:', e?.message ?? String(e));
      }
    }
  } catch (e) {
    console.log('initialize FAILED:', e?.message ?? String(e));
    if (stderr.trim()) console.log('stderr tail:', stderr.trim().split('\n').slice(-5).join('\n'));
  } finally {
    clearTimeout(killTimer);
    child.kill();
  }
}

const which = (process.argv[2] ?? 'both').toLowerCase();
if (which === 'claude' || which === 'both') await probe('claude-code', BRIDGES['claude-code']);
if (which === 'codex' || which === 'both') await probe('codex', BRIDGES['codex']);
process.exit(0);
