import type { IncomingMessage, ServerResponse } from 'node:http';
import * as db from './db.js';

export type ParkStatisticsRouteAdminPrincipal =
  | { kind: 'system'; organizationId: string }
  | { kind: 'account'; organizationId: string; account: db.AccountView };

export interface ParkStatisticsRouteDeps {
  path: string;
  method: string;
  req: IncomingMessage;
  res: ServerResponse;
  memberAccount: db.AccountView | null;
  adminPrincipal: ParkStatisticsRouteAdminPrincipal | null;
  readBody(req: IncomingMessage): Promise<Record<string, unknown>>;
  sendJSON(res: ServerResponse, status: number, data: unknown): void;
}

function decodePathPart(value: string | undefined): string {
  if (!value) return '';
  try {
    return decodeURIComponent(value);
  } catch {
    return '';
  }
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

function stringRecord(value: unknown): Record<string, string> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? Object.fromEntries(
        Object.entries(value).filter(
          (entry): entry is [string, string] => typeof entry[1] === 'string',
        ),
      )
    : {};
}

export async function handleParkStatisticsRoute({
  path,
  method,
  req,
  res,
  memberAccount,
  adminPrincipal,
  readBody,
  sendJSON,
}: ParkStatisticsRouteDeps): Promise<boolean> {
  if (path === '/enterprise/park-statistics' && (method === 'GET' || method === 'POST')) {
    const principal = adminPrincipal!;
    if (principal.kind !== 'account') {
      sendJSON(res, 403, { error: '请使用园区管理员账号管理数据统计' });
      return true;
    }
    if (method === 'GET') {
      try {
        sendJSON(res, 200, { tasks: db.listParkDataStatisticsTasks(principal.account.id) });
      } catch (error) {
        sendJSON(res, 400, { error: error instanceof Error ? error.message : '数据统计任务读取失败' });
      }
      return true;
    }
    const body = await readBody(req);
    const organizationIds = Array.isArray(body.organizationIds)
      ? body.organizationIds.filter((item): item is string => typeof item === 'string')
      : undefined;
    try {
      const result = db.createParkDataStatisticsTask({
        createdByAccountId: principal.account.id,
        title: typeof body.title === 'string' ? body.title : '',
        description: typeof body.description === 'string' ? body.description : '',
        deadline: typeof body.deadline === 'string' ? body.deadline : '',
        fields: stringArray(body.fields),
        templateName: typeof body.templateName === 'string' ? body.templateName : null,
        templateData: typeof body.templateData === 'string' ? body.templateData : null,
        organizationIds,
      });
      sendJSON(res, 201, result);
    } catch (error) {
      sendJSON(res, 400, { error: error instanceof Error ? error.message : '数据统计任务创建失败' });
    }
    return true;
  }

  if (path === '/enterprise/park-statistics/inbox' && method === 'GET') {
    sendJSON(res, 200, { tasks: db.listParkDataStatisticsTasks(memberAccount!.id) });
    return true;
  }

  const statisticsTemplate = path.match(/^\/enterprise\/park-statistics\/([^/]+)\/template$/);
  if (statisticsTemplate && method === 'GET') {
    const taskId = decodePathPart(statisticsTemplate[1]);
    try {
      sendJSON(res, 200, { template: db.getParkDataStatisticsTemplate(taskId, memberAccount!.id) });
    } catch (error) {
      sendJSON(res, 404, { error: error instanceof Error ? error.message : '模板不存在' });
    }
    return true;
  }

  const statisticsAction = path.match(/^\/enterprise\/park-statistics\/([^/]+)\/(remind|return|read|delegate|draft|approve|reject)$/);
  if (statisticsAction && method === 'POST') {
    const taskId = decodePathPart(statisticsAction[1]);
    const action = statisticsAction[2]!;
    if (!taskId) {
      sendJSON(res, 400, { error: '数据统计任务编号不正确' });
      return true;
    }
    const actor =
      memberAccount ??
      (adminPrincipal?.kind === 'account' ? adminPrincipal.account : null);
    if (!actor) {
      sendJSON(res, 401, { error: '登录已失效，请重新登录' });
      return true;
    }
    try {
      if (action === 'read') {
        sendJSON(res, 200, { assignment: db.markParkDataStatisticsRead(taskId, actor.id) });
        return true;
      }
      const body = await readBody(req);
      if (action === 'delegate') {
        sendJSON(res, 200, {
          assignment: db.delegateParkDataStatistics(
            taskId,
            actor.id,
            typeof body.assigneeAccountId === 'string' ? body.assigneeAccountId : '',
          ),
        });
        return true;
      }
      if (action === 'draft') {
        sendJSON(res, 200, {
          assignment: db.submitParkDataStatisticsDraft(
            taskId,
            actor.id,
            stringRecord(body.responseData),
          ),
        });
        return true;
      }
      if (action === 'approve' || action === 'reject') {
        sendJSON(res, 200, {
          assignment: db.reviewParkDataStatistics(
            taskId,
            actor.id,
            action === 'approve',
            typeof body.reason === 'string' ? body.reason : undefined,
          ),
        });
        return true;
      }
      if (!actor.isAdmin) {
        sendJSON(res, 403, { error: '只有园区管理员可以催办或退回任务' });
        return true;
      }
      if (action === 'remind') {
        sendJSON(res, 200, { task: db.remindParkDataStatistics(taskId, actor.id) });
        return true;
      }
      sendJSON(res, 200, {
        assignment: db.returnParkDataStatistics(
          taskId,
          actor.id,
          typeof body.organizationId === 'string' ? body.organizationId : '',
          typeof body.reason === 'string' ? body.reason : '',
        ),
      });
    } catch (error) {
      sendJSON(res, 400, { error: error instanceof Error ? error.message : '数据统计操作失败' });
    }
    return true;
  }

  return false;
}
