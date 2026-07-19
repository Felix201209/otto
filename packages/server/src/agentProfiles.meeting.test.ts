/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { resolveAgentProfile } from './agentProfiles.js';

describe('meeting agent profile', () => {
  it('injects meeting scheduler and notes skills at runtime', () => {
    expect(resolveAgentProfile('meeting')).toMatchObject({
      skills: ['meeting-scheduler', 'meeting-notes'],
      embeddedSkills: ['meeting-scheduler', 'meeting-notes'],
    });
  });
});
