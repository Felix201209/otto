/**
 * @license
 * Copyright 2026 Otto
 * SPDX-License-Identifier: Apache-2.0
 *
 * Tests for high-risk tool classification and policy enforcement.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  isHighRisk,
  isMediumRisk,
  getRiskTier,
  HIGH_RISK_TOOLS,
} from './highRiskTools.js';
import { CentralPolicy, PolicyDecision, ExecutionContext } from './centralPolicy.js';
import { Config, ApprovalMode } from '../config/config.js';
import { resolveSecret, maskSecret } from '../config/secretResolver.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeContext(overrides?: Partial<ExecutionContext>): ExecutionContext {
  return {
    sessionId: 'test-session',
    userId: 'test-user',
    source: 'terminal',
    ...overrides,
  };
}

function makeMockConfig(overrides: {
  approvalMode?: ApprovalMode;
  featureFlags?: Record<string, boolean>;
} = {}): Config {
  const mockSettings = {
    yolo: overrides.approvalMode === ApprovalMode.YOLO ? true : undefined,
    featureFlags: overrides.featureFlags ?? {},
  };

  const mockProjectSettingsManager = {
    load: () => mockSettings,
  };

  const config = {
    getApprovalMode: () => overrides.approvalMode ?? ApprovalMode.DEFAULT,
    getSessionId: () => 'test-session',
    getProjectSettingsManager: () => mockProjectSettingsManager,
  } as unknown as Config;

  return config;
}

// ---------------------------------------------------------------------------
// High-risk tool classification
// ---------------------------------------------------------------------------

describe('highRiskTools classification', () => {
  it('shell is high risk', () => {
    expect(isHighRisk('shell')).toBe(true);
    expect(HIGH_RISK_TOOLS.has('shell')).toBe(true);
  });

  it('run_shell_command is high risk', () => {
    expect(isHighRisk('run_shell_command')).toBe(true);
  });

  it('write_file is high risk', () => {
    expect(isHighRisk('write_file')).toBe(true);
  });

  it('delete_file is high risk', () => {
    expect(isHighRisk('delete_file')).toBe(true);
  });

  it('send_message is high risk', () => {
    expect(isHighRisk('send_message')).toBe(true);
  });

  it('send_mail is high risk', () => {
    expect(isHighRisk('send_mail')).toBe(true);
  });

  it('feishu_send is high risk', () => {
    expect(isHighRisk('feishu_send')).toBe(true);
  });

  it('crm_write is high risk', () => {
    expect(isHighRisk('crm_write')).toBe(true);
  });

  it('read_file is not high risk', () => {
    expect(isHighRisk('read_file')).toBe(false);
    expect(HIGH_RISK_TOOLS.has('read_file')).toBe(false);
  });

  it('glob is not high risk', () => {
    expect(isHighRisk('glob')).toBe(false);
  });

  it('an unknown tool is not high risk', () => {
    expect(isHighRisk('nonexistent_tool')).toBe(false);
  });

  it('getRiskTier returns correct tiers', () => {
    expect(getRiskTier('shell')).toBe('high');
    expect(getRiskTier('edit')).toBe('medium');
    expect(getRiskTier('read_file')).toBe('low');
  });
});

// ---------------------------------------------------------------------------
// Medium-risk tool classification
// ---------------------------------------------------------------------------

describe('mediumRiskTools classification', () => {
  it('create_file is medium risk', () => {
    expect(isMediumRisk('create_file')).toBe(true);
  });

  it('replace is medium risk', () => {
    expect(isMediumRisk('replace')).toBe(true);
  });

  it('edit is medium risk', () => {
    expect(isMediumRisk('edit')).toBe(true);
  });

  it('mcp_tool is medium risk', () => {
    expect(isMediumRisk('mcp_tool')).toBe(true);
  });

  it('read_file is not medium risk', () => {
    expect(isMediumRisk('read_file')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// High-risk forces AskUser in AUTO_EDIT mode
// ---------------------------------------------------------------------------

describe('CentralPolicy — high-risk tools force AskUser', () => {
  it('high-risk tool (shell) forces AskUser in AUTO_EDIT mode', () => {
    const policy = new CentralPolicy(
      makeMockConfig({
        approvalMode: ApprovalMode.AUTO_EDIT,
        featureFlags: { shell_access: true },
      }),
    );
    const result = policy.canExecute('shell', makeContext());
    expect(result.decision).toBe(PolicyDecision.AskUser);
    expect(result.reason).toContain('High-risk');
    expect(result.reason).toContain('shell');
  });

  it('high-risk tool (delete_file) forces AskUser in AUTO_EDIT mode', () => {
    const policy = new CentralPolicy(
      makeMockConfig({ approvalMode: ApprovalMode.AUTO_EDIT }),
    );
    const result = policy.canExecute('delete_file', makeContext());
    expect(result.decision).toBe(PolicyDecision.AskUser);
    expect(result.reason).toContain('High-risk');
  });

  it('high-risk tool (send_message) forces AskUser in DEFAULT mode', () => {
    const policy = new CentralPolicy(
      makeMockConfig({ approvalMode: ApprovalMode.DEFAULT }),
    );
    const result = policy.canExecute('send_message', makeContext());
    expect(result.decision).toBe(PolicyDecision.AskUser);
    expect(result.reason).toContain('High-risk');
  });

  it('high-risk tool in YOLO with feature flags enabled → allowed', () => {
    const policy = new CentralPolicy(
      makeMockConfig({
        approvalMode: ApprovalMode.YOLO,
        featureFlags: { shell_access: true },
      }),
    );
    const result = policy.canExecute('shell', makeContext());
    expect(result.decision).toBe(PolicyDecision.Allow);
    expect(result.reason).toContain('YOLO');
  });

  it('high-risk tool in YOLO with feature flag disabled → denied', () => {
    const policy = new CentralPolicy(
      makeMockConfig({
        approvalMode: ApprovalMode.YOLO,
        featureFlags: { shell_access: false },
      }),
    );
    const result = policy.canExecute('shell', makeContext());
    // shell has feature flag shell_access → disabled → Deny
    expect(result.decision).toBe(PolicyDecision.Deny);
    expect(result.reason).toContain('shell_access');
  });

  it('non-high-risk tool in AUTO_EDIT → AskUser (normal PolicyEngine path)', () => {
    const policy = new CentralPolicy(
      makeMockConfig({ approvalMode: ApprovalMode.AUTO_EDIT }),
    );
    // 'edit' is medium risk, but the high-risk check doesn't catch it.
    // It falls through to PolicyEngine which in AUTO_EDIT with no isMutator hint → AskUser
    const result = policy.canExecute('edit', makeContext());
    expect(result.decision).toBe(PolicyDecision.AskUser);
  });
});

// ---------------------------------------------------------------------------
// Secret resolution
// ---------------------------------------------------------------------------

describe('secretResolver', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe('resolveSecret', () => {
    it('resolves $ENV: references from process.env', () => {
      process.env.MY_API_KEY = 'sk-test-key-12345';
      const result = resolveSecret('$ENV:MY_API_KEY');
      expect(result).toBe('sk-test-key-12345');
    });

    it('returns undefined for missing $ENV: reference', () => {
      delete process.env.NONEXISTENT_VAR;
      const result = resolveSecret('$ENV:NONEXISTENT_VAR');
      expect(result).toBeUndefined();
    });

    it('$KEYCHAIN: stub falls back to same-named env var', () => {
      process.env.MY_SECRET = 'keychain-fallback-value';
      const result = resolveSecret('$KEYCHAIN:MY_SECRET');
      expect(result).toBe('keychain-fallback-value');
    });

    it('$KEYCHAIN: returns undefined when env fallback is also missing', () => {
      delete process.env.NO_SUCH_SECRET;
      const result = resolveSecret('$KEYCHAIN:NO_SUCH_SECRET');
      expect(result).toBeUndefined();
    });

    it('returns plain value unchanged (no prefix)', () => {
      const result = resolveSecret('sk-plain-key-abcdef');
      expect(result).toBe('sk-plain-key-abcdef');
    });

    it('returns undefined for empty string', () => {
      const result = resolveSecret('');
      expect(result).toBeUndefined();
    });
  });

  describe('maskSecret', () => {
    it('masks long secret showing last 6 chars', () => {
      const result = maskSecret('sk-abc123def456gh');
      expect(result).toBe('***f456gh');
    });

    it('masks short secret (≤6 chars) showing all chars', () => {
      const result = maskSecret('short');
      expect(result).toBe('***short');
    });

    it('handles empty string', () => {
      const result = maskSecret('');
      expect(result).toBe('***');
    });

    it('handles secret exactly 6 chars', () => {
      const result = maskSecret('abcdef');
      expect(result).toBe('***abcdef');
    });
  });
});
