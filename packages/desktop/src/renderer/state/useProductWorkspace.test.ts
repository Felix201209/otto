/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import type { ServerToClient } from 'otto-server';
import {
  initialProductWorkspaceState,
  productWorkspaceReducer,
} from './useProductWorkspace.js';

describe('productWorkspaceReducer', () => {
  it('接收服务端脱敏工作区快照并切换模式', () => {
    const frame: ServerToClient = {
      type: 'product_workspace',
      payload: {
        schemaVersion: 1,
        context: {
          edition: 'enterprise',
          role: 'company_owner',
          userId: 'u1',
          companyId: 'c1',
          capabilities: ['agent:base', 'model:otto', 'organization:read'],
        },
        members: [],
        friends: [],
        credits: { balance: 0, frozen: 0, status: 'design-preview' },
      },
    };

    const state = productWorkspaceReducer(initialProductWorkspaceState, {
      kind: 'frame',
      frame,
    });
    expect(state.workspace?.context.edition).toBe('enterprise');
    expect(state.loading).toBe(false);
  });

  it('保存最后生成的企业链接和日程列表', () => {
    const inviteState = productWorkspaceReducer(initialProductWorkspaceState, {
      kind: 'frame',
      frame: {
        type: 'enterprise_invite_created',
        payload: {
          kind: 'position',
          link: 'otto://enterprise/join?token=abc',
          expiresAt: '2030-01-01T00:00:00.000Z',
        },
      },
    });
    const scheduleState = productWorkspaceReducer(inviteState, {
      kind: 'frame',
      frame: {
        type: 'schedules_list',
        payload: {
          date: '2026-07-12',
          timezone: 'Asia/Shanghai',
          schedules: [
            {
              id: 's1',
              title: '复盘',
              startAt: '2026-07-12T01:00:00.000Z',
              source: 'otto',
              reason: '报告完成',
              createdAt: '2026-07-11T00:00:00.000Z',
              updatedAt: '2026-07-11T00:00:00.000Z',
            },
          ],
        },
      },
    });

    expect(scheduleState.lastInvite?.kind).toBe('position');
    expect(scheduleState.schedules[0]).toMatchObject({ source: 'otto', reason: '报告完成' });
    expect(scheduleState.selectedDate).toBe('2026-07-12');
  });

  it('只接管 workspace/schedule 相关错误', () => {
    const ignored = productWorkspaceReducer(initialProductWorkspaceState, {
      kind: 'frame',
      frame: { type: 'error', payload: { code: 'busy', message: '忙' } },
    });
    const handled = productWorkspaceReducer(initialProductWorkspaceState, {
      kind: 'frame',
      frame: { type: 'error', payload: { code: 'workspace_failed', message: '无权限' } },
    });

    expect(ignored.error).toBeNull();
    expect(handled.error).toBe('无权限');
  });

  it('自动 Skill 候选只接收服务端脱敏字段和明确处理结果', () => {
    const state = productWorkspaceReducer(initialProductWorkspaceState, {
      kind: 'frame',
      frame: {
        type: 'pending_auto_skills',
        payload: {
          candidates: [{
            id: 'c1',
            name: 'auto-report',
            description: '重复报告流程',
            detectedPattern: '整理数据 → 生成报告',
            occurrenceCount: 3,
            reason: '连续三天出现',
          }],
          lastAction: {
            kind: 'confirmed',
            candidateId: 'old-candidate',
            savedPath: '/tmp/skill/SKILL.md',
          },
        },
      },
    });

    expect(state.pendingAutoSkills).toHaveLength(1);
    expect(state.lastAutoSkillAction).toMatchObject({ kind: 'confirmed' });
  });
});
