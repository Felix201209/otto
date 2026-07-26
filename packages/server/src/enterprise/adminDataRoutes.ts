import type { ServerResponse } from 'node:http';
import * as db from './db.js';

export type AdminDataRoutePrincipal =
  | { kind: 'system'; organizationId: string }
  | { kind: 'account'; organizationId: string; account: db.AccountView };

export interface AdminDataRouteDeps {
  path: string;
  method: string;
  res: ServerResponse;
  url: URL;
  adminPrincipal: AdminDataRoutePrincipal | null;
  sendJSON(res: ServerResponse, status: number, data: unknown): void;
}

export function handleAdminDataRoute({
  path,
  method,
  res,
  url,
  adminPrincipal,
  sendJSON,
}: AdminDataRouteDeps): boolean {
  if (path === '/enterprise/report' && method === 'GET') {
    const period = parseInt(url.searchParams.get('period') || '30', 10);
    const department = url.searchParams.get('department') || undefined;
    sendJSON(
      res,
      200,
      db.getReport(period, department, adminPrincipal!.organizationId),
    );
    return true;
  }

  if (path === '/enterprise/employees' && method === 'GET') {
    const department = url.searchParams.get('department') || undefined;
    sendJSON(res, 200, {
      employees: db.listEmployees(department, adminPrincipal!.organizationId),
    });
    return true;
  }

  if (path === '/enterprise/audit' && method === 'GET') {
    sendJSON(res, 200, {
      logs: db.getAuditLogs(50, adminPrincipal!.organizationId),
    });
    return true;
  }

  if (path === '/enterprise/export' && method === 'GET') {
    sendJSON(res, 200, db.exportAll(adminPrincipal!.organizationId));
    return true;
  }

  return false;
}
