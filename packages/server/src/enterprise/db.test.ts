/**
 * @license Copyright 2026 Felix SPDX-License-Identifier: Apache-2.0
 *
 * 企业 report 算法 + 成本口径单测。
 * 数据安全：绝不污染真实企业库。每个测试用独立临时 OTTO_ENTERPRISE_DIR，
 * 并 vi.resetModules() + 动态 import，让 db.ts 的模块级单例每次全新，互不串档。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

type DbModule = typeof import('./db.js');

let tmpDir: string;
const prevEnv: Record<string, string | undefined> = {};

// 需要在测试里覆盖/还原的 env（隔离目录 + 估算参数）。
const ENV_KEYS = [
  'OTTO_ENTERPRISE_DIR',
  'OTTO_ESTIMATE_MANUAL_MULT',
  'OTTO_ESTIMATE_CNY_PER_HOUR',
  'OTTO_ESTIMATE_LABOR_PER_TOKEN_CAP',
] as const;

/** 设隔离目录 + 可选估算 env，然后拿到全新的 db 模块（单例已重置）。 */
async function freshDb(estimateEnv: Record<string, string> = {}): Promise<DbModule> {
  process.env.OTTO_ENTERPRISE_DIR = tmpDir;
  for (const [k, v] of Object.entries(estimateEnv)) process.env[k] = v;
  vi.resetModules();
  return import('./db.js');
}

beforeEach(() => {
  for (const k of ENV_KEYS) prevEnv[k] = process.env[k];
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'otto-ent-db-'));
});

