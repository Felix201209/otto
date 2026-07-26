import { randomUUID } from 'node:crypto';
import type { Database } from '../sqlite-compat.js';
import type { OrganizationFeatures } from './db.js';
import type {
  ParkDataStatisticsAssignmentStatus,
  ParkDataStatisticsAssignmentView,
  ParkDataStatisticsTaskView,
} from './parkStatisticsTypes.js';

interface ParkStatisticsAccount {
  id: string;
  organizationId: string;
  employeeId: string | null;
  isAdmin: boolean;
  status: string;
}

interface ParkStatisticsOrganization {
  id: string;
  name: string;
}

interface ParkStatisticsPark {
  id: string;
  adminOrganizationId: string;
}

export interface ParkStatisticsRepositoryStore {
  db(): Database;
  getAccount(accountId: string, organizationId?: string): ParkStatisticsAccount | null;
  getPark(parkId: string): ParkStatisticsPark | null;
  getParkForOrganization(organizationId: string): ParkStatisticsPark | null;
  getOrganizationFeatures(organizationId: string): OrganizationFeatures;
  listAccounts(organizationId?: string): ParkStatisticsAccount[];
  listParkTenantOrganizations(parkId: string): ParkStatisticsOrganization[];
  audit(event: string, employeeId: string | null, detail: string, organizationId: string): void;
}

interface ParkDataStatisticsTaskRow {
  id: string;
  park_id: string;
  admin_organization_id: string;
  title: string;
  description: string;
  deadline: string;
  fields_json: string;
  template_name: string | null;
  template_data: string | null;
  status: 'published' | 'closed';
  created_at: string;
  updated_at: string;
}

interface ParkDataStatisticsAssignmentRow {
  id: string;
  task_id: string;
  organization_id: string;
  organization_name: string;
  ceo_account_id: string;
  ceo_name: string;
  assignee_account_id: string | null;
  assignee_name: string | null;
  status: ParkDataStatisticsAssignmentStatus;
  response_data: string | null;
  return_reason: string | null;
  read_at: string | null;
  submitted_at: string | null;
  reviewed_at: string | null;
  last_reminded_at: string | null;
  updated_at: string;
}

function parseStringRecord(value: string | null): Record<string, string> | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return Object.fromEntries(
      Object.entries(parsed).filter(
        (entry): entry is [string, string] => typeof entry[1] === 'string',
      ),
    );
  } catch {
    return null;
  }
}

function dataStatisticsAssignmentView(
  row: ParkDataStatisticsAssignmentRow,
): ParkDataStatisticsAssignmentView {
  return {
    id: row.id,
    taskId: row.task_id,
    organizationId: row.organization_id,
    organizationName: row.organization_name,
    ceoAccountId: row.ceo_account_id,
    ceoName: row.ceo_name,
    assigneeAccountId: row.assignee_account_id,
    assigneeName: row.assignee_name,
    status: row.status,
    responseData: parseStringRecord(row.response_data),
    returnReason: row.return_reason,
    readAt: row.read_at,
    submittedAt: row.submitted_at,
    reviewedAt: row.reviewed_at,
    lastRemindedAt: row.last_reminded_at,
    updatedAt: row.updated_at,
  };
}

function dataStatisticsTaskView(
  row: ParkDataStatisticsTaskRow,
  assignments: ParkDataStatisticsAssignmentView[],
): ParkDataStatisticsTaskView {
  let fields: string[] = [];
  try {
    const parsed = JSON.parse(row.fields_json) as unknown;
    if (Array.isArray(parsed)) {
      fields = parsed.filter((item): item is string => typeof item === 'string');
    }
  } catch {
    // Old or invalid field metadata is treated as empty.
  }
  return {
    id: row.id,
    parkId: row.park_id,
    title: row.title,
    description: row.description,
    deadline: row.deadline,
    fields,
    templateName: row.template_name,
    hasTemplate: Boolean(row.template_data),
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    assignments,
  };
}

function statisticsTaskRow(
  store: ParkStatisticsRepositoryStore,
  taskId: string,
): ParkDataStatisticsTaskRow {
  const row = store.db()
    .prepare('SELECT * FROM park_data_statistics_tasks WHERE id = ?')
    .get(taskId) as ParkDataStatisticsTaskRow | undefined;
  if (!row) throw new Error('数据统计任务不存在');
  return row;
}

