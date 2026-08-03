/**
 * @license
 * Copyright 2026 Otto
 * SPDX-License-Identifier: Apache-2.0
 *
 * High-risk tool classification for CentralPolicy.
 *
 * Tools are classified into three risk tiers:
 *   HIGH   — Requires AskUser even in AUTO_EDIT mode
 *   MEDIUM — Requires AskUser in DEFAULT mode (normal workflow)
 *   LOW    — Implicit; everything not in HIGH or MEDIUM
 *
 * Usage:
 *   import { isHighRisk, HIGH_RISK_TOOLS } from './highRiskTools.js';
 */

// ---------------------------------------------------------------------------
// HIGH RISK — Always requires user confirmation
// ---------------------------------------------------------------------------

/**
 * Tools that can cause irreversible damage, send messages externally,
 * write/delete user files, or execute arbitrary commands.
 *
 * Even in AUTO_EDIT mode, these tools force AskUser.
 */
export const HIGH_RISK_TOOLS: ReadonlySet<string> = new Set([
  'shell',
  'run_shell_command',
  'write_file',
  'delete_file',
  'send_message',
  'send_mail',
  'feishu_send',
  'crm_write',
  'rpa_run',
]);

// ---------------------------------------------------------------------------
// MEDIUM RISK — Requires AskUser in DEFAULT mode
// ---------------------------------------------------------------------------

/**
 * Tools that modify the environment or create new resources.
 * These need approval in DEFAULT mode but may be auto-allowed in AUTO_EDIT.
 */
export const MEDIUM_RISK_TOOLS: ReadonlySet<string> = new Set([
  'create_file',
  'replace',
  'edit',
  'mcp_tool',
]);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Returns true if the tool is classified as HIGH risk.
 */
export function isHighRisk(toolName: string): boolean {
  return HIGH_RISK_TOOLS.has(toolName);
}

/**
 * Returns true if the tool is classified as MEDIUM risk.
 */
export function isMediumRisk(toolName: string): boolean {
  return MEDIUM_RISK_TOOLS.has(toolName);
}

/**
 * Returns the risk tier for a tool: 'high', 'medium', or 'low'.
 */
export type RiskTier = 'high' | 'medium' | 'low';

export function getRiskTier(toolName: string): RiskTier {
  if (HIGH_RISK_TOOLS.has(toolName)) return 'high';
  if (MEDIUM_RISK_TOOLS.has(toolName)) return 'medium';
  return 'low';
}
