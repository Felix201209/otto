/**
 * @license
 * Copyright 2026 Easy Code team
 * https://github.com/OrionStarAI/DeepVCode
 * SPDX-License-Identifier: Apache-2.0
 */


import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  getShortVersion,
  getShortModelName,
  getContextDisplay,
  getFooterDisplayConfig,
  getThinkingEffortLabel,
} from './footerUtils.js';

describe('footerUtils', () => {
  let originalNodeVersion: string;

  beforeEach(() => {
    originalNodeVersion = process.versions.node;
    // Mock Node version for consistent tests
    Object.defineProperty(process.versions, 'node', {
      value: '22.19.0',
      writable: true,
      configurable: true,
    });
  });

  afterEach(() => {
    Object.defineProperty(process.versions, 'node', {
      value: originalNodeVersion,
      writable: true,
      configurable: true,
    });
  });

  describe('getShortVersion', () => {
    it('should return version with Node version when includeNodeVersion is true', () => {
      expect(getShortVersion('1.0.161', true)).toBe('v1.0.161(22.19.0)');
    });

    it('should return version without Node version when includeNodeVersion is false', () => {
      expect(getShortVersion('1.0.161', false)).toBe('v1.0.161');
    });

    it('should default to not including Node version', () => {
      expect(getShortVersion('1.0.161')).toBe('v1.0.161');
    });
  });

  describe('getShortModelName', () => {
    it('should return full name when simplified is false', () => {
      expect(getShortModelName('Claude-3.5-Sonnet', false)).toBe('Claude-3.5-Sonnet');
      expect(getShortModelName('Gemini-2.0-Flash', false)).toBe('Gemini-2.0-Flash');
    });

    it('should simplify Claude model names', () => {
      expect(getShortModelName('Claude-3.5-Sonnet', true)).toBe('Sonnet');
      expect(getShortModelName('Claude-Opus', true)).toBe('Opus');
      expect(getShortModelName('Claude-Haiku', true)).toBe('Haiku');
    });

    it('should simplify Gemini model names', () => {
      expect(getShortModelName('Gemini-2.0-Flash', true)).toBe('Flash');
      expect(getShortModelName('Gemini-Pro', true)).toBe('Pro');
      expect(getShortModelName('Gemini-Ultra', true)).toBe('Ultra');
    });

    it('should simplify GPT model names', () => {
      expect(getShortModelName('GPT-4', true)).toBe('4');
      expect(getShortModelName('GPT-3.5-Turbo', true)).toBe('3.5-Turbo');
    });

    it('should simplify OpenAI model names', () => {
      expect(getShortModelName('OpenAI-GPT4', true)).toBe('GPT4');
    });

    it('should return original name if no pattern matches', () => {
      expect(getShortModelName('UnknownModel', true)).toBe('UnknownModel');
      expect(getShortModelName('CustomAI-Model', true)).toBe('CustomAI-Model');
    });

    it('should handle case-insensitive matching', () => {
      expect(getShortModelName('claude-3.5-sonnet', true)).toBe('sonnet');
      expect(getShortModelName('GEMINI-Pro', true)).toBe('Pro');
    });
  });

  describe('getContextDisplay', () => {
    it('should return full text when simplified is false', () => {
      expect(getContextDisplay(92, false)).toBe('92% ctx left');
      expect(getContextDisplay(50, false)).toBe('50% ctx left');
    });

    it('should return percentage only when simplified is true', () => {
      expect(getContextDisplay(92, true)).toBe('92%');
      expect(getContextDisplay(50, true)).toBe('50%');
    });

    it('should handle edge cases', () => {
      expect(getContextDisplay(0, false)).toBe('0% ctx left');
      expect(getContextDisplay(100, false)).toBe(''); // 100% 时隐藏
      expect(getContextDisplay(0, true)).toBe('0%');
      expect(getContextDisplay(100, true)).toBe(''); // 100% 时隐藏
    });

    it('should hide context display when at 100%', () => {
      expect(getContextDisplay(100, false)).toBe('');
      expect(getContextDisplay('100', false)).toBe('');
      expect(getContextDisplay(100, true)).toBe('');
      expect(getContextDisplay('100', true)).toBe('');
    });
  });

  describe('getFooterDisplayConfig', () => {
    it('should return full config for width >= 80', () => {
      const config80 = getFooterDisplayConfig(80);
      expect(config80.showNodeVersion).toBe(false);
      expect(config80.simplifyContext).toBe(false);
      expect(config80.simplifyModel).toBe(false);
      expect(config80.level).toBe('full');

      const config120 = getFooterDisplayConfig(120);
      expect(config120.showNodeVersion).toBe(false);
      expect(config120.simplifyContext).toBe(false);
      expect(config120.simplifyModel).toBe(false);
      expect(config120.level).toBe('full');
    });

    it('should return compact config for width 60-79', () => {
      const config60 = getFooterDisplayConfig(60);
      expect(config60.showNodeVersion).toBe(false);
      expect(config60.simplifyContext).toBe(true);
      expect(config60.simplifyModel).toBe(true);
      expect(config60.level).toBe('compact');

      const config79 = getFooterDisplayConfig(79);
      expect(config79.showNodeVersion).toBe(false);
      expect(config79.simplifyContext).toBe(true);
      expect(config79.simplifyModel).toBe(true);
      expect(config79.level).toBe('compact');
    });

    it('should return compact config for width < 60', () => {
      const config50 = getFooterDisplayConfig(50);
      expect(config50.showNodeVersion).toBe(false);
      expect(config50.simplifyContext).toBe(true);
      expect(config50.simplifyModel).toBe(true);
      expect(config50.level).toBe('compact');
    });

    it('should handle boundary conditions correctly', () => {
      const config79 = getFooterDisplayConfig(79);
      expect(config79.level).toBe('compact');

      const config80 = getFooterDisplayConfig(80);
      expect(config80.level).toBe('full');
    });
  });

  describe('Integration: Display transformations', () => {
    it('should show full display for 80+ columns', () => {
      const config = getFooterDisplayConfig(100);
      const version = getShortVersion('1.0.161', config.showNodeVersion);
      const context = getContextDisplay(92, config.simplifyContext);
      const model = getShortModelName('Claude-3.5-Sonnet', config.simplifyModel);

      expect(version).toBe('v1.0.161');
      expect(context).toBe('92% ctx left');
      expect(model).toBe('Claude-3.5-Sonnet');
    });

    it('should show compact display for 60-79 columns', () => {
      const config = getFooterDisplayConfig(70);
      const version = getShortVersion('1.0.161', config.showNodeVersion);
      const context = getContextDisplay(92, config.simplifyContext);
      const model = getShortModelName('Claude-3.5-Sonnet', config.simplifyModel);

      expect(version).toBe('v1.0.161');
      expect(context).toBe('92%');
      expect(model).toBe('Sonnet');
    });

    it('should show compact display for narrow terminals', () => {
      const config = getFooterDisplayConfig(50);
      const version = getShortVersion('1.0.161', config.showNodeVersion);
      const context = getContextDisplay(92, config.simplifyContext);
      const model = getShortModelName('Gemini-2.0-Flash', config.simplifyModel);

      expect(version).toBe('v1.0.161');
      expect(context).toBe('92%');
      expect(model).toBe('Flash');
    });
  });
});

