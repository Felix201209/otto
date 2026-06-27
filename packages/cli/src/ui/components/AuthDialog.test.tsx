/**
 * @license
 * Copyright 2026 Felix
 * SPDX-License-Identifier: Apache-2.0
 */


import { render } from 'ink-testing-library';
import { AuthType } from 'otto-core';
import stripAnsi from 'strip-ansi';
import { afterEach,beforeEach,describe,expect,it,vi } from 'vitest';
import { LoadedSettings } from '../../config/settings.js';
import { AuthDialog } from './AuthDialog.js';

describe('AuthDialog', () => {
  const wait = (ms = 50) => new Promise((resolve) => setTimeout(resolve, ms));

  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    originalEnv = { ...process.env };
    process.env.OTTO_DEFAULT_AUTH_TYPE = '';
    vi.clearAllMocks();
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('should show an error if the initial auth type is invalid', () => {
    const settings: LoadedSettings = new LoadedSettings(
      {
        settings: { customThemes: {}, mcpServers: {} },
        path: '',
      },
      {
        settings: {
          selectedAuthType: AuthType.LOGIN_WITH_GOOGLE,
        },
        path: '',
      },
      {
        settings: { customThemes: {}, mcpServers: {} },
        path: '',
      },
      [],
    );

    const { lastFrame } = render(
      <AuthDialog
        onSelect={() => {}}
        settings={settings}
        initialErrorMessage="Initial error message"
      />,
    );

    expect(stripAnsi(lastFrame())).toContain(
      'Initial error message',
    );
  });

  describe('OTTO_DEFAULT_AUTH_TYPE environment variable', () => {
    it('should select the auth type specified by OTTO_DEFAULT_AUTH_TYPE', () => {
      process.env.OTTO_DEFAULT_AUTH_TYPE = AuthType.USE_PROXY_AUTH;

      const settings: LoadedSettings = new LoadedSettings(
        {
          settings: {
            selectedAuthType: undefined,
            customThemes: {},
            mcpServers: {},
          },
          path: '',
        },
        {
          settings: { customThemes: {}, mcpServers: {} },
          path: '',
        },
        {
          settings: { customThemes: {}, mcpServers: {} },
          path: '',
        },
        [],
      );

      const { lastFrame } = render(
        <AuthDialog onSelect={() => {}} settings={settings} />,
      );

      // Cloud login removed: only the custom-model option is offered.
      expect(stripAnsi(lastFrame())).toContain('• 1. Use Custom Model (no login required)');
    });

    it('should fall back to default if OTTO_DEFAULT_AUTH_TYPE is not set', () => {
      const settings: LoadedSettings = new LoadedSettings(
        {
          settings: {
            selectedAuthType: undefined,
            customThemes: {},
            mcpServers: {},
          },
          path: '',
        },
        {
          settings: { customThemes: {}, mcpServers: {} },
          path: '',
        },
        {
          settings: { customThemes: {}, mcpServers: {} },
          path: '',
        },
        [],
      );

      const { lastFrame } = render(
        <AuthDialog onSelect={() => {}} settings={settings} />,
      );

      // Default (and only) option is the custom model.
      expect(stripAnsi(lastFrame())).toContain('• 1. Use Custom Model (no login required)');
    });

    it('should show an error and fall back to default if OTTO_DEFAULT_AUTH_TYPE is invalid', () => {
      process.env.OTTO_DEFAULT_AUTH_TYPE = 'invalid-auth-type';

      const settings: LoadedSettings = new LoadedSettings(
        {
          settings: {
            selectedAuthType: undefined,
            customThemes: {},
            mcpServers: {},
          },
          path: '',
        },
        {
          settings: { customThemes: {}, mcpServers: {} },
          path: '',
        },
        {
          settings: { customThemes: {}, mcpServers: {} },
          path: '',
        },
        [],
      );

      const { lastFrame } = render(
        <AuthDialog onSelect={() => {}} settings={settings} />,
      );

      expect(stripAnsi(lastFrame())).toContain(
        'Invalid value for OTTO_DEFAULT_AUTH_TYPE: "invalid-auth-type"',
      );

      // Default (and only) option is the custom model.
      expect(stripAnsi(lastFrame())).toContain('• 1. Use Custom Model (no login required)');
    });
  });

  it('should prevent exiting when no auth method is selected and show error message', async () => {
    const onSelect = vi.fn();
    const settings: LoadedSettings = new LoadedSettings(
      {
        settings: { customThemes: {}, mcpServers: {} },
        path: '',
      },
      {
        settings: {
          selectedAuthType: undefined,
          customThemes: {},
          mcpServers: {},
        },
        path: '',
      },
      {
        settings: { customThemes: {}, mcpServers: {} },
        path: '',
      },
      [],
    );

    const { lastFrame, stdin, unmount } = render(
      <AuthDialog onSelect={onSelect} settings={settings} />,
    );
    await wait();

    // Simulate pressing escape key
    stdin.write('\u001b'); // ESC key
    await wait(200);

    // Should show error message instead of calling onSelect
    const frame = stripAnsi(lastFrame());
    expect(frame).toContain(
      'You must select an auth method to proceed. Press Ctrl+C twice to exit.',
    );
    expect(onSelect).not.toHaveBeenCalled();
    unmount();
  });

  it('should not exit if there is already an error message', async () => {
    const onSelect = vi.fn();
    const settings: LoadedSettings = new LoadedSettings(
      {
        settings: { customThemes: {}, mcpServers: {} },
        path: '',
      },
      {
        settings: {
          selectedAuthType: undefined,
          customThemes: {},
          mcpServers: {},
        },
        path: '',
      },
      {
        settings: { customThemes: {}, mcpServers: {} },
        path: '',
      },
      [],
    );

    const { lastFrame, stdin, unmount } = render(
      <AuthDialog
        onSelect={onSelect}
        settings={settings}
        initialErrorMessage="Initial error"
      />,
    );
    await wait();

    expect(stripAnsi(lastFrame())).toContain('Initial error');

    // Simulate pressing escape key
    stdin.write('\u001b'); // ESC key
    await wait();

    // Should not call onSelect
    expect(onSelect).not.toHaveBeenCalled();
    unmount();
  });

  it('should allow exiting when auth method is already selected', async () => {
    const onSelect = vi.fn();
    const settings: LoadedSettings = new LoadedSettings(
      {
        settings: { customThemes: {}, mcpServers: {} },
        path: '',
      },
      {
        settings: {
          selectedAuthType: AuthType.USE_PROXY_AUTH,
          customThemes: {},
          mcpServers: {},
        },
        path: '',
      },
      {
        settings: { customThemes: {}, mcpServers: {} },
        path: '',
      },
      [],
    );

    const { lastFrame: _lastFrame, stdin, unmount } = render(
      <AuthDialog onSelect={onSelect} settings={settings} />,
    );
    await wait();

    // Simulate pressing escape key
    stdin.write('\u001b'); // ESC key
    await wait();

    // Should call onSelect with undefined to exit
    expect(onSelect).toHaveBeenCalledWith(undefined, 'User');
    unmount();
  });
});
