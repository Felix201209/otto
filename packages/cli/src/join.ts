/**
 * @license Copyright 2026 Felix SPDX-License-Identifier: Apache-2.0
 *
 * Otto Enterprise CLI Client —— 员工瘦客户端。
 *
 *   otto --join <邀请码> --server <host:port>   员工用邀请码入职（5 问引导）
 *   otto --admin [--server <host:port>]         打印老板看板地址
 *
 * 数据全部留在服务端（老板设备），员工机器只存 ~/.otto-enterprise/client.json 连接信息。
 *
 * 由 packages/cli/index.ts 在检测到 --join / --admin 时调用 handleEnterpriseArgs()，
 * 命中则走本客户端流程、不进常规 Otto CLI 主流程。
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as readline from 'node:readline';

const CONFIG_DIR = path.join(os.homedir(), '.otto-enterprise');
const CLIENT_CONFIG = path.join(CONFIG_DIR, 'client.json');
const DEFAULT_SERVER = 'localhost:7777';

interface ClientConfig {
  server: string;
  employee_id: string;
  employee_name: string;
  department: string;
  role: string;
}

function saveConfig(cfg: ClientConfig): void {
  if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR, { recursive: true });
  // 0o600：仅本人可读写，连接信息不外泄。
  fs.writeFileSync(CLIENT_CONFIG, JSON.stringify(cfg, null, 2), { mode: 0o600 });
}

async function api(
  server: string,
  method: string,
  endpoint: string,
  body?: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const opts: RequestInit = {
    method,
    headers: { 'Content-Type': 'application/json' },
  };
  if (body) opts.body = JSON.stringify(body);
  const resp = await fetch(`http://${server}${endpoint}`, opts);
  const data = (await resp.json()) as Record<string, unknown>;
  if (!resp.ok) throw new Error((data.error as string) || `HTTP ${resp.status}`);
  return data;
}

function ask(rl: readline.Interface, question: string): Promise<string> {
  return new Promise((resolve) =>
    rl.question(question, (ans) => resolve(ans.trim())),
  );
}

/** 员工用邀请码入职：健康检查 → 5 问引导 → 落 client.json。 */
async function join(inviteCode: string, server: string): Promise<void> {
  console.log(`\nConnecting to Otto Enterprise at ${server}...`);
  try {
    const health = await api(server, 'GET', '/enterprise/health');
    if (health.status !== 'ok') throw new Error('Server not healthy');
    console.log('Connected.\n');
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`Cannot connect to server at ${server}: ${msg}`);
    console.error('Check that the server is running and the address is correct.');
    process.exit(1);
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    // 先把所有问题问完再提交——避免 readline 与异步 API 交错时在管道输入(EOF)下被提前关闭，
    // 也让非交互脚本化调用同样可用。
    const name = await ask(rl, 'Your name: ');
    if (!name) {
      console.error('Name is required.');
      process.exit(1);
    }
    console.log('\nI need to ask you a few questions to get to know you better.\n');
    const role = await ask(rl, 'Q1: What is your role? (e.g. agent, accountant, admin): ');
    const painPoints = await ask(rl, 'Q2: What is your most frustrating daily task? ');
    const device = await ask(rl, 'Q3: Do you work mostly on desktop or mobile? ');
    const helpFocus = await ask(rl, 'Q4: Where do you want Otto to help most? (documents/data/system/all): ');
    const experience = await ask(rl, 'Q5: How would you rate your computer skills? (beginner/intermediate/advanced): ');

    console.log(`\nValidating invite code: ${inviteCode}...`);
    const joinResult = await api(server, 'POST', '/enterprise/join', {
      invite_code: inviteCode,
      employee_name: name,
    });
    const employeeId = joinResult.employee_id as string;
    const department = (joinResult.department as string) || '';
    console.log(`Welcome ${name}! You're joining: ${department}`);

    console.log('\nSetting up your profile...');
    const onboardResult = await api(server, 'POST', '/enterprise/onboard', {
      employee_id: employeeId,
      role,
      personality: JSON.stringify({ painPoints, device, helpFocus, experience }),
      pain_points: painPoints,
      preferred_device: device,
      help_focus: helpFocus,
    });

    saveConfig({
      server,
      employee_id: employeeId,
      employee_name: name,
      department,
      role,
    });

    const inherited = (onboardResult.total_knowledge_items as number) ?? 0;
    console.log(`\n========================================`);
    console.log(`  Onboarding Complete!`);
    console.log(`========================================`);
    console.log(`  Name: ${name}`);
    console.log(`  Role: ${role}`);
    console.log(`  Department: ${department}`);
    console.log(`  Inherited: ${inherited} knowledge items`);
    console.log(`========================================`);
    console.log(`\nFrom now on, just tell me what you need to do.`);
    console.log(`Example: "help me enter a listing for Wangjing Xi Yuan"\n`);
  } finally {
    rl.close();
  }
}

/**
 * 处理企业客户端参数（--join / --admin）。命中并处理完返回；
 * 由 index.ts 在进入常规 CLI 前调用。
 */
export async function handleEnterpriseArgs(args: string[]): Promise<void> {
  const flag = (name: string): string | null =>
    args.includes(name) ? args[args.indexOf(name) + 1] ?? null : null;

  // 老板看板地址
  if (args.includes('--admin')) {
    const server = flag('--server') || DEFAULT_SERVER;
    console.log(`\nOtto Enterprise Admin Dashboard:`);
    console.log(`  http://${server}/enterprise/dashboard\n`);
    console.log(`Open this URL in your browser.`);
    return;
  }

  // 员工入职
  const joinCode = flag('--join');
  if (joinCode) {
    const server = flag('--server');
    if (!server) {
      console.error('Server address required: --server <host:port>');
      process.exit(1);
    }
    await join(joinCode, server);
  }
}