describe('getThinkingEffortLabel', () => {
  it('returns empty string when thinkingConfig is missing', () => {
    expect(getThinkingEffortLabel(undefined)).toBe('');
  });

  it('returns empty string when thinking is off', () => {
    expect(getThinkingEffortLabel({ mode: 'off' })).toBe('');
    expect(getThinkingEffortLabel({ mode: 'off', effort: 'high' })).toBe('');
  });

  // Contract: Footer.tsx relies on the empty string to skip rendering the
  // entire " 🧠 <label>" suffix (`if (!effortLabel) return null`). If this
  // ever changes (e.g. someone returns 'off' for symmetry), the footer would
  // start showing "🧠 off" — which is exactly what the user asked us to fix.
  it('off mode returns falsy so Footer skips the 🧠 prefix entirely', () => {
    const label = getThinkingEffortLabel({ mode: 'off', effort: 'max' });
    expect(label).toBe('');
    expect(Boolean(label)).toBe(false); // hard-locks the truthiness contract
  });

  it('returns "auto" when mode=auto and effort is unset / "auto"', () => {
    expect(getThinkingEffortLabel({ mode: 'auto' })).toBe('auto');
    expect(getThinkingEffortLabel({ mode: 'auto', effort: 'auto' })).toBe('auto');
  });

  it('maps explicit effort values to short labels regardless of mode', () => {
    // mode='on' + explicit effort
    expect(getThinkingEffortLabel({ mode: 'on', effort: 'max' })).toBe('max');
    expect(getThinkingEffortLabel({ mode: 'on', effort: 'xhigh' })).toBe('xhi');
    expect(getThinkingEffortLabel({ mode: 'on', effort: 'high' })).toBe('high');
    expect(getThinkingEffortLabel({ mode: 'on', effort: 'medium' })).toBe('med');
    expect(getThinkingEffortLabel({ mode: 'on', effort: 'low' })).toBe('low');
  });

  it('shows effort label even when mode=auto (effort takes precedence)', () => {
    // 历史/兼容：旧版本可能写入 {mode:'auto', effort:'high'} 这种组合，
    // 真实发到厂商的请求确实带了 reasoning_effort=high，footer 应反映这一事实。
    expect(getThinkingEffortLabel({ mode: 'auto', effort: 'max' })).toBe('max');
    expect(getThinkingEffortLabel({ mode: 'auto', effort: 'xhigh' })).toBe('xhi');
    expect(getThinkingEffortLabel({ mode: 'auto', effort: 'high' })).toBe('high');
    expect(getThinkingEffortLabel({ mode: 'auto', effort: 'medium' })).toBe('med');
    expect(getThinkingEffortLabel({ mode: 'auto', effort: 'low' })).toBe('low');
  });

  it('falls back to "on" when mode=on but effort is auto/unset', () => {
    expect(getThinkingEffortLabel({ mode: 'on' })).toBe('on');
    expect(getThinkingEffortLabel({ mode: 'on', effort: 'auto' })).toBe('on');
  });

  it('every label is at most 4 chars (so footer stays narrow)', () => {
    const labels = [
      getThinkingEffortLabel({ mode: 'on', effort: 'max' }),
      getThinkingEffortLabel({ mode: 'on', effort: 'xhigh' }),
      getThinkingEffortLabel({ mode: 'on', effort: 'high' }),
      getThinkingEffortLabel({ mode: 'on', effort: 'medium' }),
      getThinkingEffortLabel({ mode: 'on', effort: 'low' }),
      getThinkingEffortLabel({ mode: 'on' }),
      getThinkingEffortLabel({ mode: 'auto' }),
      getThinkingEffortLabel({ mode: 'auto', effort: 'high' }),
    ];
    for (const label of labels) {
      expect(label.length).toBeGreaterThan(0);
      expect(label.length).toBeLessThanOrEqual(4);
    }
  });
});