function statisticsAssignmentRows(
  store: ParkStatisticsRepositoryStore,
  taskId: string,
): ParkDataStatisticsAssignmentView[] {
  const rows = store.db()
    .prepare(
      `SELECT a.*, o.name AS organization_name,
              ceo.name AS ceo_name, assignee.name AS assignee_name
       FROM park_data_statistics_assignments a
       JOIN organizations o ON o.id = a.organization_id
       JOIN accounts ceo ON ceo.id = a.ceo_account_id
       LEFT JOIN accounts assignee ON assignee.id = a.assignee_account_id
       WHERE a.task_id = ?
       ORDER BY o.name COLLATE NOCASE, o.slug`,
    )
    .all(taskId) as ParkDataStatisticsAssignmentRow[];
  return rows.map(dataStatisticsAssignmentView);
}

function assertParkAdmin(
  store: ParkStatisticsRepositoryStore,
  accountId: string,
): { account: ParkStatisticsAccount; park: ParkStatisticsPark } {
  const account = store.getAccount(accountId);
  if (!account?.isAdmin || account.status !== 'active') {
    throw new Error('只有园区管理员可以管理数据统计');
  }
  const park = store.getParkForOrganization(account.organizationId);
  if (!park || park.adminOrganizationId !== account.organizationId) {
    throw new Error('当前企业不是园区管理方');
  }
  if (!store.getOrganizationFeatures(account.organizationId).park_service) {
    throw new Error('园区服务功能已关闭');
  }
  return { account, park };
}

function assertTaskMember(
  store: ParkStatisticsRepositoryStore,
  taskId: string,
  accountId: string,
): {
  task: ParkDataStatisticsTaskRow;
  assignment: ParkDataStatisticsAssignmentView;
  account: ParkStatisticsAccount;
} {
  const account = store.getAccount(accountId);
  if (!account || account.status !== 'active') throw new Error('账号不存在或已停用');
  const task = statisticsTaskRow(store, taskId);
  const row = store.db()
    .prepare(
      `SELECT a.*, o.name AS organization_name,
              ceo.name AS ceo_name, assignee.name AS assignee_name
       FROM park_data_statistics_assignments a
       JOIN organizations o ON o.id = a.organization_id
       JOIN accounts ceo ON ceo.id = a.ceo_account_id
       LEFT JOIN accounts assignee ON assignee.id = a.assignee_account_id
       WHERE a.task_id = ? AND (a.ceo_account_id = ? OR a.assignee_account_id = ?)
       LIMIT 1`,
    )
    .get(taskId, account.id, account.id) as ParkDataStatisticsAssignmentRow | undefined;
  if (!row) throw new Error('该数据统计任务不属于当前企业');
  return { task, assignment: dataStatisticsAssignmentView(row), account };
}

