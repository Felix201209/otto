/**
 * @license Copyright 2026 Felix SPDX-License-Identifier: Apache-2.0
 *
 * Otto Enterprise CLI Client - thin client for employees.
 *
 * Usage:
 *   otto --join <invite_code> --server <host:port>
 *   otto --server <host:port>  (after joining, just connect)
 *   otto --admin <host:port>   (admin dashboard URL)
 *
 * All data stays on the server (admin device).
 * Employee CLI stores only connection info locally.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as readline from 'node:readline';

const CONFIG_DIR = path.join(os.homedir(), '.otto-enterprise');
const CLIENT_CONFIG = path.join(CONFIG_DIR, 'client.json');

interface ClientConfig {
  server: string;
  employee_id: string;
  employee_name: string;
  department: string;
  role: string;
}

function loadConfig(): ClientConfig | null {
  if (!fs.existsSync(CLIENT_CONFIG)) return null;
  try { return JSON.parse(fs.readFileSync(CLIENT_CONFIG, 'utf8')); }
  catch { return null; }
}

function saveConfig(cfg: ClientConfig): void {
  if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(CLIENT_CONFIG, JSON.stringify(cfg, null, 2), { mode: 0o600 });
}

async function api(server: string, method: string, endpoint: string, body?: any): Promise<any> {
  const url = `http://${server}${endpoint}`;
  const opts: any = {
    method,
    headers: { 'Content-Type': 'application/json' },
  };
  if (body) opts.body = JSON.stringify(body);
  const resp = await fetch(url, opts);
  const data = await resp.json();
  if (!resp.ok) throw new Error(data.error || `HTTP ${resp.status}`);
  return data;
}

function ask(rl: readline.Interface, question: string): Promise<string> {
  return new Promise(resolve => rl.question(question, ans => resolve(ans.trim())));
}

// ============================================================
// JOIN: employee uses invite code
// ============================================================
async function join(inviteCode: string, server: string): Promise<void> {
  console.log(`\nConnecting to Otto Enterprise at ${server}...`);

  // Health check
  try {
    const health = await api(server, 'GET', '/enterprise/health');
    if (health.status !== 'ok') throw new Error('Server not healthy');
    console.log('Connected.\n');
  } catch (e: any) {
    console.error(`Cannot connect to server at ${server}: ${e.message}`);
    console.error('Check that the server is running and the address is correct.');
    process.exit(1);
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  // Ask for name
  const name = await ask(rl, 'Your name: ');
  if (!name) { console.error('Name is required.'); process.exit(1); }

  // Join via invite code
  console.log(`\nValidating invite code: ${inviteCode}...`);
  const joinResult = await api(server, 'POST', '/enterprise/join', {
    invite_code: inviteCode,
    employee_name: name,
  });

  console.log(`\nWelcome ${name}! You're joining: ${joinResult.department}`);
  console.log('\nI need to ask you a few questions to get to know you better.\n');

  // 5-question onboarding
  const role = await ask(rl, 'Q1: What is your role? (e.g. agent, accountant, admin): ');
  const painPoints = await ask(rl, 'Q2: What is your most frustrating daily task? ');
  const device = await ask(rl, 'Q3: Do you work mostly on desktop or mobile? ');
  const helpFocus = await ask(rl, 'Q4: Where do you want Otto to help most? (documents/data/system/all): ');
  const experience = await ask(rl, 'Q5: How would you rate your computer skills? (beginner/intermediate/advanced): ');

  console.log('\nSetting up your profile...');

  const onboardResult = await api(server, 'POST', '/enterprise/onboard', {
    employee_id: joinResult.employee_id,
    role,
    personality: JSON.stringify({ painPoints, device, helpFocus, experience }),
    pain_points: painPoints,
    preferred_device: device,
    help_focus: helpFocus,
  });

  // Save client config
  saveConfig({
    server,
    employee_id: joinResult.employee_id,
    employee_name: name,
    department: joinResult.department,
    role,
  });

  console.log(`\n========================================`);
  console.log(`  Onboarding Complete!`);
  console.log(`========================================`);
  console.log(`  Name: ${name}`);
  console.log(`  Role: ${role}`);
  console.log(`  Department: ${joinResult.department}`);
  console.log(`  Inherited: ${onboardResult.total_knowledge_items} knowledge items`);
  console.log(`========================================`);
  console.log(`\nFrom now on, just tell me what you need to do.`);
  console.log(`Example: "help me enter a listing for Wangjing Xi Yuan"\n`);

  rl.close();
}

// ============================================================
// MAIN: parse args
// ============================================================
async function main(): Promise<void> {
  const args = process.argv.slice(2);

  // Parse flags
  const joinCode = args.includes('--join') ? args[args.indexOf('--join') + 1] : null;
  const serverArg = args.includes('--server') ? args[args.indexOf('--server') + 1] : null;
  const adminFlag = args.includes('--admin');

  // Admin dashboard
  if (adminFlag) {
    const server = serverArg || 'localhost:7777';
    const url = `http://${server}/enterprise/dashboard`;
    console.log(`\nOtto Enterprise Admin Dashboard:`);
    console.log(`  ${url}\n`);
    console.log(`Open this URL in your browser.`);
    return;
  }

  // Join flow
  if (joinCode) {
    if (!serverArg) {
      console.error('Server address required: --server <host:port>');
      process.exit(1);
    }
    await join(joinCode, serverArg);
    return;
  }

  // Normal mode (already joined)
  const cfg = loadConfig();
  if (!cfg) {
    console.log('Welcome to Otto Enterprise!');
    console.log('\nTo get started, you need an invite code from your admin.');
    console.log('Usage: otto --join <invite_code> --server <host:port>');
    console.log('\nAre you an admin? Start the server:');
    console.log('  otto-server start');
    console.log('  Then create invite codes at: http://localhost:7777/enterprise/dashboard');
    process.exit(0);
  }

  // Connected mode - pass through to Otto CLI with enterprise context
  console.log(`Otto Enterprise | ${cfg.employee_name} | ${cfg.department}`);
  console.log(`Server: ${cfg.server}\n`);

  // The actual Otto CLI would take over from here
  // This thin client just ensures connection + config
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
