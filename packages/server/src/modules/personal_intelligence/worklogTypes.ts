/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

export interface PersonalWorklogOrganization {
  id: string;
  status: 'active' | 'disabled';
}

export interface PersonalWorklogEmployee {
  id: string;
  organization_id?: string;
  department?: string | null;
  status?: string;
}

export interface LogWorkTaskInput {
  organizationId?: string;
  employee_id: string;
  task_type: string;
  context?: string;
  result?: string;
  duration_min?: number;
  tokens_used?: number;
  cost_cny?: number;
}

export interface WorklogRecord {
  id: number;
  organization_id: string;
  employee_id: string;
  task_type: string;
  context: string | null;
  result: string | null;
  duration_min: number;
  tokens_used: number;
  cost_cny: number;
  created_at: string;
}

export interface WorklogEstimateConfiguration {
  manualTimeMultiplier: number;
  cnyPerHour: number;
  defaultTokensPerTask: number;
  defaultCostPerTaskCNY: number;
  laborPerTokenCap: number;
}

export interface WorklogReport {
  period: string;
  totalTasks: number;
  totalMinutes: number;
  totalTokens: number;
  timeSavedHours: number;
  laborSavedCNY: number;
  netBenefitCNY: number;
  tokenCostCNY: number;
  laborPerTokenCNY: number;
  laborPerTokenCapped: boolean;
  activeEmployees: number;
  estimated: true;
  assumptions: {
    manualTimeMultiplier: number;
    cnyPerHour: number;
    laborPerTokenCap: number;
  };
  byType: Array<{
    taskType: string;
    count: number;
    minutes: number;
    tokens: number;
    costCNY: number;
  }>;
  trend: Array<{
    i: number;
    at: string;
    cumTasks: number;
    cumSavedHours: number;
  }>;
  bottlenecks: {
    slowestTotal: { taskType: string; minutes: number } | null;
    mostFrequent: { taskType: string; count: number } | null;
    slowestAvg: { taskType: string; avgMinutes: number } | null;
  };
}
