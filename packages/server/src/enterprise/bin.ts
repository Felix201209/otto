#!/usr/bin/env node
/**
 * @license Copyright 2026 Felix SPDX-License-Identifier: Apache-2.0
 *
 * Enterprise launcher. PostgreSQL mode is loaded through an isolated async
 * entry point and never imports the legacy SQLite repository.
 *
 * Otto Enterprise 服务端启动入口（管理员/老板设备运行）。
 *
 *   node dist/enterprise/bin.js                 # 本机启动，端口 7777
 *   node dist/enterprise/bin.js --seed          # 先灌一批演示数据（看板立刻有东西看）
 *   OTTO_ENTERPRISE_HOST=0.0.0.0 \
 *   OTTO_ENTERPRISE_PUBLIC_URL=https://your-public-host \
 *   OTTO_APP_VERSION=1.10.1 \
 *   OTTO_BUILD_COMMIT=<完整的40位Git-SHA> \
 *   OTTO_ENTERPRISE_ADMIN_TOKEN=xxx node dist/enterprise/bin.js   # 局域网 + 鉴权
 */

function configuredForPostgres(): boolean {
  const backend =
    process.env.OTTO_ENTERPRISE_DATABASE_BACKEND?.trim().toLowerCase() ||
    'sqlite';
  return backend === 'postgres' || backend === 'postgresql';
}

async function startPostgres(args: Set<string>): Promise<void> {
  const {
    bootstrapClusteredEnterpriseAdmin,
    startClusteredEnterpriseServer,
  } = await import('./clusteredServer.js');
  if (args.has('--seed')) {
    throw new Error(
      'demo seed is intentionally unavailable in PostgreSQL clustered mode',
    );
  }
  if (args.has('--bootstrap-admin')) {
    const username = process.env.OTTO_BOOTSTRAP_USERNAME?.trim() || 'admin';
    const password = process.env.OTTO_BOOTSTRAP_PASSWORD || '';
    const name = process.env.OTTO_BOOTSTRAP_NAME?.trim() || '系统管理员';
    if (password.length < 8) {
      throw new Error(
        'OTTO_BOOTSTRAP_PASSWORD must contain at least 8 characters',
      );
    }
    const account = await bootstrapClusteredEnterpriseAdmin({
      username,
      password,
      name,
    });
    console.log(`[bootstrap] PostgreSQL 管理员账号已创建：${account.username}`);
    return;
  }
  await startClusteredEnterpriseServer();
}

async function startLocal(args: Set<string>): Promise<void> {
  const [db, serverModule] = await Promise.all([
    import('./db.js'),
    import('./server.js'),
  ]);

  if (args.has('--bootstrap-admin')) {
    const username = process.env.OTTO_BOOTSTRAP_USERNAME?.trim() || 'admin';
    const password = process.env.OTTO_BOOTSTRAP_PASSWORD || '';
    const name = process.env.OTTO_BOOTSTRAP_NAME?.trim() || '系统管理员';
    if (password.length < 8) {
      throw new Error(
        'OTTO_BOOTSTRAP_PASSWORD must contain at least 8 characters',
      );
    }
    if (db.listAccounts().length > 0) {
      throw new Error('Bootstrap refused: preset accounts already exist');
    }
    db.createAccount({
      username,
      password,
      name,
      role: '系统管理员',
      department: 'IT',
      tags: ['IT', '报修'],
      isAdmin: true,
    });
    console.log(`[bootstrap] 本地管理员账号已创建：${username}`);
    return;
  }

  if (args.has('--seed')) {
    const employees = db.listEmployees();
    if (employees.length > 0) {
      console.log(`[seed] 已有 ${employees.length} 名员工，跳过演示数据注入。`);
    } else {
      const code = db.createInviteCode('法务部', 'admin', 5);
      const people = [
        { name: '张律师', role: '律师', department: '法务部' },
        { name: '李会计', role: '审计员', department: '法务部' },
      ];
      const taskTypes = ['合同审查', '起诉状起草', 'OA立案', '证据清单'];
      for (const person of people) {
        const id = `emp_seed_${person.name}`;
        db.createEmployee({
          id,
          name: person.name,
          role: person.role,
          department: person.department,
          invite_code: code,
        });
        for (let index = 0; index < 6; index += 1) {
          const taskType = taskTypes[index % taskTypes.length]!;
          db.logTask({
            employee_id: id,
            task_type: taskType,
            context: `${person.name} 的第 ${index + 1} 个任务`,
            duration_min: 8 + (index % 4) * 3,
            tokens_used: db.ESTIMATE.defaultTokensPerTask,
            cost_cny: db.ESTIMATE.defaultCostPerTaskCNY,
          });
        }
      }
      db.addKnowledge({
        department: '法务部',
        category: 'SOP',
        content:
          '合同审查先核对主体资格、再看付款条款与违约责任，最后过一遍争议解决条款。',
        contributor: '张律师',
        confidence: 0.9,
      });
      console.log(
        `[seed] 已注入演示数据：邀请码 ${code}，2 名员工，12 条任务，1 条知识。`,
      );
    }
  }
  serverModule.startEnterpriseServer();
}

async function main(): Promise<void> {
  const args = new Set(process.argv.slice(2));
  if (configuredForPostgres()) await startPostgres(args);
  else await startLocal(args);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[Otto Enterprise] 启动失败：${message}`);
  process.exitCode = 1;
});
