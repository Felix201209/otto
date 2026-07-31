/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import * as db from './db.js';

export interface SkillMarketplaceRouteDeps {
  path: string;
  method: string;
  url: URL;
  req: IncomingMessage;
  res: ServerResponse;
  memberAccount: db.AccountView | null;
  readBody(req: IncomingMessage, maxLength?: number): Promise<Record<string, unknown>>;
  sendJSON(res: ServerResponse, status: number, data: unknown): void;
}

function actorFromAccount(account: db.AccountView): db.EnterpriseSkillActor {
  return {
    accountId: account.id,
    organizationId: account.organizationId,
    name: account.name,
    department: account.department,
    isAdmin: account.isAdmin,
  };
}

function statusForError(error: unknown): number {
  const message = error instanceof Error ? error.message : String(error);
  return /^(?:只有|无权|不能评价|安装并|尚未)/u.test(message) ? 403 : 400;
}

export async function handleSkillMarketplaceRoute({
  path,
  method,
  url,
  req,
  res,
  memberAccount,
  readBody,
  sendJSON,
}: SkillMarketplaceRouteDeps): Promise<boolean> {
  if (path !== '/enterprise/skills' && !path.startsWith('/enterprise/skills/')) return false;
  if (!memberAccount) {
    sendJSON(res, 401, { error: '请先登录企业账号' });
    return true;
  }
  if (!db.getOrganizationFeatures(memberAccount.organizationId).skill_market) {
    sendJSON(res, 403, { error: '企业 Skill 市场未授权或已由管理员关闭' });
    return true;
  }
  const actor = actorFromAccount(memberAccount);

  try {
    if (path === '/enterprise/skills' && method === 'GET') {
      const rawScope = url.searchParams.get('scope');
      const scope = rawScope === 'company' || rawScope === 'mine' || rawScope === 'review'
        ? rawScope
        : 'department';
      const rawSort = url.searchParams.get('sort');
      const sort = rawSort === 'rating' || rawSort === 'installs' || rawSort === 'usage' || rawSort === 'newest'
        ? rawSort
        : 'recommended';
      sendJSON(res, 200, {
        skills: db.listEnterpriseSkills(actor, {
          scope,
          sort,
          query: url.searchParams.get('q') || undefined,
        }),
      });
      return true;
    }

    if (path === '/enterprise/skills' && method === 'POST') {
      const body = await readBody(req, 400_000);
      const result = db.submitEnterpriseSkill(actor, {
        name: body.name as string,
        slug: typeof body.slug === 'string' ? body.slug : undefined,
        description: body.description as string,
        content: body.content as string,
        visibility: body.visibility === 'company' ? 'company' : 'department',
      });
      sendJSON(res, result.outcome === 'submitted' ? 201 : 200, result);
      return true;
    }

    if (path === '/enterprise/skills/leaderboard' && method === 'GET') {
      sendJSON(res, 200, db.getEnterpriseSkillLeaderboard(actor));
      return true;
    }

    const match = path.match(/^\/enterprise\/skills\/([A-Za-z0-9_-]{1,120})\/(review|install|rating|usage)$/u);
    if (!match) {
      sendJSON(res, 404, { error: 'Skill 接口不存在' });
      return true;
    }
    const [, id, action] = match;
    if (method !== 'POST') {
      sendJSON(res, 405, { error: 'Method not allowed' });
      return true;
    }

    if (action === 'review') {
      const body = await readBody(req);
      if (body.action !== 'approve' && body.action !== 'archive') {
        sendJSON(res, 400, { error: 'action must be approve or archive' });
        return true;
      }
      const skill = db.reviewEnterpriseSkill(actor, {
        id,
        action: body.action,
        visibility: body.visibility === 'company' || body.visibility === 'department'
          ? body.visibility
          : undefined,
      });
      if (!skill) sendJSON(res, 404, { error: 'Skill 不存在' });
      else sendJSON(res, 200, { skill });
      return true;
    }

    if (action === 'install') {
      const skill = db.installEnterpriseSkill(actor, id);
      if (!skill) sendJSON(res, 404, { error: 'Skill 不存在' });
      else sendJSON(res, 200, { skill });
      return true;
    }

    const body = await readBody(req);
    if (action === 'rating') {
      const skill = db.rateEnterpriseSkill(actor, id, Number(body.score));
      if (!skill) sendJSON(res, 404, { error: 'Skill 不存在' });
      else sendJSON(res, 200, { skill });
      return true;
    }

    if (typeof body.success !== 'boolean' || typeof body.eventId !== 'string') {
      sendJSON(res, 400, { error: '使用记录必须包含 success 和 eventId' });
      return true;
    }
    const skill = db.recordEnterpriseSkillUsage(
      actor,
      id,
      body.success,
      body.eventId,
    );
    if (!skill) sendJSON(res, 404, { error: 'Skill 不存在' });
    else sendJSON(res, 200, { skill });
    return true;
  } catch (error) {
    sendJSON(res, statusForError(error), {
      error: error instanceof Error ? error.message : String(error),
    });
    return true;
  }
}
