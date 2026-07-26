import { randomBytes } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import * as db from './db.js';

export type MemberWorkflowAdminPrincipal =
  | { kind: 'system'; organizationId: string }
  | { kind: 'account'; organizationId: string; account: db.AccountView };

export interface MemberWorkflowRouteDeps {
  path: string;
  method: string;
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  memberAccount: db.AccountView | null;
  adminPrincipal: MemberWorkflowAdminPrincipal | null;
  readBody(req: IncomingMessage): Promise<Record<string, unknown>>;
  sendJSON(res: ServerResponse, status: number, data: unknown): void;
}

export async function handleMemberWorkflowRoute({
  path,
  method,
  req,
  res,
  url,
  memberAccount,
  adminPrincipal,
  readBody,
  sendJSON,
}: MemberWorkflowRouteDeps): Promise<boolean> {
  if (path === '/enterprise/join' && method === 'POST') {
    const body = await readBody(req);
    const invite_code = body.invite_code as string | undefined;
    const employee_name = body.employee_name as string | undefined;
    if (!invite_code || !employee_name) {
      sendJSON(res, 400, { error: 'invite_code and employee_name required' });
      return true;
    }
    const result = db.validateInviteCode(invite_code);
    if (!result.valid) {
      sendJSON(res, 403, { error: result.error });
      return true;
    }
    const empId = `emp_${Date.now()}_${randomBytes(3).toString('hex')}`;
    db.createEmployee({
      id: empId,
      organizationId: result.organizationId,
      name: employee_name,
      invite_code,
      department: result.department,
    });
    sendJSON(res, 200, {
      employee_id: empId,
      department: result.department,
      message: `Welcome ${employee_name}! Please complete onboarding.`,
      next_step: 'onboard',
    });
    return true;
  }

  if (path === '/enterprise/onboard' && method === 'POST') {
    const body = await readBody(req);
    const employee_id = body.employee_id as string | undefined;
    const { role, pain_points, preferred_device, help_focus } = body;
    if (!employee_id) {
      sendJSON(res, 400, { error: 'employee_id required' });
      return true;
    }

    const personalityJson = JSON.stringify({
      role,
      pain_points,
      preferred_device,
      help_focus,
      onboarded_at: new Date().toISOString(),
    });

    const emp = db.getEmployee(employee_id, memberAccount!.organizationId) as {
      role?: string;
      department?: string;
      organization_id?: string;
    } | null;
    if (!emp) {
      sendJSON(res, 404, { error: 'Employee not found' });
      return true;
    }
    if (!memberAccount!.isAdmin && memberAccount!.employeeId !== employee_id) {
      sendJSON(res, 404, { error: 'Employee not found' });
      return true;
    }

    db.getDB()
      .prepare(
        'UPDATE employees SET role = ?, personality = ? WHERE id = ? AND organization_id = ?',
      )
      .run((role as string) || emp.role, personalityJson, employee_id, emp.organization_id);

    const knowledge = db.getOrganizationFeatures(memberAccount!.organizationId).knowledge
      ? db.getKnowledge(emp.department, undefined, emp.organization_id)
      : [];

    sendJSON(res, 200, {
      employee_id,
      message: 'Onboarding complete!',
      inherited_knowledge: knowledge.slice(0, 10),
      total_knowledge_items: knowledge.length,
      next_step: 'start_working',
    });
    return true;
  }

  if (path === '/enterprise/task' && method === 'POST') {
    const body = await readBody(req);
    const employee_id = body.employee_id as string | undefined;
    const task_type = body.task_type as string | undefined;
    if (!employee_id || !task_type) {
      sendJSON(res, 400, { error: 'employee_id and task_type required' });
      return true;
    }
    const employee = db.getEmployee(employee_id, memberAccount!.organizationId);
    if (!employee
      || (!memberAccount!.isAdmin && memberAccount!.employeeId !== employee_id)) {
      sendJSON(res, 404, { error: 'Employee not found' });
      return true;
    }
    db.logTask({
      employee_id,
      task_type,
      context: body.context as string | undefined,
      result: body.result as string | undefined,
      duration_min: (body.duration_min as number) || 0,
      tokens_used: body.tokens_used as number | undefined,
      cost_cny: body.cost_cny as number | undefined,
    });
    sendJSON(res, 200, { status: 'logged' });
    return true;
  }

  if (path === '/enterprise/recall' && method === 'GET') {
    const employee_id = url.searchParams.get('employee_id') || '';
    const task_type = url.searchParams.get('task_type') || '';
    const emp = db.getEmployee(employee_id, memberAccount!.organizationId) as {
      department?: string;
      organization_id?: string;
    } | null;
    if (!emp) {
      sendJSON(res, 404, { error: 'Employee not found' });
      return true;
    }
    if (!memberAccount!.isAdmin && memberAccount!.employeeId !== employee_id) {
      sendJSON(res, 404, { error: 'Employee not found' });
      return true;
    }
    const knowledge = db.getOrganizationFeatures(memberAccount!.organizationId).knowledge
      ? db.searchKnowledge(task_type, emp.department, emp.organization_id)
      : [];
    const history = db.getTaskHistory(employee_id, 5, emp.organization_id);
    sendJSON(res, 200, { knowledge: knowledge.slice(0, 5), history, department: emp.department });
    return true;
  }

  if (path === '/enterprise/offboard' && method === 'POST') {
    const body = await readBody(req);
    const employee_id = body.employee_id as string | undefined;
    if (!employee_id) {
      sendJSON(res, 400, { error: 'employee_id required' });
      return true;
    }
    const organizationId = adminPrincipal!.organizationId;
    const emp = db.getEmployee(employee_id, organizationId) as {
      name?: string;
      department?: string;
    } | null;
    if (!emp) {
      sendJSON(res, 404, { error: 'Employee not found' });
      return true;
    }
    const tasks = db.getTaskHistory(employee_id, 50, organizationId) as Array<{ task_type: string }>;
    const byType: Record<string, number> = {};
    for (const t of tasks) byType[t.task_type] = (byType[t.task_type] || 0) + 1;
    for (const [type, count] of Object.entries(byType)) {
      db.addKnowledge({
        organizationId,
        department: emp.department,
        category: 'offboarded_experience',
        content: `Task "${type}" executed ${count} times by ${emp.name}. Average patterns preserved.`,
        contributor: emp.name,
        confidence: 0.8,
      });
    }
    db.offboardEmployee(employee_id, organizationId);
    sendJSON(res, 200, {
      status: 'offboarded',
      merged_tasks: tasks.length,
      merged_patterns: Object.keys(byType).length,
      message: 'Experience merged to department. No manual handover needed.',
    });
    return true;
  }

  if (path === '/enterprise/invite' && method === 'POST') {
    const body = await readBody(req);
    const department = body.department as string | undefined;
    const max_uses = body.max_uses as number | undefined;
    if (!department) {
      sendJSON(res, 400, { error: 'department required' });
      return true;
    }
    const code = db.createInviteCode(
      department,
      adminPrincipal!.kind === 'account' ? adminPrincipal!.account.id : 'platform-admin',
      max_uses || 1,
      adminPrincipal!.organizationId,
    );
    sendJSON(res, 200, { code, department, max_uses: max_uses || 1 });
    return true;
  }

  if (path === '/enterprise/knowledge' && method === 'GET') {
    const organizationId = memberAccount!.organizationId;
    if (!db.getOrganizationFeatures(organizationId).knowledge) {
      sendJSON(res, 403, { error: '企业知识功能已由管理员关闭' });
      return true;
    }
    const query = url.searchParams.get('q') || '';
    const requestedDepartment = url.searchParams.get('department')?.trim() || undefined;
    if (
      !memberAccount!.isAdmin
      && requestedDepartment
      && requestedDepartment !== memberAccount!.department
    ) {
      sendJSON(res, 403, { error: '无权读取其他部门知识' });
      return true;
    }
    const result = memberAccount!.isAdmin
      ? query
        ? db.searchKnowledge(query, requestedDepartment, organizationId)
        : db.getKnowledge(requestedDepartment, undefined, organizationId)
      : db.getMemberKnowledge(memberAccount!.department, query, organizationId);
    sendJSON(res, 200, { knowledge: result });
    return true;
  }

  if (path === '/enterprise/knowledge' && method === 'POST') {
    const organizationId = memberAccount!.organizationId;
    if (!db.getOrganizationFeatures(organizationId).knowledge) {
      sendJSON(res, 403, { error: '企业知识功能已由管理员关闭' });
      return true;
    }
    const body = await readBody(req);
    const content = body.content as string | undefined;
    if (!content) {
      sendJSON(res, 400, { error: 'content required' });
      return true;
    }
    const confidence = typeof body.confidence === 'number'
      && Number.isFinite(body.confidence)
      && body.confidence >= 0
      && body.confidence <= 1
      ? body.confidence
      : 0.5;
    const sourceId = typeof body.sourceId === 'string'
      ? body.sourceId.trim().slice(0, 200)
      : undefined;
    const added = db.addKnowledge({
      organizationId,
      sourceId: sourceId || undefined,
      department: memberAccount!.isAdmin && typeof body.department === 'string'
        ? body.department
        : memberAccount!.department || undefined,
      category: (body.category as string) || 'general',
      content,
      contributor: memberAccount!.name,
      confidence,
    });
    sendJSON(res, 200, { status: added ? 'added' : 'exists', added });
    return true;
  }

  return false;
}
