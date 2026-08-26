import { randomBytes } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import * as db from './db.js';

function worklogInputMessage(error: unknown): string | null {
  const message = error instanceof Error ? error.message : String(error);
  if (message === 'task_type required') return message;
  if (message === 'duration_min 必须是非负数字') return message;
  if (/^(?:task_type|context|result|duration_min|tokens_used|cost_cny) 不能超过 /.test(message)) {
    return message;
  }
  return null;
}

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
    const empId = `emp_${Date.now()}_${randomBytes(3).toString('hex')}`;
    const result = db.validateInviteCode(invite_code, undefined, (invite) => {
      db.createEmployee({
        id: empId,
        organizationId: invite.organizationId,
        name: employee_name,
        invite_code,
        department: invite.department,
      });
    });
    if (!result.valid) {
      sendJSON(res, 403, { error: result.error });
      return true;
    }
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

    db.updateEmployeeOnboardingProfile({
      employeeId: employee_id,
      organizationId: emp.organization_id!,
      role: (role as string) || emp.role || null,
      personality: personalityJson,
    });

    const knowledge = db.getOrganizationFeatures(memberAccount!.organizationId).knowledge
      ? db.getMemberKnowledge(emp.department, '', emp.organization_id)
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
    try {
      db.logTask({
        organizationId: memberAccount!.organizationId,
        employee_id,
        task_type,
        context: body.context as string | undefined,
        result: body.result as string | undefined,
        duration_min: body.duration_min as number | undefined,
        tokens_used: body.tokens_used as number | undefined,
        cost_cny: body.cost_cny as number | undefined,
      });
    } catch (error) {
      const message = worklogInputMessage(error);
      if (!message) throw error;
      sendJSON(res, 400, { error: message });
      return true;
    }
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
      ? db.getMemberKnowledge(emp.department, task_type, emp.organization_id)
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
    const tasks = db.getTaskHistory(employee_id, 50, organizationId) as Array<{
      task_type: string;
      context: string | null;
      result: string | null;
      created_at: string;
    }>;
    const byType = new Map<string, typeof tasks>();
    for (const task of tasks) {
      const current = byType.get(task.task_type) ?? [];
      current.push(task);
      byType.set(task.task_type, current);
    }
    let handoverCandidates = 0;
    const knowledgeEnabled = db.getOrganizationFeatures(organizationId).knowledge;
    for (const [type, entries] of knowledgeEnabled ? byType.entries() : []) {
      const reusableResults = entries
        .map((entry) => entry.result?.replace(/\s+/g, ' ').trim())
        .filter((result): result is string => Boolean(result))
        .slice(0, 3);
      if (reusableResults.length === 0) continue;
      const content = [
        `${emp.name || '离职员工'}在“${type}”事项中留有 ${entries.length} 条工作记录。`,
        '近期可复用结果：',
        ...reusableResults.map((result) => `- ${result.slice(0, 600)}`),
        '发布前请核验适用范围、时效性与敏感信息。',
      ].join('\n');
      db.saveKnowledge({
        organizationId,
        department: emp.department,
        category: 'offboarded_experience',
        title: `${type}离职交接候选`,
        content,
        contributor: emp.name,
        contributorAccountId: adminPrincipal!.kind === 'account'
          ? adminPrincipal!.account.id
          : undefined,
        confidence: 0.8,
        sourceId: `offboarding:${employee_id}:${type}`.slice(0, 200),
        sourceType: 'offboarding',
        sourceLabel: `${emp.name || employee_id} 离职工作记录`,
        status: 'pending_review',
      });
      handoverCandidates += 1;
    }
    db.offboardEmployee(employee_id, organizationId);
    sendJSON(res, 200, {
      status: 'offboarded',
      merged_tasks: tasks.length,
      merged_patterns: handoverCandidates,
      message: handoverCandidates > 0
        ? `已生成 ${handoverCandidates} 条离职交接候选，请管理员审核后发布。`
        : '没有找到可复用的任务结果，请补充人工交接材料。',
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
    const includeReview = url.searchParams.get('includeReview') === 'true';
    if (
      !memberAccount!.isAdmin
      && requestedDepartment
      && requestedDepartment !== memberAccount!.department
    ) {
      sendJSON(res, 403, { error: '无权读取其他部门知识' });
      return true;
    }
    const requestedStatus = url.searchParams.get('status');
    const status = requestedStatus === 'pending_review'
      || requestedStatus === 'active'
      || requestedStatus === 'archived'
      ? requestedStatus
      : undefined;
    const result = memberAccount!.isAdmin && includeReview
      ? db.getKnowledgeForAdministration(
          query,
          requestedDepartment,
          organizationId,
          status,
        )
      : memberAccount!.isAdmin
        ? query
          ? db.searchKnowledge(query, requestedDepartment, organizationId)
          : db.getKnowledge(requestedDepartment, undefined, organizationId)
        : db.getMemberKnowledge(
            memberAccount!.department,
            query,
            organizationId,
            {
              includeOwnPending: includeReview,
              contributorAccountId: memberAccount!.id,
            },
          );
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
    if (!memberAccount!.isAdmin && !memberAccount!.department?.trim()) {
      sendJSON(res, 403, { error: '无部门成员不能写入全局知识' });
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
    const sourceType = body.sourceType === 'auto_capture'
      || body.sourceType === 'work_result'
      || body.sourceType === 'task_log'
      || body.sourceType === 'document'
      || body.sourceType === 'offboarding'
      ? body.sourceType
      : 'manual';
    const reviewStatus = memberAccount!.isAdmin && sourceType === 'manual'
      ? 'active'
      : 'pending_review';
    const scopedSourceId = sourceId && !memberAccount!.isAdmin
      ? `account:${memberAccount!.id}:${sourceId}`.slice(0, 200)
      : sourceId;
    if (sourceType === 'auto_capture') {
      const sourceSessionId = typeof body.sourceSessionId === 'string'
        ? body.sourceSessionId.trim().slice(0, 200)
        : '';
      if (!sourceSessionId || !scopedSourceId) {
        sendJSON(res, 400, { error: '自动知识观察缺少来源会话或来源编号' });
        return true;
      }
      const observed = db.observeKnowledge({
        organizationId,
        department: memberAccount!.department,
        category: (body.category as string) || 'general',
        content,
        tags: Array.isArray(body.tags) ? body.tags as string[] : undefined,
        contributor: memberAccount!.name,
        contributorAccountId: memberAccount!.id,
        sourceId: scopedSourceId,
        sourceSessionId,
        sourceFingerprint: typeof body.sourceFingerprint === 'string'
          ? body.sourceFingerprint
          : undefined,
        confidence,
        verified: body.verified === true,
        impactScore: typeof body.impactScore === 'number' ? body.impactScore : undefined,
        significanceSignals: Array.isArray(body.significanceSignals)
          ? body.significanceSignals as string[]
          : undefined,
        observedAt: typeof body.observedAt === 'string' ? body.observedAt : undefined,
      });
      sendJSON(res, 200, {
        status: observed.outcome,
        added: observed.promoted,
        outcome: observed.outcome,
        reviewStatus: observed.knowledge?.status,
        knowledgeId: observed.knowledge?.id,
        retention: {
          promoted: observed.promoted,
          reason: observed.reason,
          evidenceCount: observed.evidenceCount,
          distinctSessionCount: observed.distinctSessionCount,
          distinctContributorCount: observed.distinctContributorCount,
          spanDays: observed.spanDays,
          impactScore: observed.impactScore,
        },
      });
      return true;
    }
    const saved = db.saveKnowledge({
      organizationId,
      sourceId: scopedSourceId || undefined,
      department: memberAccount!.isAdmin && typeof body.department === 'string'
        ? body.department
        : memberAccount!.department || undefined,
      title: typeof body.title === 'string' ? body.title : undefined,
      category: (body.category as string) || 'general',
      content,
      contributor: memberAccount!.name,
      contributorAccountId: memberAccount!.id,
      confidence,
      sourceType,
      sourceLabel: typeof body.sourceLabel === 'string' ? body.sourceLabel : undefined,
      status: reviewStatus,
      reviewedBy: reviewStatus === 'active' ? memberAccount!.name : undefined,
    });
    const added = saved.outcome !== 'unchanged';
    sendJSON(res, 200, {
      status: added ? 'added' : 'exists',
      added,
      outcome: saved.outcome,
      reviewStatus: saved.entry.status,
      knowledgeId: saved.entry.id,
    });
    return true;
  }

  const reviewMatch = path.match(/^\/enterprise\/knowledge\/(\d+)\/review$/u);
  if (reviewMatch && method === 'POST') {
    if (!db.getOrganizationFeatures(memberAccount!.organizationId).knowledge) {
      sendJSON(res, 403, { error: '企业知识功能已由管理员关闭' });
      return true;
    }
    if (!memberAccount!.isAdmin) {
      sendJSON(res, 403, { error: '只有企业管理员可以审核知识' });
      return true;
    }
    const body = await readBody(req);
    if (body.action !== 'approve' && body.action !== 'archive') {
      sendJSON(res, 400, { error: 'action must be approve or archive' });
      return true;
    }
    const knowledge = db.reviewKnowledge({
      id: Number(reviewMatch[1]),
      organizationId: memberAccount!.organizationId,
      action: body.action,
      reviewer: memberAccount!.name,
      note: typeof body.note === 'string' ? body.note : undefined,
    });
    if (!knowledge) {
      sendJSON(res, 404, { error: 'knowledge not found' });
      return true;
    }
    sendJSON(res, 200, { knowledge });
    return true;
  }

  const knowledgeMatch = path.match(/^\/enterprise\/knowledge\/(\d+)$/u);
  if (knowledgeMatch && method === 'PATCH') {
    if (!db.getOrganizationFeatures(memberAccount!.organizationId).knowledge) {
      sendJSON(res, 403, { error: '企业知识功能已由管理员关闭' });
      return true;
    }
    if (!memberAccount!.isAdmin) {
      sendJSON(res, 403, { error: '只有企业管理员可以修订知识' });
      return true;
    }
    const body = await readBody(req);
    const knowledge = db.reviseKnowledge({
      id: Number(knowledgeMatch[1]),
      organizationId: memberAccount!.organizationId,
      title: typeof body.title === 'string' ? body.title : undefined,
      category: typeof body.category === 'string' ? body.category : undefined,
      content: typeof body.content === 'string' ? body.content : undefined,
      confidence: typeof body.confidence === 'number' ? body.confidence : undefined,
      sourceLabel: body.sourceLabel === null || typeof body.sourceLabel === 'string'
        ? body.sourceLabel
        : undefined,
      changedBy: memberAccount!.name,
      changeNote: typeof body.changeNote === 'string' ? body.changeNote : undefined,
    });
    if (!knowledge) {
      sendJSON(res, 404, { error: 'knowledge not found' });
      return true;
    }
    sendJSON(res, 200, { knowledge });
    return true;
  }

  const revisionsMatch = path.match(/^\/enterprise\/knowledge\/(\d+)\/revisions$/u);
  if (revisionsMatch && method === 'GET') {
    if (!db.getOrganizationFeatures(memberAccount!.organizationId).knowledge) {
      sendJSON(res, 403, { error: '企业知识功能已由管理员关闭' });
      return true;
    }
    if (!memberAccount!.isAdmin) {
      sendJSON(res, 403, { error: '只有企业管理员可以查看修订历史' });
      return true;
    }
    sendJSON(res, 200, {
      revisions: db.getKnowledgeRevisions(
        Number(revisionsMatch[1]),
        memberAccount!.organizationId,
      ),
    });
    return true;
  }

  return false;
}
