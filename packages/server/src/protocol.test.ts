/**
 * @license
 * Copyright 2025 Otto
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * 协议守卫与常量单测。isClientToServer 是 WS 入站第一道闸，边界必须全覆盖。
 */

import { describe, it, expect } from 'vitest';
import {
  isClientToServer,
  validateClientPayload,
  frame,
  HTTP_ROUTES,
  PROTOCOL_VERSION,
  DEFAULT_PORT,
  DEFAULT_HOST,
  type ServerToClient,
} from './protocol.js';

describe('isClientToServer 守卫', () => {
  it('合法 {type,payload} → true', () => {
    expect(isClientToServer({ type: 'list_sessions', payload: {} })).toBe(true);
    expect(
      isClientToServer({ type: 'subscribe', payload: { sessionId: 'x' } }),
    ).toBe(true);
  });

  it('null / undefined → false', () => {
    expect(isClientToServer(null)).toBe(false);
    expect(isClientToServer(undefined)).toBe(false);
  });

  it('字符串 / 数字 / 数组 → false', () => {
    expect(isClientToServer('hello')).toBe(false);
    expect(isClientToServer(42)).toBe(false);
    // 数组是 object，但其 .type 为 undefined（非 string），故守卫判 false。
    expect(isClientToServer([{ type: 'x', payload: {} }])).toBe(false);
    expect(isClientToServer(['a', 'b'])).toBe(false);
    expect(isClientToServer([])).toBe(false);
  });

  it('缺 type → false', () => {
    expect(isClientToServer({ payload: {} })).toBe(false);
  });

  it('缺 payload → false', () => {
    expect(isClientToServer({ type: 'list_sessions' })).toBe(false);
  });

  it('type 非 string → false', () => {
    expect(isClientToServer({ type: 123, payload: {} })).toBe(false);
    expect(isClientToServer({ type: null, payload: {} })).toBe(false);
  });
});

