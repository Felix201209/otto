/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 *
 * 个人/企业模式、组织、好友、积分和本地日程的 renderer 状态。
 * 服务端是唯一事实源；本 hook 不向 localStorage 复制企业身份。
 */

import { useEffect, useMemo, useReducer } from 'react';
import type {
  AutoSkillCandidateInfo,
  ProductWorkspaceSnapshot,
  ScheduleItemInfo,
  ServerToClient,
} from 'otto-server';
import * as transport from '../transport.js';

export interface ProductWorkspaceState {
  workspace: ProductWorkspaceSnapshot | null;
  schedules: ScheduleItemInfo[];
  pendingAutoSkills: AutoSkillCandidateInfo[];
  lastAutoSkillAction: {
    kind: 'confirmed' | 'rejected';
    candidateId: string;
    savedPath?: string;
  } | null;
  selectedDate: string | null;
  lastInvite: {
    kind: 'position' | 'company' | 'company_link';
    link: string;
    expiresAt: string;
  } | null;
  loading: boolean;
  error: string | null;
}

export const initialProductWorkspaceState: ProductWorkspaceState = {
  workspace: null,
  schedules: [],
  pendingAutoSkills: [],
  lastAutoSkillAction: null,
  selectedDate: null,
  lastInvite: null,
  loading: true,
  error: null,
};

export type ProductWorkspaceAction =
  | { kind: 'frame'; frame: ServerToClient }
  | { kind: 'select_date'; date: string }
  | { kind: 'clear_invite' }
  | { kind: 'clear_error' };

export function productWorkspaceReducer(
  state: ProductWorkspaceState,
  action: ProductWorkspaceAction,
): ProductWorkspaceState {
  if (action.kind === 'select_date') {
    return { ...state, selectedDate: action.date };
  }
  if (action.kind === 'clear_invite') return { ...state, lastInvite: null };
  if (action.kind === 'clear_error') return { ...state, error: null };
  const frame = action.frame;
  if (frame.type === 'product_workspace') {
    return { ...state, workspace: frame.payload, loading: false, error: null };
  }
  if (frame.type === 'enterprise_invite_created') {
    return { ...state, lastInvite: frame.payload, error: null };
  }
  if (frame.type === 'schedules_list') {
    return {
      ...state,
      schedules: frame.payload.schedules,
      selectedDate: frame.payload.date ?? state.selectedDate,
      error: null,
    };
  }
  if (frame.type === 'pending_auto_skills') {
    return {
      ...state,
      pendingAutoSkills: frame.payload.candidates,
      lastAutoSkillAction: frame.payload.lastAction ?? null,
      error: null,
    };
  }
  if (
    frame.type === 'error' &&
    (frame.payload.code === 'workspace_failed' ||
      frame.payload.code === 'schedule_failed' ||
      frame.payload.code === 'forbidden_by_edition' ||
      frame.payload.code === 'auto_skill_failed')
  ) {
    return { ...state, loading: false, error: frame.payload.message };
  }
  return state;
}

export interface ProductWorkspaceActions {
  refresh(): void;
  configureEnterprise(input: {
    managerName: string;
    companyName: string;
    industry?: string;
    employeeScale?: string;
  }): void;
  switchToPersonal(): void;
  joinEnterprise(link: string, userId: string, displayName: string): void;
  createInvite(input:
    | { kind: 'position'; departmentId: string; positionId: string; expiresInSeconds?: number }
    | { kind: 'company'; expiresInSeconds?: number }
    | {
        kind: 'company_link';
        direction: 'parent_invites_child' | 'child_requests_parent';
        targetCompanyId?: string;
        expiresInSeconds?: number;
      }): void;
  acceptCompanyLink(link: string): void;
  addFriend(displayName: string, note?: string): void;
  refreshPendingAutoSkills(): void;
  confirmPendingAutoSkill(candidateId: string): void;
  rejectPendingAutoSkill(candidateId: string): void;
  selectDate(date: string, timezone?: string): void;
  refreshSchedules(date?: string, timezone?: string): void;
  createSchedule(input: {
    title: string;
    startAt: string;
    endAt?: string;
    notes?: string;
    reason?: string;
  }): void;
  updateSchedule(input: {
    id: string;
    title?: string;
    startAt?: string;
    endAt?: string | null;
    notes?: string | null;
    reason?: string | null;
  }): void;
  deleteSchedule(id: string): void;
  clearInvite(): void;
  clearError(): void;
}

export interface UseProductWorkspace {
  state: ProductWorkspaceState;
  actions: ProductWorkspaceActions;
}

export function useProductWorkspace(): UseProductWorkspace {
  const [state, dispatch] = useReducer(
    productWorkspaceReducer,
    initialProductWorkspaceState,
  );

  useEffect(() => {
    const off = transport.onFrame((frame) => dispatch({ kind: 'frame', frame }));
    transport.send({ type: 'get_product_workspace', payload: {} });
    transport.send({ type: 'get_schedules', payload: {} });
    transport.send({ type: 'get_pending_auto_skills', payload: {} });
    return off;
  }, []);

  const actions = useMemo<ProductWorkspaceActions>(() => ({
    refresh: () => transport.send({ type: 'get_product_workspace', payload: {} }),
    configureEnterprise: (input) =>
      transport.send({ type: 'configure_enterprise', payload: input }),
    switchToPersonal: () => transport.send({ type: 'switch_to_personal', payload: {} }),
    joinEnterprise: (link, userId, displayName) =>
      transport.send({
        type: 'join_enterprise',
        payload: { link: link.trim(), userId: userId.trim(), displayName: displayName.trim() },
      }),
    createInvite: (input) =>
      transport.send({ type: 'create_enterprise_invite', payload: input }),
    acceptCompanyLink: (link) =>
      transport.send({ type: 'accept_company_link', payload: { link: link.trim() } }),
    addFriend: (displayName, note) =>
      transport.send({
        type: 'add_friend',
        payload: { displayName: displayName.trim(), ...(note?.trim() ? { note: note.trim() } : {}) },
      }),
    refreshPendingAutoSkills: () =>
      transport.send({ type: 'get_pending_auto_skills', payload: {} }),
    confirmPendingAutoSkill: (candidateId) =>
      transport.send({ type: 'confirm_pending_auto_skill', payload: { candidateId } }),
    rejectPendingAutoSkill: (candidateId) =>
      transport.send({ type: 'reject_pending_auto_skill', payload: { candidateId } }),
    selectDate: (date, timezone) => {
      dispatch({ kind: 'select_date', date });
      transport.send({
        type: 'get_schedules',
        payload: { date, ...(timezone ? { timezone } : {}) },
      });
    },
    refreshSchedules: (date, timezone) =>
      transport.send({
        type: 'get_schedules',
        payload: { ...(date ? { date } : {}), ...(timezone ? { timezone } : {}) },
      }),
    createSchedule: (input) => transport.send({ type: 'create_schedule', payload: input }),
    updateSchedule: (input) => transport.send({ type: 'update_schedule', payload: input }),
    deleteSchedule: (id) => transport.send({ type: 'delete_schedule', payload: { id } }),
    clearInvite: () => dispatch({ kind: 'clear_invite' }),
    clearError: () => dispatch({ kind: 'clear_error' }),
  }), []);

  return { state, actions };
}
