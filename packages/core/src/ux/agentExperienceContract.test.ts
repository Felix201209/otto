/**
 * @license
 * Copyright 2026 Felix
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  describeToolAvailability,
  shouldShowUnreadDot,
  summarizeAgentActivity,
} from './agentExperienceContract.js';

describe('agentExperienceContract', () => {
  it('describes lazy-registered main-agent tools as ready rather than delayed', () => {
    expect(
      describeToolAvailability({
        surface: 'main-agent',
        toolName: 'ppt_generate',
        registered: true,
        lazyRegistered: true,
      }),
    ).toEqual({
      visible: true,
      label: 'Ready',
      detail: 'Loaded during session setup so the user can invoke it without a first-use delay.',
    });
  });

  it('explains lightweight sub-agent omissions without implying the product lost the tool', () => {
    const message = describeToolAvailability({
      surface: 'sub-agent',
      toolName: 'ppt_generate',
      registered: false,
      intentionallyHidden: true,
    });

    expect(message.visible).toBe(false);
    expect(message.detail).toContain('lightweight sub-agent profile');
  });

  it('summarizes sub-agent activity in user-friendly terms', () => {
    expect(summarizeAgentActivity('running_subagents', 3)).toBe('Working with 3 sub-agents');
    expect(summarizeAgentActivity('waiting_for_user')).toBe('Needs your input');
    expect(summarizeAgentActivity('failed')).toBe('Needs attention');
  });

  it('shows unread dots for background agent/external updates but not focused sessions', () => {
    expect(shouldShowUnreadDot({ source: 'agent', sessionFocused: false })).toBe(true);
    expect(shouldShowUnreadDot({ source: 'external', sessionFocused: false })).toBe(true);
    expect(shouldShowUnreadDot({ source: 'system', sessionFocused: false, requiresUserAction: true })).toBe(true);
    expect(shouldShowUnreadDot({ source: 'agent', sessionFocused: true })).toBe(false);
    expect(shouldShowUnreadDot({ source: 'system', sessionFocused: false })).toBe(false);
  });
});
