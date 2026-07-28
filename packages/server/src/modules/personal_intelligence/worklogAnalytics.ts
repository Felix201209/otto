/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import {
  ESTIMATE,
  normalizeCostCNY,
  normalizeTokens,
} from './worklogEstimates.js';
import type {
  WorklogEstimateConfiguration,
  WorklogRecord,
  WorklogReport,
} from './worklogTypes.js';

interface TypeAggregate {
  count: number;
  min: number;
  tokens: number;
  cost: number;
}

function durationMinutes(value: unknown): number {
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function buildTrend(
  tasks: WorklogRecord[],
  multiplier: number,
): WorklogReport['trend'] {
  const sorted = [...tasks].sort((left, right) =>
    String(left.created_at || '').localeCompare(String(right.created_at || '')),
  );
  let cumulativeTasks = 0;
  let cumulativeSavedMinutes = 0;
  return sorted.map((task, index) => {
    cumulativeTasks += 1;
    cumulativeSavedMinutes +=
      durationMinutes(task.duration_min) * Math.max(multiplier - 1, 0);
    return {
      i: index + 1,
      at: String(task.created_at || ''),
      cumTasks: cumulativeTasks,
      cumSavedHours: Math.round((cumulativeSavedMinutes / 60) * 100) / 100,
    };
  });
}

function buildBottlenecks(
  byType: Record<string, TypeAggregate>,
): WorklogReport['bottlenecks'] {
  const entries = Object.entries(byType);
  if (entries.length === 0) {
    return { slowestTotal: null, mostFrequent: null, slowestAvg: null };
  }
  const slowestTotal = entries.reduce((left, right) =>
    right[1].min > left[1].min ? right : left,
  );
  const mostFrequent = entries.reduce((left, right) =>
    right[1].count > left[1].count ? right : left,
  );
  const slowestAvg = entries.reduce((left, right) => {
    const leftAverage = left[1].count ? left[1].min / left[1].count : 0;
    const rightAverage = right[1].count ? right[1].min / right[1].count : 0;
    return rightAverage > leftAverage ? right : left;
  });
  return {
    slowestTotal: {
      taskType: slowestTotal[0],
      minutes: Math.round(slowestTotal[1].min),
    },
    mostFrequent: {
      taskType: mostFrequent[0],
      count: mostFrequent[1].count,
    },
    slowestAvg: {
      taskType: slowestAvg[0],
      avgMinutes:
        Math.round((slowestAvg[1].min / (slowestAvg[1].count || 1)) * 10) / 10,
    },
  };
}

export function buildWorklogReport(
  tasks: WorklogRecord[],
  activeEmployees: number,
  periodDays: number,
  estimate: WorklogEstimateConfiguration = ESTIMATE,
): WorklogReport {
  const totalMinutes = tasks.reduce(
    (sum, task) => sum + durationMinutes(task.duration_min),
    0,
  );
  const totalTokens = tasks.reduce(
    (sum, task) => sum + normalizeTokens(task.tokens_used),
    0,
  );
  const totalCost = tasks.reduce(
    (sum, task) => sum + normalizeCostCNY(task.cost_cny),
    0,
  );
  const multiplier = estimate.manualTimeMultiplier;
  const savedMinutes = totalMinutes * Math.max(multiplier - 1, 0);
  const laborSaved = (savedMinutes / 60) * estimate.cnyPerHour;
  const netBenefit = laborSaved - totalCost;
  const rawLaborPerToken = totalCost > 0 ? laborSaved / totalCost : 0;
  const laborPerTokenCapped = rawLaborPerToken > estimate.laborPerTokenCap;
  const laborPerToken = laborPerTokenCapped
    ? estimate.laborPerTokenCap
    : rawLaborPerToken;

  const byType: Record<string, TypeAggregate> = {};
  for (const task of tasks) {
    const aggregate = (byType[task.task_type] ??= {
      count: 0,
      min: 0,
      tokens: 0,
      cost: 0,
    });
    aggregate.count += 1;
    aggregate.min += durationMinutes(task.duration_min);
    aggregate.tokens += normalizeTokens(task.tokens_used);
    aggregate.cost += normalizeCostCNY(task.cost_cny);
  }

  return {
    period: `${periodDays}d`,
    totalTasks: tasks.length,
    totalMinutes: Math.round(totalMinutes),
    totalTokens,
    timeSavedHours: Math.round((savedMinutes / 60) * 10) / 10,
    laborSavedCNY: Math.round(laborSaved),
    netBenefitCNY: Math.round(netBenefit),
    tokenCostCNY: Math.round(totalCost * 100) / 100,
    laborPerTokenCNY: Math.round(laborPerToken * 10) / 10,
    laborPerTokenCapped,
    activeEmployees,
    estimated: true,
    assumptions: {
      manualTimeMultiplier: multiplier,
      cnyPerHour: estimate.cnyPerHour,
      laborPerTokenCap: estimate.laborPerTokenCap,
    },
    byType: Object.entries(byType).map(([taskType, aggregate]) => ({
      taskType,
      count: aggregate.count,
      minutes: Math.round(aggregate.min),
      tokens: aggregate.tokens,
      costCNY: Math.round(aggregate.cost * 100) / 100,
    })),
    trend: buildTrend(tasks, multiplier),
    bottlenecks: buildBottlenecks(byType),
  };
}