export function createParkDataStatisticsTask(
  store: ParkStatisticsRepositoryStore,
  input: {
    createdByAccountId: string;
    title: string;
    description: string;
    deadline: string;
    fields?: string[];
    templateName?: string | null;
    templateData?: string | null;
    organizationIds?: string[];
  },
): { task: ParkDataStatisticsTaskView; recipientCount: number } {
  const { account, park } = assertParkAdmin(store, input.createdByAccountId);
  const title = input.title.trim().slice(0, 120);
  const description = input.description.trim().slice(0, 2_000);
  const deadline = input.deadline.trim();
  if (!title || !description || !deadline) throw new Error('标题、说明和截止时间不能为空');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(deadline)) throw new Error('截止时间格式应为 YYYY-MM-DD');
  const fields = [...new Set((input.fields ?? []).map((item) => item.trim()).filter(Boolean))].slice(0, 100);
  const templateName = input.templateName?.trim().slice(0, 200) || null;
  const templateData = input.templateData?.trim() || null;
  if (templateData && templateData.length > 2_800_000) throw new Error('模板文件不能超过 2MB');
  const tenantOrganizations = store.listParkTenantOrganizations(park.id);
  const wanted = input.organizationIds?.length
    ? tenantOrganizations.filter((org) => input.organizationIds!.includes(org.id))
    : tenantOrganizations;
  if (wanted.length === 0) throw new Error('至少选择一家入住企业');
  const recipients = wanted.map((organization) => {
    const ceo = store.listAccounts(organization.id).find(
      (item) => item.isAdmin && item.status === 'active',
    );
    if (!ceo) throw new Error(`企业“${organization.name}”没有可接收任务的企业管理员`);
    return { organization, ceo };
  });
  const id = `park_statistics_${randomUUID()}`;
  const database = store.db();
  database.exec('BEGIN IMMEDIATE');
  try {
    database.prepare(
      `INSERT INTO park_data_statistics_tasks
        (id, park_id, admin_organization_id, created_by_account_id, title, description, deadline,
         fields_json, template_name, template_data)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, park.id, account.organizationId, account.id, title, description, deadline,
      JSON.stringify(fields), templateName, templateData);
    const insert = database.prepare(
      `INSERT INTO park_data_statistics_assignments
        (id, task_id, park_id, organization_id, ceo_account_id)
       VALUES (?, ?, ?, ?, ?)`,
    );
    for (const recipient of recipients) {
      insert.run(`park_statistics_assignment_${randomUUID()}`, id, park.id, recipient.organization.id, recipient.ceo.id);
    }
    store.audit(
      'park_statistics_create',
      account.employeeId,
      `${id} delivered to ${recipients.length} enterprise(s)`,
      account.organizationId,
    );
    database.exec('COMMIT');
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
  const row = statisticsTaskRow(store, id);
  return {
    task: dataStatisticsTaskView(row, statisticsAssignmentRows(store, id)),
    recipientCount: recipients.length,
  };
}

export function listParkDataStatisticsTasks(
  store: ParkStatisticsRepositoryStore,
  accountId: string,
): ParkDataStatisticsTaskView[] {
  const account = store.getAccount(accountId);
  if (!account) throw new Error('Account not found');
  const park = store.getParkForOrganization(account.organizationId);
  const rows = account.isAdmin && park?.adminOrganizationId === account.organizationId
    ? store.db().prepare('SELECT * FROM park_data_statistics_tasks WHERE admin_organization_id = ? ORDER BY created_at DESC').all(account.organizationId)
    : store.db().prepare(
      `SELECT DISTINCT t.* FROM park_data_statistics_tasks t
       JOIN park_data_statistics_assignments a ON a.task_id = t.id
       WHERE (a.ceo_account_id = ? OR a.assignee_account_id = ?) AND t.status = 'published'
       ORDER BY t.created_at DESC`,
    ).all(account.id, account.id);
  const isParkAdmin = account.isAdmin && park?.adminOrganizationId === account.organizationId;
  return (rows as ParkDataStatisticsTaskRow[]).map((row) => {
    const assignments = statisticsAssignmentRows(store, row.id);
    return dataStatisticsTaskView(
      row,
      isParkAdmin ? assignments : assignments.filter(
        (assignment) => assignment.ceoAccountId === account.id || assignment.assigneeAccountId === account.id,
      ),
    );
  });
}

export function markParkDataStatisticsRead(
  store: ParkStatisticsRepositoryStore,
  taskId: string,
  accountId: string,
): ParkDataStatisticsAssignmentView {
  const { assignment } = assertTaskMember(store, taskId, accountId);
  store.db()
    .prepare(
      `UPDATE park_data_statistics_assignments SET read_at = COALESCE(read_at, datetime('now')), updated_at = datetime('now') WHERE id = ?`,
    )
    .run(assignment.id);
  return statisticsAssignmentRows(store, taskId).find((item) => item.id === assignment.id)!;
}

export function getParkDataStatisticsTemplate(
  store: ParkStatisticsRepositoryStore,
  taskId: string,
  accountId: string,
): {
  name: string;
  data: string;
} {
  const { task } = assertTaskMember(store, taskId, accountId);
  if (!task.template_name || !task.template_data) throw new Error('该任务没有 Excel 模板');
  return { name: task.template_name, data: task.template_data };
}

export function delegateParkDataStatistics(
  store: ParkStatisticsRepositoryStore,
  taskId: string,
  accountId: string,
  assigneeAccountId: string,
): ParkDataStatisticsAssignmentView {
  const { assignment, account } = assertTaskMember(store, taskId, accountId);
  if (!account.isAdmin || account.id !== assignment.ceoAccountId) throw new Error('只有企业负责人可以分派数据统计任务');
  const assignee = store.getAccount(assigneeAccountId, account.organizationId);
  if (!assignee || assignee.status !== 'active') throw new Error('被分派员工不存在或已停用');
  store.db()
    .prepare(
      `UPDATE park_data_statistics_assignments
       SET assignee_account_id = ?, status = 'delegated', return_reason = NULL, updated_at = datetime('now')
       WHERE id = ?`,
    )
    .run(assignee.id, assignment.id);
  return statisticsAssignmentRows(store, taskId).find((item) => item.id === assignment.id)!;
}

export function submitParkDataStatisticsDraft(
  store: ParkStatisticsRepositoryStore,
  taskId: string,
  accountId: string,
  responseData: Record<string, string>,
): ParkDataStatisticsAssignmentView {
  const { task, assignment, account } = assertTaskMember(store, taskId, accountId);
  if (assignment.assigneeAccountId && assignment.assigneeAccountId !== account.id && assignment.ceoAccountId !== account.id) {
    throw new Error('当前账号不是本任务填报人');
  }
  const clean = Object.fromEntries(Object.entries(responseData).filter(
    ([key, value]) => key.trim() && typeof value === 'string',
  ).map(([key, value]) => [key.trim().slice(0, 120), value.slice(0, 10_000)]));
  const status = account.id === assignment.ceoAccountId && !assignment.assigneeAccountId ? 'pending_review' : 'pending_review';
  store.db()
    .prepare(
      `UPDATE park_data_statistics_assignments
       SET response_data = ?, status = ?, submitted_at = datetime('now'), reviewed_at = NULL,
           return_reason = NULL, updated_at = datetime('now')
       WHERE id = ?`,
    )
    .run(JSON.stringify(clean), status, assignment.id);
  void task;
  return statisticsAssignmentRows(store, taskId).find((item) => item.id === assignment.id)!;
}

export function reviewParkDataStatistics(
  store: ParkStatisticsRepositoryStore,
  taskId: string,
  accountId: string,
  approved: boolean,
  reason?: string,
): ParkDataStatisticsAssignmentView {
  const { assignment, account } = assertTaskMember(store, taskId, accountId);
  if (!account.isAdmin || account.id !== assignment.ceoAccountId) throw new Error('只有企业负责人可以审核填报结果');
  if (approved && !assignment.responseData) throw new Error('还没有可审核的填报内容');
  const status: ParkDataStatisticsAssignmentStatus = approved ? 'submitted' : 'returned';
  store.db()
    .prepare(
      `UPDATE park_data_statistics_assignments
       SET status = ?, return_reason = ?, reviewed_at = datetime('now'), updated_at = datetime('now')
       WHERE id = ?`,
    )
    .run(status, approved ? null : (reason?.trim().slice(0, 500) || '请补充或修改填报内容'), assignment.id);
  return statisticsAssignmentRows(store, taskId).find((item) => item.id === assignment.id)!;
}

export function remindParkDataStatistics(
  store: ParkStatisticsRepositoryStore,
  taskId: string,
  adminAccountId: string,
): ParkDataStatisticsTaskView {
  const { account } = assertParkAdmin(store, adminAccountId);
  const task = statisticsTaskRow(store, taskId);
  const park = store.getPark(task.park_id);
  if (!park || park.adminOrganizationId !== account.organizationId) throw new Error('无权操作该任务');
  store.db()
    .prepare(
      `UPDATE park_data_statistics_assignments SET last_reminded_at = datetime('now'), updated_at = datetime('now')
       WHERE task_id = ? AND status NOT IN ('submitted')`,
    )
    .run(taskId);
  return dataStatisticsTaskView(task, statisticsAssignmentRows(store, taskId));
}

export function returnParkDataStatistics(
  store: ParkStatisticsRepositoryStore,
  taskId: string,
  adminAccountId: string,
  organizationId: string,
  reason: string,
): ParkDataStatisticsAssignmentView {
  const { account } = assertParkAdmin(store, adminAccountId);
  const task = statisticsTaskRow(store, taskId);
  if (task.admin_organization_id !== account.organizationId) throw new Error('无权操作该任务');
  const row = store.db()
    .prepare('SELECT id FROM park_data_statistics_assignments WHERE task_id = ? AND organization_id = ?')
    .get(taskId, organizationId) as { id: string } | undefined;
  if (!row) throw new Error('未找到该企业的任务分派');
  store.db()
    .prepare(
      `UPDATE park_data_statistics_assignments SET status = 'returned', return_reason = ?, reviewed_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`,
    )
    .run(reason.trim().slice(0, 500) || '请补充或修改填报内容', row.id);
  return statisticsAssignmentRows(store, taskId).find((item) => item.id === row.id)!;
}
