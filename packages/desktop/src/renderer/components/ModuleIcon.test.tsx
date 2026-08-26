import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import {
  MODULE_LINE_ICON_KEYS,
  ModuleIcon,
  hasModuleIcon,
} from './ModuleIcon.js';

describe('ModuleIcon', () => {
  it('resolves every local module icon key to its own registry entry', () => {
    expect(new Set(MODULE_LINE_ICON_KEYS).size).toBe(MODULE_LINE_ICON_KEYS.length);
    for (const icon of MODULE_LINE_ICON_KEYS) {
      expect(hasModuleIcon(icon)).toBe(true);
    }
  });

  it('renders local, generated, Otto, and custom-agent avatar forms', () => {
    const view = render(
      <>
        <ModuleIcon icon="park-announcement" label="园区公告" />
        <ModuleIcon icon="generated:expert-presentation" label="PPT 创作专家" />
        <ModuleIcon icon="otto-avatar" label="Otto" />
        <ModuleIcon icon="custom-agent" label="招投标助手" />
      </>,
    );

    expect(view.container.querySelector('[data-module-icon="park-announcement"]')).not.toBeNull();
    expect(view.container.querySelector('[data-module-icon="generated:expert-presentation"] img')).not.toBeNull();
    expect(view.container.querySelector('[data-module-icon="otto-avatar"]')).not.toBeNull();
    expect(view.container.querySelector('[data-module-icon="custom-agent"]')?.textContent).toBe('招');
  });

  it('rejects unknown registry keys', () => {
    expect(hasModuleIcon('not-a-real-icon')).toBe(false);
  });
});
