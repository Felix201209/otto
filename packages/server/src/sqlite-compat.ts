/**
 * @license Copyright 2026 Felix SPDX-License-Identifier: Apache-2.0
 *
 * 极薄的 better-sqlite3 兼容层，底层用 Node 内置 `node:sqlite`（Node 22.5+ / 24 稳定）。
 * 目的：企业服务端零原生依赖——不再需要 better-sqlite3（原生模块 + Electron 重编译）。
 * 只实现 db.ts 用到的子集：pragma / exec / prepare().run|get|all，支持具名(@x)与位置(?)参数。
 */

import { DatabaseSync, type StatementSync } from 'node:sqlite';

export interface Stmt {
  run(...args: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint };
  get(...args: unknown[]): unknown;
  all(...args: unknown[]): unknown[];
}

// node:sqlite 与 better-sqlite3 一样拒绝 undefined 绑定值；把 undefined 归一为 null。
function coerce(v: unknown): unknown {
  return v === undefined ? null : v;
}

function normalize(args: unknown[]): unknown[] {
  // 单个纯对象参数 → 具名参数；否则按位置参数处理。
  if (
    args.length === 1 &&
    args[0] !== null &&
    typeof args[0] === 'object' &&
    !Array.isArray(args[0])
  ) {
    const obj = args[0] as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(obj)) out[k] = coerce(obj[k]);
    return [out];
  }
  return args.map(coerce);
}

export class Database {
  private readonly db: DatabaseSync;

  constructor(filename: string) {
    this.db = new DatabaseSync(filename);
  }

  pragma(directive: string): void {
    this.db.exec(`PRAGMA ${directive};`);
  }

  exec(sql: string): void {
    this.db.exec(sql);
  }

  prepare(sql: string): Stmt {
    const st: StatementSync = this.db.prepare(sql);
    // 允许 { name } 这种不带 @/$/: 前缀的具名参数（对齐 better-sqlite3 语义）。
    (st as unknown as { setAllowBareNamedParameters?: (v: boolean) => void })
      .setAllowBareNamedParameters?.(true);
    const call = (fn: 'run' | 'get' | 'all', args: unknown[]): unknown =>
      (st[fn] as (...a: unknown[]) => unknown)(...normalize(args));
    return {
      run: (...a) => call('run', a) as { changes: number | bigint; lastInsertRowid: number | bigint },
      get: (...a) => call('get', a),
      all: (...a) => call('all', a) as unknown[],
    };
  }

  close(): void {
    this.db.close();
  }
}

export type DatabaseHandle = Database;
