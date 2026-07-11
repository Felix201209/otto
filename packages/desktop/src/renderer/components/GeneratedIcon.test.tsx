/**
 * @license Copyright 2026 Felix SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { GENERATED_ICON_NAMES, GeneratedIcon } from './GeneratedIcon.js';

describe('GeneratedIcon', () => {
  it('完整注册 20 个唯一的 imagegen 图标，并都能渲染为 PNG 图片', () => {
    expect(GENERATED_ICON_NAMES).toHaveLength(20);
    expect(new Set(GENERATED_ICON_NAMES).size).toBe(20);

    const { container } = render(
      <>
        {GENERATED_ICON_NAMES.map((name) => (
          <GeneratedIcon key={name} name={name} size={24} />
        ))}
      </>,
    );

    const images = Array.from(container.querySelectorAll('img'));
    expect(images).toHaveLength(20);
    expect(images.every((image) => image.getAttribute('src')?.includes('.png'))).toBe(true);
    expect(images.every((image) => image.getAttribute('aria-hidden') === 'true')).toBe(true);
  });
});
