/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 *
 * CentralPolicy — the single, clear policy decision boundary.
 *
 * Routes **all** risky behavior through one point:
 *   canExecute(toolName, context) → PolicyDecision
 *
 * Responsibilities:
 *   1. Wraps PolicyEngine (approval-mode gating)
 *   2. Feature flags (read from Config, map to tool allow/deny)
 *   3. Deny-by-default (no config → deny)
 *   4. Audit logging (every decision, allowed + denied)
 *
 * This is the kernel-level policy gate.  UI adapters, CLI commands,
 * and tool hooks all call the same canExecute() entry point.
 */

import { Config, ApprovalMode } from '../config/config.js';
import { PolicyEngine, PolicyDecision } from './policy-engine.js';
import { getAuditLogger, AuditLogger } from '../orchestration/auditLog.js';
import { isHighRisk } from './highRiskTools.js';

// ---------------------------------------------------------------------------
// Re-export PolicyDecision so callers don't need to reach into policy-engine
// ---------------------------------------------------------------------------
export { PolicyDecision } from './policy-engine.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Context passed to the policy decision engine.
 */
export interface ExecutionContext {
  /** Unique session identifier. */
  sessionId: string;
  /** Authenticated user id (OS user, Feishu user, or system). */
  userId: string;
  /** Caller origin: 'terminal', 'feishu', 'desktop', 'api', etc. */
  source: string;
  /** Tool arguments (optional, for feature-flag or path-based rules). */
  toolArgs?: Record<string, unknown>;
  /** Filesystem path(s) the tool targets (optional, for allowlisting). */
  resourcePath?: string;
}

/**
 * The result of a single policy decision.
 */
export interface PolicyDecisionResult {
  decision: PolicyDecision;
  /** Human-readable reason for auditing / debugging. */
  reason: string;
}

// ---------------------------------------------------------------------------
// Feature-Flag Mapping
// ---------------------------------------------------------------------------

/**
 * Map of tool name to the feature flag that controls it.
 *
 * When a feature flag is **absent** or set to `false` in config, the
 * corresponding tool is denied at the policy gate regardless of approval
 * mode.
 */
const TOOL_FEATURE_FLAG_MAP: Record<string, string> = {
  // 飞书能力
  'lark_cli': 'feishu_integration',
  'feishu_project_collab': 'feishu_integration',

  // 桌面自动化
  'desktop_automation': 'desktop_automation',
  'web_automation': 'web_automation',

  // 文件操作（危险）
  'run_shell_command': 'shell_access',
  'shell': 'shell_access',

  // 消息发送
  'multi_channel_send': 'messaging',

  // 语音
  'voice_bridge': 'voice_input',

  // AI 图片生成
  'image_generator': 'image_generation',
};

// ---------------------------------------------------------------------------
// CentralPolicy
// ---------------------------------------------------------------------------

export class CentralPolicy {
  private readonly engine: PolicyEngine;
  private readonly config: Config;
  private readonly auditor: AuditLogger;

  constructor(config: Config) {
    this.engine = new PolicyEngine();
    this.config = config;
    this.auditor = getAuditLogger();
  }

  /**
   * The single policy decision point.
   *
   * Call this **before** executing any tool to determine whether the
   * operation should proceed.
   *
   * Decision priority:
   *   1. Missing tool info → Deny (deny-by-default)
   *   2. Feature flag disabled → Deny
   *   3. Approve mode gating via PolicyEngine → Allow / AskUser / Deny
   */
  canExecute(toolName: string, context: ExecutionContext): PolicyDecisionResult {
    // --- Guard: deny-by-default if we have no policy config at all ---
    if (!toolName) {
      return this.auditAndReturn(
        PolicyDecision.Deny,
        'Missing tool name — deny by default',
        toolName,
        context,
      );
    }

    // --- Feature-flag check ---
    const flagKey = TOOL_FEATURE_FLAG_MAP[toolName];
    if (flagKey) {
      const flagEnabled = this.isFeatureEnabled(flagKey);
      if (!flagEnabled) {
        return this.auditAndReturn(
          PolicyDecision.Deny,
          `Feature flag "${flagKey}" is disabled for tool "${toolName}"`,
          toolName,
          context,
        );
      }
    }

    // --- High-risk tool check ---
    // High-risk tools (shell, delete_file, send_message, etc.) always
    // require AskUser. Even in AUTO_EDIT mode, high-risk tools are NOT
    // auto-allowed. In YOLO mode, feature flags still apply.
    const approvalMode = this.config.getApprovalMode();
    const highRisk = isHighRisk(toolName);

    if (highRisk && approvalMode !== ApprovalMode.YOLO) {
      return this.auditAndReturn(
        PolicyDecision.AskUser,
        `High-risk tool "${toolName}" requires user confirmation in ${approvalMode} mode`,
        toolName,
        context,
      );
    }

    if (highRisk && approvalMode === ApprovalMode.YOLO) {
      // YOLO + high-risk: still allowed, but feature flags must already pass.
      // Write an audit entry noting the elevated permission.
      return this.auditAndReturn(
        PolicyDecision.Allow,
        `High-risk tool "${toolName}" allowed under YOLO mode (explicit opt-in)`,
        toolName,
        context,
      );
    }

    // --- Approval-mode gating via PolicyEngine ---
    // Sync the engine's internal mode with config so PolicyEngine.check()
    // respects the current mode.
    this.engine.setApprovalMode(approvalMode);

    const decision = this.engine.check(toolName);

    const reason =
      approvalMode === ApprovalMode.YOLO
        ? `YOLO mode — tool "${toolName}" allowed`
        : approvalMode === ApprovalMode.AUTO_EDIT
          ? `AUTO_EDIT mode — tool "${toolName}" requires confirmation for mutators`
          : `DEFAULT mode — tool "${toolName}" requires user confirmation`;

    return this.auditAndReturn(decision, reason, toolName, context);
  }

  // -----------------------------------------------------------------------
  // Internal helpers
  // -----------------------------------------------------------------------

  /**
   * Look up a boolean feature flag from config.
   *
   * Feature flags are stored in project settings (`otto.json`).
   * If the flag is absent we treat it as **disabled** (deny-by-default).
   */
  private isFeatureEnabled(flagKey: string): boolean {
    try {
      const settings = (this.config as any).getProjectSettingsManager?.()?.load?.();
      if (!settings || !settings.featureFlags) return false;
      return settings.featureFlags[flagKey] === true;
    } catch {
      return false;
    }
  }

  /**
   * Write an audit entry and return the decision.
   */
  private auditAndReturn(
    decision: PolicyDecision,
    reason: string,
    toolName: string,
    context: ExecutionContext,
  ): PolicyDecisionResult {
    // Fire-and-forget audit (do not block the policy gate on I/O)
    this.auditor
      .log({
        sessionId: context.sessionId,
        userId: context.userId,
        toolName,
        action: `Policy decision: ${decision} — ${reason}`,
        category: 'policy',
        success: decision === PolicyDecision.Allow,
        inputSummary: JSON.stringify(context).substring(0, 500),
        outputSummary: reason,
        source: context.source,
      })
      .catch(() => {
        /* audit log failures are non-fatal */
      });

    return { decision, reason };
  }
}

/**
 * Convenience: create a CentralPolicy from an existing Config instance.
 */
export function createCentralPolicy(config: Config): CentralPolicy {
  return new CentralPolicy(config);
}