describe('validateClientPayload 形状校验（第二道闸）', () => {
  it('合法 send_user_message → null（通过）', () => {
    expect(
      validateClientPayload({
        type: 'send_user_message',
        payload: {
          sessionId: 's1',
          content: [{ type: 'text', value: 'hi' }],
          source: 'local',
        },
      }),
    ).toBeNull();
  });

  it('客户端不得伪造 feishu 来源（飞书消息只允许由服务端适配器注入）', () => {
    expect(
      validateClientPayload({
        type: 'send_user_message',
        payload: {
          sessionId: 's1',
          content: [{ type: 'text', value: 'hi' }],
          source: 'feishu',
        },
      }),
    ).toContain('feishu');
  });

  it('send_user_message：content 传字符串 / null / 对象 → 拒绝', () => {
    for (const content of ['不是数组', null, { type: 'text', value: 'x' }]) {
      expect(
        validateClientPayload({
          type: 'send_user_message',
          payload: { sessionId: 's1', content, source: 'local' },
        }),
      ).not.toBeNull();
    }
  });

  it('send_user_message：content 数组内片段畸形 → 拒绝', () => {
    expect(
      validateClientPayload({
        type: 'send_user_message',
        payload: {
          sessionId: 's1',
          content: [{ type: 'text', value: 42 }],
          source: 'local',
        },
      }),
    ).not.toBeNull();
    expect(
      validateClientPayload({
        type: 'send_user_message',
        payload: { sessionId: 's1', content: [null], source: 'local' },
      }),
    ).not.toBeNull();
  });

  it('send_user_message：sessionId 空 / source 非法 → 拒绝', () => {
    expect(
      validateClientPayload({
        type: 'send_user_message',
        payload: {
          sessionId: '',
          content: [{ type: 'text', value: 'x' }],
          source: 'local',
        },
      }),
    ).not.toBeNull();
    expect(
      validateClientPayload({
        type: 'send_user_message',
        payload: {
          sessionId: 's1',
          content: [{ type: 'text', value: 'x' }],
          source: 'evil',
        },
      }),
    ).not.toBeNull();
  });

  it('未知 type → 拒绝', () => {
    expect(
      validateClientPayload({ type: 'nope_type', payload: {} }),
    ).not.toBeNull();
  });

  it('subscribe / cancel / set_model：sessionId 缺失或非字符串 → 拒绝', () => {
    expect(
      validateClientPayload({ type: 'subscribe', payload: {} }),
    ).not.toBeNull();
    expect(
      validateClientPayload({ type: 'cancel', payload: { sessionId: 1 } }),
    ).not.toBeNull();
    expect(
      validateClientPayload({
        type: 'set_model',
        payload: { sessionId: 's1' },
      }),
    ).not.toBeNull();
    expect(
      validateClientPayload({
        type: 'set_model',
        payload: { sessionId: 's1', model: 'm1' },
      }),
    ).toBeNull();
  });

  it('save_custom_model：必填字段缺失 → 拒绝；齐全 → 通过', () => {
    expect(
      validateClientPayload({
        type: 'save_custom_model',
        payload: { baseUrl: 'https://x', apiKey: 'k', modelId: 'm' },
      }),
    ).not.toBeNull();
    expect(
      validateClientPayload({
        type: 'save_custom_model',
        payload: {
          provider: 'openai',
          baseUrl: 'https://x',
          apiKey: 'k',
          modelId: 'm',
        },
      }),
    ).toBeNull();
    expect(
      validateClientPayload({
        type: 'save_custom_model',
        payload: {
          provider: 'openai',
          baseUrl: 'https://x',
          apiKey: '',
          modelId: 'm',
          replaceId: 'custom:openai:old@abc',
        },
      }),
    ).toBeNull();
    expect(
      validateClientPayload({
        type: 'save_custom_model',
        payload: {
          provider: 'openai',
          baseUrl: 'https://x',
          apiKey: '',
          modelId: 'm',
          replaceId: 123,
        },
      }),
    ).not.toBeNull();
  });

  it('delete_session：sessionId 缺失 → 拒绝；齐全 → 通过', () => {
    expect(
      validateClientPayload({ type: 'delete_session', payload: {} }),
    ).not.toBeNull();
    expect(
      validateClientPayload({
        type: 'delete_session',
        payload: { sessionId: 's1' },
      }),
    ).toBeNull();
  });

  it('rename_session：sessionId/title 校验（空白 title 拒绝，齐全通过）', () => {
    // sessionId 缺失
    expect(
      validateClientPayload({
        type: 'rename_session',
        payload: { title: '新名' },
      }),
    ).not.toBeNull();
    // title 非字符串
    expect(
      validateClientPayload({
        type: 'rename_session',
        payload: { sessionId: 's1', title: 42 },
      }),
    ).not.toBeNull();
    // title 纯空白
    expect(
      validateClientPayload({
        type: 'rename_session',
        payload: { sessionId: 's1', title: '   ' },
      }),
    ).not.toBeNull();
    // 齐全通过
    expect(
      validateClientPayload({
        type: 'rename_session',
        payload: { sessionId: 's1', title: '新名' },
      }),
    ).toBeNull();
  });

  it('payload 非对象（null / 字符串）→ 拒绝', () => {
    expect(
      validateClientPayload({ type: 'list_sessions', payload: null }),
    ).not.toBeNull();
    expect(
      validateClientPayload({ type: 'get_history', payload: 'x' }),
    ).not.toBeNull();
  });

  it('v1.7 企业关联和自动 Skill 操作只接受非空链接/候选 ID', () => {
    expect(validateClientPayload({
      type: 'accept_company_link',
      payload: { link: 'otto://enterprise/join?token=abc' },
    })).toBeNull();
    expect(validateClientPayload({
      type: 'accept_company_link',
      payload: { link: '' },
    })).not.toBeNull();
    expect(validateClientPayload({
      type: 'get_pending_auto_skills',
      payload: {},
    })).toBeNull();
    for (const type of ['confirm_pending_auto_skill', 'reject_pending_auto_skill']) {
      expect(validateClientPayload({ type, payload: { candidateId: 'candidate-1' } })).toBeNull();
      expect(validateClientPayload({ type, payload: { candidateId: '' } })).not.toBeNull();
    }
  });
});

describe('frame 构造器', () => {
  it('恒等返回入参', () => {
    const f: ServerToClient = {
      type: 'welcome',
      payload: { protocolVersion: '1', serverVersion: '0.1.0' },
    };
    expect(frame(f)).toBe(f);
  });
});

describe('HTTP_ROUTES 与常量', () => {
  it('sessionHistory 拼串正确', () => {
    expect(HTTP_ROUTES.sessionHistory('abc')).toBe('/sessions/abc/history');
  });

  it('静态路由值', () => {
    expect(HTTP_ROUTES.health).toBe('/health');
    expect(HTTP_ROUTES.sessions).toBe('/sessions');
    expect(HTTP_ROUTES.models).toBe('/models');
    expect(HTTP_ROUTES.ws).toBe('/ws');
  });

  it('PROTOCOL_VERSION / DEFAULT_PORT / DEFAULT_HOST 冒烟', () => {
    expect(PROTOCOL_VERSION).toBe('1');
    expect(DEFAULT_PORT).toBe(7637);
    expect(DEFAULT_HOST).toBe('127.0.0.1');
  });
});

