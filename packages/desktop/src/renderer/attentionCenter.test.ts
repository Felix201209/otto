/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';

import { computeAttentionSummary, computeNavBadgeCounts } from './attentionCenter.js';

describe('federation unread attention', () => {
  it('counts federated and local private messages once in the inbox badge', () => {
    const counts = {
      'enterprise:message:local-account': 2,
      'enterprise:federation:remote-contact': 3,
    };

    expect(computeNavBadgeCounts(counts, null, [
      'enterprise:federation:remote-contact',
    ])).toEqual({
      inboxUnread: 5,
      workUnread: 0,
      globalUnread: 5,
    });
    expect(computeAttentionSummary({ enterpriseUnreadCounts: counts })).toMatchObject({
      totalCount: 5,
      byKind: { 'direct-message': 5 },
      items: expect.arrayContaining([
        expect.objectContaining({
          sessionId: 'enterprise:federation:remote-contact',
          count: 3,
        }),
      ]),
    });
  });
});
