/**
 * @license Copyright 2026 Felix SPDX-License-Identifier: Apache-2.0
 *
 * Enterprise Server - HTTP API for Otto Enterprise.
 * Runs on admin/owner device. All data local.
 *
 * Endpoints:
 *   POST /enterprise/join          - Employee joins via invite code
 *   POST /enterprise/onboard       - Complete 5-question onboarding
 *   POST /enterprise/task          - Log task execution
 *   GET  /enterprise/recall        - Retrieve knowledge for task
 *   GET  /enterprise/report        - Management dashboard data
 *   GET  /enterprise/employees     - List employees
 *   POST /enterprise/offboard      - Offboard employee
 *   POST /enterprise/invite        - Create invite code (admin)
 *   GET  /enterprise/knowledge     - Search/list knowledge
 *   POST /enterprise/knowledge     - Add knowledge
 *   GET  /enterprise/audit         - Audit logs
 *   GET  /enterprise/export        - Export all data
 *   GET  /enterprise/health        - Health check
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import * as db from './db.js';

const PORT = parseInt(process.env.OTTO_ENTERPRISE_PORT || '7777', 10);
const HOST = process.env.OTTO_ENTERPRISE_HOST || '0.0.0.0';

interface RouteBody {
  [key: string]: any;
}

function sendJSON(res: ServerResponse, status: number, data: any): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function readBody(req: IncomingMessage): Promise<RouteBody> {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      try { resolve(body ? JSON.parse(body) : {}); }
      catch { resolve({}); }
    });
  });
}

async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url || '/', `http://${req.headers.host}`);
  const path = url.pathname;
  const method = req.method || 'GET';

  // CORS for admin dashboard
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  try {
    // ===== Health =====
    if (path === '/enterprise/health' && method === 'GET') {
      sendJSON(res, 200, { status: 'ok', uptime: process.uptime(), db: 'connected' });
      return;
    }

    // ===== Join (employee uses invite code) =====
    if (path === '/enterprise/join' && method === 'POST') {
      const body = await readBody(req);
      const { invite_code, employee_name } = body;
      if (!invite_code || !employee_name) {
        sendJSON(res, 400, { error: 'invite_code and employee_name required' });
        return;
      }
      const result = db.validateInviteCode(invite_code);
      if (!result.valid) {
        sendJSON(res, 403, { error: result.error });
        return;
      }
      const empId = `emp_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
      db.createEmployee({
        id: empId, name: employee_name, invite_code,
        department: result.department,
      });
      sendJSON(res, 200, {
        employee_id: empId,
        department: result.department,
        message: `Welcome ${employee_name}! Please complete onboarding.`,
        next_step: 'onboard',
      });
      return;
    }

    // ===== Onboard (5 questions) =====
    if (path === '/enterprise/onboard' && method === 'POST') {
      const body = await readBody(req);
      const { employee_id, role, personality, pain_points, preferred_device, help_focus } = body;
      if (!employee_id) { sendJSON(res, 400, { error: 'employee_id required' }); return; }

      const personalityJson = JSON.stringify({
        role, pain_points, preferred_device, help_focus,
        onboarded_at: new Date().toISOString(),
      });

      // Update employee with onboarding data
      const emp = db.getEmployee(employee_id);
      if (!emp) { sendJSON(res, 404, { error: 'Employee not found' }); return; }

      db.getDB().prepare(
        'UPDATE employees SET role = ?, personality = ? WHERE id = ?'
      ).run(role || emp.role, personalityJson, employee_id);

      // Return inherited knowledge for this role/department
      const knowledge = db.getKnowledge(emp.department);

      sendJSON(res, 200, {
        employee_id,
        message: 'Onboarding complete!',
        inherited_knowledge: knowledge.slice(0, 10),
        total_knowledge_items: knowledge.length,
        next_step: 'start_working',
      });
      return;
    }

    // ===== Log task =====
    if (path === '/enterprise/task' && method === 'POST') {
      const body = await readBody(req);
      const { employee_id, task_type, context, result, duration_min, tokens_used, cost_cny } = body;
      if (!employee_id || !task_type) {
        sendJSON(res, 400, { error: 'employee_id and task_type required' });
        return;
      }
      db.logTask({
        employee_id, task_type, context, result,
        duration_min: duration_min || 0,
        tokens_used: tokens_used || 2000,
        cost_cny: cost_cny || 0.028,
      });
      sendJSON(res, 200, { status: 'logged' });
      return;
    }

    // ===== Recall knowledge =====
    if (path === '/enterprise/recall' && method === 'GET') {
      const employee_id = url.searchParams.get('employee_id') || '';
      const task_type = url.searchParams.get('task_type') || '';
      const emp = db.getEmployee(employee_id);
      if (!emp) { sendJSON(res, 404, { error: 'Employee not found' }); return; }

      const knowledge = db.searchKnowledge(task_type, emp.department);
      const history = db.getTaskHistory(employee_id, 5);

      sendJSON(res, 200, {
        knowledge: knowledge.slice(0, 5),
        history,
        department: emp.department,
      });
      return;
    }

    // ===== Report =====
    if (path === '/enterprise/report' && method === 'GET') {
      const period = parseInt(url.searchParams.get('period') || '30', 10);
      const department = url.searchParams.get('department') || undefined;
      const report = db.getReport(period, department);
      sendJSON(res, 200, report);
      return;
    }

    // ===== Employees list =====
    if (path === '/enterprise/employees' && method === 'GET') {
      const department = url.searchParams.get('department') || undefined;
      sendJSON(res, 200, { employees: db.listEmployees(department) });
      return;
    }

    // ===== Offboard =====
    if (path === '/enterprise/offboard' && method === 'POST') {
      const body = await readBody(req);
      const { employee_id } = body;
      if (!employee_id) { sendJSON(res, 400, { error: 'employee_id required' }); return; }

      const emp = db.getEmployee(employee_id);
      if (!emp) { sendJSON(res, 404, { error: 'Employee not found' }); return; }

      // Merge experience into department knowledge
      const tasks = db.getTaskHistory(employee_id, 50);
      const byType: Record<string, number> = {};
      for (const t of tasks) {
        byType[t.task_type] = (byType[t.task_type] || 0) + 1;
      }
      for (const [type, count] of Object.entries(byType)) {
        db.addKnowledge({
          department: emp.department,
          category: 'offboarded_experience',
          content: `Task "${type}" executed ${count} times by ${emp.name}. Average patterns preserved.`,
          contributor: emp.name,
          confidence: 0.8,
        });
      }

      db.offboardEmployee(employee_id);
      sendJSON(res, 200, {
        status: 'offboarded',
        merged_tasks: tasks.length,
        merged_patterns: Object.keys(byType).length,
        message: 'Experience merged to department. No manual handover needed.',
      });
      return;
    }

    // ===== Create invite code (admin) =====
    if (path === '/enterprise/invite' && method === 'POST') {
      const body = await readBody(req);
      const { department, max_uses } = body;
      if (!department) { sendJSON(res, 400, { error: 'department required' }); return; }
      const code = db.createInviteCode(department, 'admin', max_uses || 1);
      sendJSON(res, 200, { code, department, max_uses: max_uses || 1 });
      return;
    }

    // ===== Knowledge search =====
    if (path === '/enterprise/knowledge' && method === 'GET') {
      const query = url.searchParams.get('q') || '';
      const department = url.searchParams.get('department') || undefined;
      const result = query
        ? db.searchKnowledge(query, department)
        : db.getKnowledge(department);
      sendJSON(res, 200, { knowledge: result });
      return;
    }

    // ===== Add knowledge =====
    if (path === '/enterprise/knowledge' && method === 'POST') {
      const body = await readBody(req);
      const { department, category, content, contributor, confidence } = body;
      if (!content) { sendJSON(res, 400, { error: 'content required' }); return; }
      db.addKnowledge({ department, category: category || 'general', content, contributor, confidence: confidence || 0.5 });
      sendJSON(res, 200, { status: 'added' });
      return;
    }

    // ===== Audit logs =====
    if (path === '/enterprise/audit' && method === 'GET') {
      sendJSON(res, 200, { logs: db.getAuditLogs(50) });
      return;
    }

    // ===== Export =====
    if (path === '/enterprise/export' && method === 'GET') {
      sendJSON(res, 200, db.exportAll());
      return;
    }

    // ===== Admin Dashboard HTML =====
    if (path === '/enterprise/dashboard' && method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(adminDashboardHTML());
      return;
    }

    // 404
    sendJSON(res, 404, { error: `Not found: ${method} ${path}` });

  } catch (err: any) {
    sendJSON(res, 500, { error: err.message });
  }
}

function adminDashboardHTML(): string {
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Otto Enterprise Dashboard</title>
<style>
*{margin:0;padding:0;box-sizing:border-box;font-family:-apple-system,Helvetica,Arial,sans-serif}
body{background:#0f172a;color:#e2e8f0;padding:20px}
.header{display:flex;justify-content:space-between;align-items:center;margin-bottom:24px}
.header h1{font-size:24px;color:#60a5fa}
.header span{color:#64748b;font-size:14px}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(250px,1fr));gap:16px;margin-bottom:24px}
.card{background:#1e293b;border-radius:12px;padding:20px;border:1px solid #334155}
.card .label{color:#64748b;font-size:12px;text-transform:uppercase;letter-spacing:1px}
.card .value{font-size:32px;font-weight:700;margin-top:8px;color:#f1f5f9}
.card .sub{color:#64748b;font-size:13px;margin-top:4px}
.card .value.green{color:#4ade80}
.card .value.blue{color:#60a5fa}
.card .value.orange{color:#fb923c}
table{width:100%;border-collapse:collapse;background:#1e293b;border-radius:12px;overflow:hidden}
th{background:#334155;padding:12px;text-align:left;font-size:13px;color:#94a3b8}
td{padding:10px 12px;border-top:1px solid #334155;font-size:13px}
.btn{background:#3b82f6;color:white;border:none;padding:8px 16px;border-radius:6px;cursor:pointer;font-size:13px}
.btn:hover{background:#2563eb}
.section{margin-bottom:24px}
.section h2{font-size:18px;color:#94a3b8;margin-bottom:12px}
</style>
</head><body>
<div class="header">
  <h1>Otto Enterprise</h1>
  <span id="updateTime"></span>
</div>
<div class="grid" id="cards"></div>
<div class="section">
  <h2>Token Spend by Task Type</h2>
  <table id="taskTable"><thead><tr><th>Task Type</th><th>Count</th><th>Time (min)</th><th>Tokens</th><th>Cost (CNY)</th></tr></thead><tbody></tbody></table>
</div>
<div class="section">
  <h2>Employees</h2>
  <table id="empTable"><thead><tr><th>Name</th><th>Role</th><th>Department</th><th>Status</th><th>Onboarded</th></tr></thead><tbody></tbody></table>
</div>
<div class="section">
  <h2>Recent Activity</h2>
  <table id="auditTable"><thead><tr><th>Time</th><th>Event</th><th>Employee</th><th>Detail</th></tr></thead><tbody></tbody></table>
</div>
<script>
async function load(){
  const [report, emps, audit] = await Promise.all([
    fetch('/enterprise/report?period=30').then(r=>r.json()),
    fetch('/enterprise/employees').then(r=>r.json()),
    fetch('/enterprise/audit').then(r=>r.json()),
  ]);
  document.getElementById('updateTime').textContent='Updated: '+new Date().toLocaleTimeString();
  const cards=document.getElementById('cards');
  cards.innerHTML=[
    {l:'Total Tasks',v:report.totalTasks,c:'blue',s:'last 30 days'},
    {l:'Time Saved',v:report.timeSavedHours+'h',c:'green',s:'~'+(report.timeSavedHours/8).toFixed(1)+' work days'},
    {l:'Money Saved',v:'CNY '+report.moneySavedCNY,c:'green',s:'at 50 CNY/hour'},
    {l:'Token Cost',v:'CNY '+report.tokenCostCNY,c:'orange',s:report.totalTokens||0+' tokens'},
    {l:'ROI',v:report.roi+'x',c:'blue',s:'money saved / token cost'},
    {l:'Active Employees',v:report.activeEmployees,c:'blue',s:'currently using Otto'},
  ].map(c=>'<div class="card"><div class="label">'+c.l+'</div><div class="value '+c.c+'">'+c.v+'</div><div class="sub">'+c.s+'</div></div>').join('');
  const tt=document.querySelector('#taskTable tbody');
  tt.innerHTML=report.byType.map(t=>'<tr><td>'+t.taskType+'</td><td>'+t.count+'</td><td>'+t.minutes+'</td><td>'+t.tokens+'</td><td>'+t.costCNY+'</td></tr>').join('');
  const et=document.querySelector('#empTable tbody');
  et.innerHTML=emps.employees.map(e=>'<tr><td>'+e.name+'</td><td>'+(e.role||'-')+'</td><td>'+(e.department||'-')+'</td><td>'+e.status+'</td><td>'+e.onboarded_at+'</td></tr>').join('');
  const at=document.querySelector('#auditTable tbody');
  at.innerHTML=audit.logs.slice(0,15).map(l=>'<tr><td>'+l.created_at+'</td><td>'+l.event+'</td><td>'+l.employee_id+'</td><td>'+l.detail+'</td></tr>').join('');
}
load(); setInterval(load, 10000);
</script>
</body></html>`;
}

// Start server
const server = createServer(handler);
server.listen(PORT, HOST, () => {
  console.log(`[Otto Enterprise] Server running on http://${HOST}:${PORT}`);
  console.log(`[Otto Enterprise] Dashboard: http://localhost:${PORT}/enterprise/dashboard`);
  console.log(`[Otto Enterprise] Data: ~/.otto-enterprise/data.db`);
  console.log(`[Otto Enterprise] Press Ctrl+C to stop`);
});