describe('validateClientPayload：斜杠命令帧（P3）', () => {
  it('run_slash_command 合法 payload 通过', () => {
    expect(
      validateClientPayload({
        type: 'run_slash_command',
        payload: { sessionId: 's1', name: 'kb', args: 'search 报销' },
      }),
    ).toBeNull();
    // args 可省略
    expect(
      validateClientPayload({
        type: 'run_slash_command',
        payload: { sessionId: 's1', name: 'about' },
      }),
    ).toBeNull();
  });

  it('run_slash_command 缺 sessionId / name、args 非法 → 拒绝', () => {
    expect(
      validateClientPayload({
        type: 'run_slash_command',
        payload: { name: 'kb' },
      }),
    ).toContain('sessionId');
    expect(
      validateClientPayload({
        type: 'run_slash_command',
        payload: { sessionId: 's1', name: '' },
      }),
    ).toContain('name');
    expect(
      validateClientPayload({
        type: 'run_slash_command',
        payload: { sessionId: 's1', name: 'kb', args: 42 },
      }),
    ).toContain('args');
  });

  it('list_slash_commands 空对象 payload 通过，非对象拒绝', () => {
    expect(
      validateClientPayload({ type: 'list_slash_commands', payload: {} }),
    ).toBeNull();
    expect(
      validateClientPayload({ type: 'list_slash_commands', payload: null }),
    ).not.toBeNull();
  });
});

describe('validateClientPayload：执行授权', () => {
  it('只接受合法 mode 与 scope', () => {
    expect(validateClientPayload({
      type: 'set_authorization_mode',
      payload: { sessionId: 's1', mode: 'auto', scope: 'session' },
    })).toBeNull();
    expect(validateClientPayload({
      type: 'set_authorization_mode',
      payload: { sessionId: 's1', mode: 'yolo', scope: 'all' },
    })).toContain('mode');
    expect(validateClientPayload({
      type: 'set_authorization_mode',
      payload: { sessionId: 's1', mode: 'manual', scope: 'forever' },
    })).toContain('scope');
  });
});

describe('validateClientPayload：v1.7 产品工作区', () => {
  it('create_session 只接受字符串 agentProfileId', () => {
    expect(validateClientPayload({
      type: 'create_session',
      payload: { title: '会议', agentProfileId: 'meeting-initiator' },
    })).toBeNull();
    expect(validateClientPayload({
      type: 'create_session',
      payload: { title: '会议', agentProfileId: { systemPrompt: 'evil' } },
    })).toContain('agentProfileId');
  });

  it('管理者建档和加入企业严格校验必填字段', () => {
    expect(validateClientPayload({
      type: 'configure_enterprise',
      payload: { managerName: '陈晨', companyName: '北辰科技', industry: '企业软件' },
    })).toBeNull();
    expect(validateClientPayload({
      type: 'configure_enterprise',
      payload: { managerName: '', companyName: '北辰科技' },
    })).toContain('managerName');
    expect(validateClientPayload({
      type: 'join_enterprise',
      payload: { link: 'otto://enterprise/join?x=1', userId: 'u1', displayName: '林一' },
    })).toBeNull();
    expect(validateClientPayload({
      type: 'join_enterprise',
      payload: { link: '', userId: 'u1', displayName: '林一' },
    })).toContain('link');
  });

  it('企业邀请按 kind 校验职位或父子公司参数', () => {
    expect(validateClientPayload({
      type: 'create_enterprise_invite',
      payload: { kind: 'position', departmentId: 'd1', positionId: 'p1' },
    })).toBeNull();
    expect(validateClientPayload({
      type: 'create_enterprise_invite',
      payload: { kind: 'position', departmentId: 'd1' },
    })).toContain('positionId');
    expect(validateClientPayload({
      type: 'create_enterprise_invite',
      payload: { kind: 'company_link', direction: 'parent_invites_child' },
    })).toBeNull();
  });

  it('本地日程帧校验 action 所需字段', () => {
    expect(validateClientPayload({
      type: 'create_schedule',
      payload: { title: '复盘', startAt: '2026-07-12T09:00:00+08:00' },
    })).toBeNull();
    expect(validateClientPayload({
      type: 'create_schedule',
      payload: { title: '', startAt: 'bad' },
    })).toContain('title');
    expect(validateClientPayload({
      type: 'get_schedules',
      payload: { date: '2026-07-12', timezone: 'Asia/Shanghai' },
    })).toBeNull();
    expect(validateClientPayload({
      type: 'delete_schedule',
      payload: { id: '' },
    })).toContain('id');
  });
});
