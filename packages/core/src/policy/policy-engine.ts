/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { ApprovalMode } from '../config/config.js';

/** Semantic decision categories returned by a {@link PolicyEngine}. */
export enum PolicyDecision {
  Allow = 'allow',
  AskUser = 'ask_user',
  Deny = 'deny',
}

/**
 * A tiny in-memory policy engine.
 *
 * The full gemini-cli implementation ships a rules system (priority, match on
 * tool name + arg paths, persistence via TOML, etc.). For DeepCode's ACP
 * integration we only need the shape of the API: ACP code calls
 * `createPolicyUpdater` and `updatePolicy` to persist "allow always"
 * decisions, while the real gating still happens via the existing
 * `ToolConfirmationOutcome` path in the tool scheduler.
 *
 * This class keeps the calls type-safe and gives us a single seam to replace
 * with a richer implementation later without touching the ACP layer again.
 *
 * We intentionally reuse {@link ApprovalMode} from `config/config.ts` instead
 * of defining a parallel enum, so that mode switches stay consistent with the
 * rest of the runtime.
 */
export class PolicyEngine {
  private approvalMode: ApprovalMode = ApprovalMode.DEFAULT;
  private readonly alwaysAllow = new Set<string>();

  getApprovalMode(): ApprovalMode {
    return this.approvalMode;
  }

  setApprovalMode(mode: ApprovalMode): void {
    this.approvalMode = mode;
  }

  /**
   * Decide for a given tool name whether it should be allowed, denied, or
   * deferred to the user.
   */
  check(toolName: string, options?: { isMutator?: boolean }): PolicyDecision {
    if (this.alwaysAllow.has(toolName)) return PolicyDecision.Allow;
    switch (this.approvalMode) {
      case ApprovalMode.YOLO:
        return PolicyDecision.Allow;
      case ApprovalMode.AUTO_EDIT:
        return options?.isMutator === false
          ? PolicyDecision.Allow
          : PolicyDecision.AskUser;
      case ApprovalMode.DEFAULT:
      default:
        return PolicyDecision.AskUser;
    }
  }

  /** Mark a tool as "always allowed" for the remainder of the session. */
  allowAlways(toolName: string): void {
    this.alwaysAllow.add(toolName);
  }

  /** Clear every always-allow entry. Primarily for tests. */
  clearAlwaysAllow(): void {
    this.alwaysAllow.clear();
  }
}
