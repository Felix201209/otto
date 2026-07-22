/**
 * @license
 * Copyright 2026 Felix
 * SPDX-License-Identifier: Apache-2.0
 */

import os from 'node:os';

export type AgentDeviceClass = 'low' | 'standard' | 'high';

export interface AgentResourceBudget {
  deviceClass: AgentDeviceClass;
  taskMaxConcurrency: number;
  workflowDefaultMaxConcurrency: number;
  workflowMaxConcurrencyCeiling: number;
  workflowDefaultMaxAgents: number;
  workflowMaxAgentsCeiling: number;
  workflowContextMaxChars: number;
  subAgentOverallTimeoutMs: number;
}

const MINUTE_MS = 60 * 1000;

function parsePositiveInt(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 1) return undefined;
  return Math.floor(parsed);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function detectDeviceClass(
  totalMemoryBytes: number = os.totalmem(),
  cpuCount: number = os.cpus().length,
  profileOverride?: string,
): AgentDeviceClass {
  const normalized = profileOverride?.trim().toLowerCase();
  if (normalized === 'low' || normalized === 'standard' || normalized === 'high') {
    return normalized;
  }

  const memoryGb = totalMemoryBytes / 1024 / 1024 / 1024;
  if (memoryGb < 8 || cpuCount <= 4) return 'low';
  if (memoryGb < 16 || cpuCount <= 8) return 'standard';
  return 'high';
}

export function getAgentResourceBudget(
  env: NodeJS.ProcessEnv = process.env,
  totalMemoryBytes: number = os.totalmem(),
  cpuCount: number = os.cpus().length,
): AgentResourceBudget {
  const deviceClass = detectDeviceClass(totalMemoryBytes, cpuCount, env.OTTO_AGENT_PROFILE);

  const defaultsByClass: Record<AgentDeviceClass, Omit<AgentResourceBudget, 'deviceClass'>> = {
    low: {
      taskMaxConcurrency: 1,
      workflowDefaultMaxConcurrency: 2,
      workflowMaxConcurrencyCeiling: 4,
      workflowDefaultMaxAgents: 24,
      workflowMaxAgentsCeiling: 96,
      workflowContextMaxChars: 12000,
      subAgentOverallTimeoutMs: 20 * MINUTE_MS,
    },
    standard: {
      taskMaxConcurrency: 2,
      workflowDefaultMaxConcurrency: 3,
      workflowMaxConcurrencyCeiling: 6,
      workflowDefaultMaxAgents: 48,
      workflowMaxAgentsCeiling: 160,
      workflowContextMaxChars: 16000,
      subAgentOverallTimeoutMs: 25 * MINUTE_MS,
    },
    high: {
      taskMaxConcurrency: 3,
      workflowDefaultMaxConcurrency: 4,
      workflowMaxConcurrencyCeiling: 8,
      workflowDefaultMaxAgents: 64,
      workflowMaxAgentsCeiling: 256,
      workflowContextMaxChars: 20000,
      subAgentOverallTimeoutMs: 30 * MINUTE_MS,
    },
  };

  const defaults = defaultsByClass[deviceClass];
  const workflowMaxConcurrencyCeiling = parsePositiveInt(env.OTTO_WORKFLOW_MAX_CONCURRENCY_CEILING)
    ?? defaults.workflowMaxConcurrencyCeiling;
  const workflowMaxAgentsCeiling = parsePositiveInt(env.OTTO_WORKFLOW_MAX_AGENTS_CEILING)
    ?? defaults.workflowMaxAgentsCeiling;

  return {
    deviceClass,
    taskMaxConcurrency: clamp(
      parsePositiveInt(env.OTTO_TASK_MAX_CONCURRENCY) ?? defaults.taskMaxConcurrency,
      1,
      workflowMaxConcurrencyCeiling,
    ),
    workflowDefaultMaxConcurrency: clamp(
      parsePositiveInt(env.OTTO_WORKFLOW_MAX_CONCURRENCY) ?? defaults.workflowDefaultMaxConcurrency,
      1,
      workflowMaxConcurrencyCeiling,
    ),
    workflowMaxConcurrencyCeiling,
    workflowDefaultMaxAgents: clamp(
      parsePositiveInt(env.OTTO_WORKFLOW_MAX_AGENTS) ?? defaults.workflowDefaultMaxAgents,
      1,
      workflowMaxAgentsCeiling,
    ),
    workflowMaxAgentsCeiling,
    workflowContextMaxChars: clamp(
      parsePositiveInt(env.OTTO_WORKFLOW_CONTEXT_MAX_CHARS) ?? defaults.workflowContextMaxChars,
      4000,
      40000,
    ),
    subAgentOverallTimeoutMs: clamp(
      parsePositiveInt(env.OTTO_SUBAGENT_TIMEOUT_MS) ?? defaults.subAgentOverallTimeoutMs,
      5 * MINUTE_MS,
      60 * MINUTE_MS,
    ),
  };
}