afterEach(() => {
  // 还原所有被动过的 env，并清掉临时库，绝不留痕。
  for (const k of ENV_KEYS) {
    if (prevEnv[k] === undefined) delete process.env[k];
    else process.env[k] = prevEnv[k];
  }
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

describe('report 边界：0 任务不崩/不 NaN/不除零', () => {
  it('空库返回全 0，且所有数值字段有限（无 NaN/Infinity）', async () => {
    const db = await freshDb();
    const r = db.getReport(30);
    expect(r.totalTasks).toBe(0);
    expect(r.totalMinutes).toBe(0);
    expect(r.totalTokens).toBe(0);
    expect(r.timeSavedHours).toBe(0);
    expect(r.laborSavedCNY).toBe(0);
    expect(r.netBenefitCNY).toBe(0);
    expect(r.tokenCostCNY).toBe(0);
    // 除零口径：totalCost=0 时 laborPerToken 必须是 0，不是 NaN/Infinity。
    expect(r.laborPerTokenCNY).toBe(0);
    expect(r.laborPerTokenCapped).toBe(false);
    for (const v of [
      r.totalMinutes, r.totalTokens, r.timeSavedHours, r.laborSavedCNY,
      r.netBenefitCNY, r.tokenCostCNY, r.laborPerTokenCNY,
    ]) {
      expect(Number.isFinite(v)).toBe(true);
    }
    // 图表兜底：空数据下 trend/bottlenecks 不崩。
    expect(r.trend).toEqual([]);
    expect(r.bottlenecks).toEqual({ slowestTotal: null, mostFrequent: null, slowestAvg: null });
    expect(r.byType).toEqual([]);
  });
});

describe('timeSaved 口径：ottoMinutes × (mult − 1)，不双算', () => {
  function seedOneEmployeeTasks(db: DbModule, mins: number[]): void {
    db.createEmployee({ id: 'e1', name: '张三', department: 'legal' });
    for (const m of mins) {
      db.logTask({ employee_id: 'e1', task_type: 'contract_review', duration_min: m });
    }
  }

  it('默认 mult=2：省时 = ottoMin × (2−1) = ottoMin', async () => {
    const db = await freshDb(); // 默认 mult=2
    seedOneEmployeeTasks(db, [30, 30]); // ottoMin=60
    const r = db.getReport(30);
    expect(r.totalMinutes).toBe(60);
    // savedMin = 60 × (2-1) = 60min = 1.0h
    expect(r.timeSavedHours).toBe(1);
  });

  it('mult 可配：改 OTTO_ESTIMATE_MANUAL_MULT=3 生效，省时 = ottoMin × 2', async () => {
    const db = await freshDb({ OTTO_ESTIMATE_MANUAL_MULT: '3' });
    seedOneEmployeeTasks(db, [30, 30]); // ottoMin=60
    const r = db.getReport(30);
    expect(r.assumptions.manualTimeMultiplier).toBe(3);
    // savedMin = 60 × (3-1) = 120min = 2.0h（若双算成 ottoMin×mult=180min=3h 就错了）
    expect(r.timeSavedHours).toBe(2);
  });

  it('mult=1 时省时为 0（人工与 Otto 同速，无净节省）', async () => {
    const db = await freshDb({ OTTO_ESTIMATE_MANUAL_MULT: '1' });
    seedOneEmployeeTasks(db, [60]);
    const r = db.getReport(30);
    expect(r.timeSavedHours).toBe(0);
    expect(r.laborSavedCNY).toBe(0);
  });
});

describe('trend 累积正确', () => {
  it('按任务逐条累积 cumTasks 与 cumSavedHours（同日数据也成立）', async () => {
    const db = await freshDb(); // mult=2 → 每分钟省 1 分钟
    db.createEmployee({ id: 'e1', name: '张三', department: 'ops' });
    db.logTask({ employee_id: 'e1', task_type: 'a', duration_min: 30 });
    db.logTask({ employee_id: 'e1', task_type: 'b', duration_min: 90 });
    const r = db.getReport(30);
    expect(r.trend.length).toBe(2);
    expect(r.trend[0].cumTasks).toBe(1);
    expect(r.trend[1].cumTasks).toBe(2);
    // 累计省时（小时）：第1点 30×1/60=0.5h；第2点 (30+90)×1/60=2.0h
    expect(r.trend[0].cumSavedHours).toBeCloseTo(0.5, 5);
    expect(r.trend[1].cumSavedHours).toBeCloseTo(2.0, 5);
    // 单调不减
    expect(r.trend[1].cumSavedHours).toBeGreaterThanOrEqual(r.trend[0].cumSavedHours);
  });
});

describe('bottlenecks 选取正确（最耗时/最频繁/单次最慢）', () => {
  it('三类分别挑对 task_type', async () => {
    const db = await freshDb();
    db.createEmployee({ id: 'e1', name: '张三', department: 'ops' });
    // frequent: 3 次、总时长小、单次快
    for (let i = 0; i < 3; i++) db.logTask({ employee_id: 'e1', task_type: 'frequent', duration_min: 5 });
    // heavy: 2 次、总时长最大
    db.logTask({ employee_id: 'e1', task_type: 'heavy', duration_min: 40 });
    db.logTask({ employee_id: 'e1', task_type: 'heavy', duration_min: 40 }); // 总 80，单次均 40
    // slowSingle: 1 次、单次最慢
    db.logTask({ employee_id: 'e1', task_type: 'slowSingle', duration_min: 100 });
    const r = db.getReport(30);
    const b = r.bottlenecks;
    expect(b.slowestTotal?.taskType).toBe('slowSingle'); // 100 > 80 > 15
    expect(b.slowestTotal?.minutes).toBe(100);
    expect(b.mostFrequent?.taskType).toBe('frequent');
    expect(b.mostFrequent?.count).toBe(3);
    expect(b.slowestAvg?.taskType).toBe('slowSingle'); // 单次 100 最慢
    expect(b.slowestAvg?.avgMinutes).toBe(100);
  });
});

describe('P1 修复：laborPerToken 在 cost=0 场景不再爆表', () => {
  it('修复前会爆表的 2 任务场景（1 任务 cost=0、1 任务真实 cost）现在被兜底+封顶', async () => {
    // 复现 task 描述的实测场景：多数 cost=0、少数有真实 cost。
    const db = await freshDb(); // mult=2, cnyPerHour=50, cap=50
    db.createEmployee({ id: 'e1', name: '张三', department: 'legal' });
    // 任务1：显式上报 cost_cny=0（旧口径会存 0）、耗时 60min
    db.logTask({ employee_id: 'e1', task_type: 't1', duration_min: 60, tokens_used: 3000, cost_cny: 0 });
    // 任务2：真实 cost 0.03、耗时 60min
    db.logTask({ employee_id: 'e1', task_type: 't2', duration_min: 60, tokens_used: 3000, cost_cny: 0.03 });
    const r = db.getReport(30);
    // 兜底后：totalCost = 0.028(兜底) + 0.03 = 0.058，而非旧口径的 0.03。
    // laborSaved = (120×1/60)×50 = 100 元。旧：100/0.03≈3333；新裸算 100/0.058≈1724 → 仍超 50，封顶到 50。
    expect(r.laborPerTokenCapped).toBe(true);
    expect(r.laborPerTokenCNY).toBe(50);
    // 关键断言：绝不再出现 ¥1000+/token 的天文数字。
    expect(r.laborPerTokenCNY).toBeLessThanOrEqual(50);
    expect(Number.isFinite(r.laborPerTokenCNY)).toBe(true);
  });

  it('正常成本区间不封顶，返回真实可解释倍率', async () => {
    // cnyPerHour 调低让 laborSaved 变小，落在封顶线以内。
    const db = await freshDb({ OTTO_ESTIMATE_CNY_PER_HOUR: '50', OTTO_ESTIMATE_LABOR_PER_TOKEN_CAP: '50' });
    db.createEmployee({ id: 'e1', name: '张三', department: 'legal' });
    // 耗时 12min、真实 cost 1 元 → laborSaved=(12×1/60)×50=10；10/1=10 ≤ 50，不封顶。
    db.logTask({ employee_id: 'e1', task_type: 't', duration_min: 12, cost_cny: 1 });
    const r = db.getReport(30);
    expect(r.laborPerTokenCapped).toBe(false);
    expect(r.laborPerTokenCNY).toBe(10);
  });

  it('cap 可配：OTTO_ESTIMATE_LABOR_PER_TOKEN_CAP 生效', async () => {
    const db = await freshDb({ OTTO_ESTIMATE_LABOR_PER_TOKEN_CAP: '20' });
    db.createEmployee({ id: 'e1', name: '张三', department: 'legal' });
    // 造一个裸算远超 20 的场景：耗时 600min、cost 0.028 兜底 → laborSaved=(600×1/60)×50=500；500/0.028≈17857 → 封顶 20。
    db.logTask({ employee_id: 'e1', task_type: 't', duration_min: 600, cost_cny: 0 });
    const r = db.getReport(30);
    expect(r.assumptions.laborPerTokenCap).toBe(20);
    expect(r.laborPerTokenCapped).toBe(true);
    expect(r.laborPerTokenCNY).toBe(20);
  });
});

describe('成本/token 归一化（normalizeCostCNY / normalizeTokens）', () => {
  it('非正/非法值回落默认，正值透传', async () => {
    const db = await freshDb();
    // cost
    expect(db.normalizeCostCNY(0)).toBe(db.ESTIMATE.defaultCostPerTaskCNY);
    expect(db.normalizeCostCNY(-5)).toBe(db.ESTIMATE.defaultCostPerTaskCNY);
    expect(db.normalizeCostCNY(undefined)).toBe(db.ESTIMATE.defaultCostPerTaskCNY);
    expect(db.normalizeCostCNY(NaN)).toBe(db.ESTIMATE.defaultCostPerTaskCNY);
    expect(db.normalizeCostCNY(0.05)).toBe(0.05);
    // tokens
    expect(db.normalizeTokens(0)).toBe(db.ESTIMATE.defaultTokensPerTask);
    expect(db.normalizeTokens(-1)).toBe(db.ESTIMATE.defaultTokensPerTask);
    expect(db.normalizeTokens(undefined)).toBe(db.ESTIMATE.defaultTokensPerTask);
    expect(db.normalizeTokens(1234)).toBe(1234);
  });

  it('logTask 落库时 cost=0 被兜底为默认成本（totalCost 不再塌 0）', async () => {
    const db = await freshDb();
    db.createEmployee({ id: 'e1', name: '张三', department: 'legal' });
    db.logTask({ employee_id: 'e1', task_type: 't', duration_min: 10, cost_cny: 0, tokens_used: 0 });
    const r = db.getReport(30);
    // 单任务 cost 兜底 0.028、tokens 兜底 2000。tokenCostCNY 经 round 到 2 位 → 0.03（关键：非 0）。
    expect(r.tokenCostCNY).toBe(0.03);
    expect(r.totalTokens).toBe(2000);
  });
});

describe('report 期窗与部门过滤', () => {
  it('periodDays 之外的任务不计入', async () => {
    const db = await freshDb();
    db.createEmployee({ id: 'e1', name: '张三', department: 'legal' });
    db.logTask({ employee_id: 'e1', task_type: 't', duration_min: 30 });
    // 把这条改成 40 天前，落在 30 天窗外。
    db.getDB().prepare(
      "UPDATE task_logs SET created_at = datetime('now','-40 days') WHERE employee_id='e1'",
    ).run();
    const r = db.getReport(30);
    expect(r.totalTasks).toBe(0);
    // 放宽到 60 天窗则能看到。
    expect(db.getReport(60).totalTasks).toBe(1);
  });

  it('department 过滤只统计该部门任务', async () => {
    const db = await freshDb();
    db.createEmployee({ id: 'e1', name: '张三', department: 'legal' });
    db.createEmployee({ id: 'e2', name: '李四', department: 'ops' });
    db.logTask({ employee_id: 'e1', task_type: 'a', duration_min: 10 });
    db.logTask({ employee_id: 'e2', task_type: 'b', duration_min: 10 });
    expect(db.getReport(30, 'legal').totalTasks).toBe(1);
    expect(db.getReport(30).totalTasks).toBe(2);
  });
});
