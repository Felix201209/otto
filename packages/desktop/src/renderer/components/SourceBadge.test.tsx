/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { SourceBadge } from './SourceBadge.js';

afterEach(cleanup);

describe('SourceBadge', () => {
  it.each([
    ['feishu', '飞书'],
    ['atoa', '企业协作'],
    ['enterprise', '企业通知'],
    ['park', '园区服务'],
    ['local', '本地'],
  ] as const)(
    'renders %s messages with the expected user-facing source',
    (source, label) => {
      render(<SourceBadge source={source} />);
      expect(screen.getByText(label)).toBeTruthy();
    },
  );
});
