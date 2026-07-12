import { afterEach, describe, expect, it } from 'vitest';
import type { AgentStyle } from 'otto-core';
import {
  _clearLocaleCache,
  getAgentStyleShortLabel,
  translations,
} from './i18n.js';

const styles: AgentStyle[] = [
  'default',
  'codex',
  'cursor',
  'augment',
  'claude-code',
  'antigravity',
  'windsurf',
];

const labelKeys = [
  'default',
  'codex',
  'cursor',
  'augment',
  'claudeCode',
  'antigravity',
  'windsurf',
] as const;

const oldBrandPattern = /Claude|Codex|Cursor|Augment|Antigravity|Windsurf|AI Flow/i;

describe('work mode copy', () => {
  const originalLang = process.env.LANG;

  afterEach(() => {
    process.env.LANG = originalLang;
    _clearLocaleCache();
  });

  it('uses plain workplace labels in both supported locales', () => {
    for (const locale of ['en', 'zh'] as const) {
      const copy = labelKeys.flatMap((style) => [
        translations[locale][`agentStyle.style.${style}.label`],
        translations[locale][`agentStyle.style.${style}.description`],
        translations[locale][`config.option.agent.style.${style}`],
      ]);

      expect(copy).toHaveLength(21);
      expect(copy.join('\n')).not.toMatch(oldBrandPattern);
    }
  });

  it('maps legacy style ids to short English work-mode labels for compact UI', () => {
    process.env.LANG = 'en_US.UTF-8';
    _clearLocaleCache();

    expect(styles.map(getAgentStyleShortLabel)).toEqual([
      'Daily chat',
      'Fast execution',
      'Work code',
      'Engineering',
      'Direct development',
      'Enterprise office',
      'Collaborative progress',
    ]);
  });
});
