/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import { LocalTaskRegistry } from './localTaskRegistry.js';

describe('LocalTaskRegistry', () => {
  it('cancels every local task once and resumes only tasks cancelled by suspend', async () => {
    const registry = new LocalTaskRegistry();
    const cancelWorkflow = vi.fn();
    const resumeWorkflow = vi.fn();
    const cancelRpa = vi.fn();

    registry.register({
      id: 'workflow-runtime',
      kind: 'workflow',
      cancel: cancelWorkflow,
      resume: resumeWorkflow,
    });
    registry.register({ id: 'rpa-runtime', kind: 'rpa', cancel: cancelRpa });

    await Promise.all([
      registry.cancelAll('desktop_hidden'),
      registry.cancelAll('desktop_hidden'),
    ]);

    expect(cancelWorkflow).toHaveBeenCalledTimes(1);
    expect(cancelRpa).toHaveBeenCalledTimes(1);

    await Promise.all([registry.resumeAll(), registry.resumeAll()]);
    expect(resumeWorkflow).toHaveBeenCalledTimes(1);
    await registry.resumeAll();
    expect(resumeWorkflow).toHaveBeenCalledTimes(1);
  });

  it('cancels a task registered during an in-flight suspend before resume', async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const registry = new LocalTaskRegistry();
    registry.register({
      id: 'blocked',
      kind: 'workflow',
      cancel: () => blocked,
    });

    const cancelling = registry.cancelAll('desktop_hidden');
    const cancelLateRpa = vi.fn();
    registry.register({
      id: 'late-rpa',
      kind: 'rpa',
      cancel: cancelLateRpa,
    });
    expect(cancelLateRpa).toHaveBeenCalledTimes(1);

    const resuming = registry.resumeAll();
    release();
    await cancelling;
    await resuming;
    expect(registry.isSuspended()).toBe(false);
  });

  it('preserves the Feishu background exception and emits one audit event per suspend', async () => {
    const audit = vi.fn();
    const registry = new LocalTaskRegistry({ audit });
    const cancelFeishu = vi.fn();
    registry.register({
      id: 'feishu-gateway',
      kind: 'feishu',
      desktopSuspendPolicy: 'preserve',
      cancel: cancelFeishu,
    });

    await registry.cancelAll('desktop_hidden');
    await registry.cancelAll('desktop_hidden');

    expect(cancelFeishu).not.toHaveBeenCalled();
    expect(audit).toHaveBeenCalledTimes(1);
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({
      taskId: 'feishu-gateway',
      outcome: 'preserved',
    }));

    await registry.cancelAll('server_shutdown', { includePreserved: true });
    expect(cancelFeishu).toHaveBeenCalledTimes(1);
  });
});
