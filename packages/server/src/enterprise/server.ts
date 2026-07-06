/**
 * @license Copyright 2026 Felix SPDX-License-Identifier: Apache-2.0
 *
 * Enterprise Server - HTTP API for Otto Enterprise.
 * 跑在管理员/老板设备上，所有数据本地（node:sqlite），零云端。
 *
 * 相对 enterprise 分支原版做的加固（optimize）：
 *   1. 默认只监听 127.0.0.1（原版 0.0.0.0 全网裸奔）；要局域网暴露须显式设 HOST。
 *   2. 管理端路由（invite/offboard/export/audit/employees/report/dashboard）需 admin token；
 *      监听非本地又没设 token 时自动生成并打印，绝不无鉴权对外。
 *   3. 去掉通配 CORS（`*`）——看板是同源 fetch，不需要跨域放行。
 *   4. 看板对「省时/省钱/ROI」显式标注「估算」，不把估值当实测。
 *   5. 不在模块顶层 listen()，导出 create/start 函数，可被测试/桌面按需拉起。
 *
 * Endpoints:
 *   POST /enterprise/join      GET  /enterprise/recall     GET  /enterprise/audit*
 *   POST /enterprise/onboard   GET  /enterprise/report*    GET  /enterprise/export*
 *   POST /enterprise/task      GET  /enterprise/employees* GET  /enterprise/health
 *   POST /enterprise/offboard* POST /enterprise/invite*    GET  /enterprise/dashboard*
 *   GET/POST /enterprise/knowledge          (* = 需要 admin token)
 */

import {
  createServer,
  type Server,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import * as db from './db.js';

const DEFAULT_PORT = 7777;

/** 需要管理员令牌的路由（读/写全公司数据或改员工状态）。 */
const ADMIN_ROUTES = new Set([
  '/enterprise/invite',
  '/enterprise/offboard',
  '/enterprise/export',
  '/enterprise/audit',
  '/enterprise/employees',
  '/enterprise/report',
  '/enterprise/dashboard',
]);

interface RouteBody {
  [key: string]: unknown;
}

export interface EnterpriseServerOptions {
  port?: number;
  host?: string;
  /** 管理端令牌；不传则读 OTTO_ENTERPRISE_ADMIN_TOKEN。 */
  adminToken?: string;
}

function isLoopback(host: string): boolean {
  return host === '127.0.0.1' || host === '::1' || host === 'localhost';
}

function sendJSON(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(JSON.stringify(data));
}

function readBody(req: IncomingMessage): Promise<RouteBody> {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 1_000_000) body = body.slice(0, 1_000_000); // 防超大 body
    });
    req.on('end', () => {
      try {
        resolve(body ? (JSON.parse(body) as RouteBody) : {});
      } catch {
        resolve({});
      }
    });
  });
}

/** 从 header / bearer / query 里取令牌。 */
function extractToken(req: IncomingMessage, url: URL): string {
  const h = req.headers['x-otto-admin-token'];
  if (typeof h === 'string' && h) return h;
  const auth = req.headers['authorization'];
  if (typeof auth === 'string' && auth.startsWith('Bearer ')) return auth.slice(7);
  return url.searchParams.get('token') || '';
}

function tokensMatch(a: string, b: string): boolean {
  if (!a || !b || a.length !== b.length) return false;
  try {
    return timingSafeEqual(Buffer.from(a), Buffer.from(b));
  } catch {
    return false;
  }
}

function makeHandler(adminToken: string) {
  return async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url || '/', `http://${req.headers.host}`);
    const path = url.pathname;
    const method = req.method || 'GET';

    if (method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    // 管理端鉴权：配置了 token 时，管理路由必须带上正确 token。
    if (adminToken && ADMIN_ROUTES.has(path)) {
      if (!tokensMatch(extractToken(req, url), adminToken)) {
        sendJSON(res, 401, { error: 'unauthorized: admin token required' });
        return;
      }
    }

    try {
      // ===== Health =====
      if (path === '/enterprise/health' && method === 'GET') {
        sendJSON(res, 200, { status: 'ok', uptime: process.uptime(), db: 'connected' });
        return;
      }

      // ===== Join (employee uses invite code) =====
      if (path === '/enterprise/join' && method === 'POST') {
        const body = await readBody(req);
        const invite_code = body.invite_code as string | undefined;
        const employee_name = body.employee_name as string | undefined;
        if (!invite_code || !employee_name) {
          sendJSON(res, 400, { error: 'invite_code and employee_name required' });
          return;
        }
        const result = db.validateInviteCode(invite_code);
        if (!result.valid) {
          sendJSON(res, 403, { error: result.error });
          return;
        }
        const empId = `emp_${Date.now()}_${randomBytes(3).toString('hex')}`;
        db.createEmployee({
          id: empId,
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
        return;
      }

      // ===== Onboard (5 questions) =====
      if (path === '/enterprise/onboard' && method === 'POST') {
        const body = await readBody(req);
        const employee_id = body.employee_id as string | undefined;
        const { role, pain_points, preferred_device, help_focus } = body;
        if (!employee_id) {
          sendJSON(res, 400, { error: 'employee_id required' });
          return;
        }

        const personalityJson = JSON.stringify({
          role,
          pain_points,
          preferred_device,
          help_focus,
          onboarded_at: new Date().toISOString(),
        });

        const emp = db.getEmployee(employee_id) as { role?: string; department?: string } | null;
        if (!emp) {
          sendJSON(res, 404, { error: 'Employee not found' });
          return;
        }

        db.getDB()
          .prepare('UPDATE employees SET role = ?, personality = ? WHERE id = ?')
          .run((role as string) || emp.role, personalityJson, employee_id);

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
        const employee_id = body.employee_id as string | undefined;
        const task_type = body.task_type as string | undefined;
        if (!employee_id || !task_type) {
          sendJSON(res, 400, { error: 'employee_id and task_type required' });
          return;
        }
        db.logTask({
          employee_id,
          task_type,
          context: body.context as string | undefined,
          result: body.result as string | undefined,
          duration_min: (body.duration_min as number) || 0,
          tokens_used: (body.tokens_used as number) ?? db.ESTIMATE.defaultTokensPerTask,
          cost_cny: (body.cost_cny as number) ?? db.ESTIMATE.defaultCostPerTaskCNY,
        });
        sendJSON(res, 200, { status: 'logged' });
        return;
      }

      // ===== Recall knowledge =====
      if (path === '/enterprise/recall' && method === 'GET') {
        const employee_id = url.searchParams.get('employee_id') || '';
        const task_type = url.searchParams.get('task_type') || '';
        const emp = db.getEmployee(employee_id) as { department?: string } | null;
        if (!emp) {
          sendJSON(res, 404, { error: 'Employee not found' });
          return;
        }
        const knowledge = db.searchKnowledge(task_type, emp.department);
        const history = db.getTaskHistory(employee_id, 5);
        sendJSON(res, 200, { knowledge: knowledge.slice(0, 5), history, department: emp.department });
        return;
      }

      // ===== Report =====
      if (path === '/enterprise/report' && method === 'GET') {
        const period = parseInt(url.searchParams.get('period') || '30', 10);
        const department = url.searchParams.get('department') || undefined;
        sendJSON(res, 200, db.getReport(period, department));
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
        const employee_id = body.employee_id as string | undefined;
        if (!employee_id) {
          sendJSON(res, 400, { error: 'employee_id required' });
          return;
        }
        const emp = db.getEmployee(employee_id) as { name?: string; department?: string } | null;
        if (!emp) {
          sendJSON(res, 404, { error: 'Employee not found' });
          return;
        }
        const tasks = db.getTaskHistory(employee_id, 50) as Array<{ task_type: string }>;
        const byType: Record<string, number> = {};
        for (const t of tasks) byType[t.task_type] = (byType[t.task_type] || 0) + 1;
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
        const department = body.department as string | undefined;
        const max_uses = body.max_uses as number | undefined;
        if (!department) {
          sendJSON(res, 400, { error: 'department required' });
          return;
        }
        const code = db.createInviteCode(department, 'admin', max_uses || 1);
        sendJSON(res, 200, { code, department, max_uses: max_uses || 1 });
        return;
      }

      // ===== Knowledge search =====
      if (path === '/enterprise/knowledge' && method === 'GET') {
        const query = url.searchParams.get('q') || '';
        const department = url.searchParams.get('department') || undefined;
        const result = query ? db.searchKnowledge(query, department) : db.getKnowledge(department);
        sendJSON(res, 200, { knowledge: result });
        return;
      }

      // ===== Add knowledge =====
      if (path === '/enterprise/knowledge' && method === 'POST') {
        const body = await readBody(req);
        const content = body.content as string | undefined;
        if (!content) {
          sendJSON(res, 400, { error: 'content required' });
          return;
        }
        db.addKnowledge({
          department: body.department as string | undefined,
          category: (body.category as string) || 'general',
          content,
          contributor: body.contributor as string | undefined,
          confidence: (body.confidence as number) || 0.5,
        });
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
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'X-Content-Type-Options': 'nosniff',
        });
        res.end(adminDashboardHTML(adminToken));
        return;
      }

      sendJSON(res, 404, { error: `Not found: ${method} ${path}` });
    } catch (err: unknown) {
      const m = err instanceof Error ? err.message : String(err);
      sendJSON(res, 500, { error: m });
    }
  };
}

function adminDashboardHTML(token: string): string {
  // 看板自身的 fetch 要带上 admin token（report/employees/audit 都是管理路由）。
  const tokenJson = JSON.stringify(token || '');
  return `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Otto Enterprise Dashboard</title>
<style>
*{margin:0;padding:0;box-sizing:border-box;font-family:-apple-system,'PingFang SC',Helvetica,Arial,sans-serif}
body{background:#0f172a;color:#e2e8f0;padding:24px}
.header{display:flex;justify-content:space-between;align-items:baseline;margin-bottom:6px}
.header h1{font-size:24px;color:#60a5fa;letter-spacing:.5px}
.header span{color:#64748b;font-size:13px}
.note{color:#64748b;font-size:12px;margin-bottom:20px}
.note b{color:#fb923c}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:14px;margin-bottom:26px}
.card{background:#1e293b;border-radius:12px;padding:18px 20px;border:1px solid #334155}
.card .label{color:#94a3b8;font-size:12px;letter-spacing:.5px;display:flex;gap:6px;align-items:center}
.card .est{font-size:10px;color:#fb923c;border:1px solid #fb923c55;border-radius:4px;padding:0 4px}
.card .value{font-size:30px;font-weight:700;margin-top:10px;color:#f1f5f9}
.card .sub{color:#64748b;font-size:12px;margin-top:5px}
.card .value.green{color:#4ade80}.card .value.blue{color:#60a5fa}.card .value.orange{color:#fb923c}
table{width:100%;border-collapse:collapse;background:#1e293b;border-radius:12px;overflow:hidden}
th{background:#334155;padding:11px 12px;text-align:left;font-size:12px;color:#94a3b8;font-weight:600}
td{padding:10px 12px;border-top:1px solid #334155;font-size:13px}
.section{margin-bottom:26px}
.section h2{font-size:16px;color:#94a3b8;margin-bottom:11px}
.empty{color:#475569;font-size:13px;padding:14px;text-align:center}
.charts{display:grid;grid-template-columns:repeat(auto-fit,minmax(340px,1fr));gap:14px;margin-bottom:26px}
.chart-card{background:#1e293b;border:1px solid #334155;border-radius:12px;padding:16px 18px}
.chart-card h3{font-size:14px;color:#94a3b8;margin-bottom:12px;font-weight:600}
.chart-card svg{width:100%;height:auto;display:block}
.chart-empty{color:#475569;font-size:13px;padding:28px 0;text-align:center}
.bottlenecks{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:12px}
.bn{background:#1e293b;border:1px solid #334155;border-left:3px solid #fb923c;border-radius:8px;padding:12px 14px}
.bn .k{color:#94a3b8;font-size:12px;margin-bottom:6px}
.bn .t{color:#f1f5f9;font-size:15px;font-weight:600}
.bn .m{color:#64748b;font-size:12px;margin-top:4px}
</style>
</head><body>
<div class="header"><h1>Otto Enterprise</h1><span id="updateTime"></span></div>
<div class="note" id="discloseNote">数据全部存在本机 <b>~/.otto-enterprise/data.db</b>，零云端。标 <b>估算</b> 的指标基于假设，非实测。</div>
<div class="grid" id="cards"></div>
<div class="charts">
  <div class="chart-card"><h3>各任务类型：耗时与次数</h3><div id="barChart"></div></div>
  <div class="chart-card"><h3>累计省时趋势（按任务累积）</h3><div id="lineChart"></div></div>
</div>
<div class="section"><h2>瓶颈提示</h2><div class="bottlenecks" id="bottlenecks"></div></div>
<div class="section"><h2>各任务类型 Token 花费</h2>
  <table id="taskTable"><thead><tr><th>任务类型</th><th>次数</th><th>时长(分)</th><th>Tokens</th><th>成本(元)</th></tr></thead><tbody></tbody></table></div>
<div class="section"><h2>员工</h2>
  <table id="empTable"><thead><tr><th>姓名</th><th>岗位</th><th>部门</th><th>状态</th><th>入职时间</th></tr></thead><tbody></tbody></table></div>
<div class="section"><h2>最近动态</h2>
  <table id="auditTable"><thead><tr><th>时间</th><th>事件</th><th>员工</th><th>详情</th></tr></thead><tbody></tbody></table></div>
<script>
const TOKEN=${tokenJson};
const H=TOKEN?{'x-otto-admin-token':TOKEN}:{};
const esc=s=>String(s==null?'':s).replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
async function j(u){const r=await fetch(u,{headers:H});if(!r.ok)throw new Error(u+' '+r.status);return r.json();}
// ---- 内联 SVG 图表（无外部依赖，CSP 友好）----
function barChartSVG(rows){
  if(!rows||!rows.length)return '<div class="chart-empty">暂无任务数据</div>';
  const W=460,H=40+rows.length*34,padL=90,padR=54,barH=18;
  const maxMin=Math.max(1,...rows.map(r=>r.minutes));
  let s='<svg viewBox="0 0 '+W+' '+H+'" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="各任务类型耗时柱状图">';
  rows.forEach((r,i)=>{
    const y=24+i*34;
    const w=Math.round((W-padL-padR)*r.minutes/maxMin);
    s+='<text x="'+(padL-8)+'" y="'+(y+barH-5)+'" text-anchor="end" fill="#94a3b8" font-size="12">'+esc(r.taskType)+'</text>';
    s+='<rect x="'+padL+'" y="'+y+'" width="'+Math.max(w,2)+'" height="'+barH+'" rx="4" fill="#60a5fa"/>';
    s+='<text x="'+(padL+Math.max(w,2)+6)+'" y="'+(y+barH-5)+'" fill="#e2e8f0" font-size="11">'+r.minutes+'分 · '+r.count+'次</text>';
  });
  s+='</svg>';return s;
}
function lineChartSVG(trend){
  if(!trend||trend.length<2)return '<div class="chart-empty">数据点不足，无法绘制趋势</div>';
  const W=460,H=200,padL=44,padR=16,padT=16,padB=28;
  const n=trend.length;
  const maxY=Math.max(1,...trend.map(p=>p.cumSavedHours));
  const px=i=>padL+(W-padL-padR)*(n===1?0:i/(n-1));
  const py=v=>padT+(H-padT-padB)*(1-v/maxY);
  let path='';
  trend.forEach((p,i)=>{path+=(i?'L':'M')+px(i).toFixed(1)+' '+py(p.cumSavedHours).toFixed(1)+' ';});
  const area=path+'L'+px(n-1).toFixed(1)+' '+py(0)+' L'+px(0).toFixed(1)+' '+py(0)+' Z';
  let s='<svg viewBox="0 0 '+W+' '+H+'" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="累计省时趋势折线图">';
  // 网格 + Y 轴刻度
  for(let g=0;g<=2;g++){const v=maxY*g/2;const y=py(v);s+='<line x1="'+padL+'" y1="'+y+'" x2="'+(W-padR)+'" y2="'+y+'" stroke="#334155" stroke-width="1"/>';s+='<text x="'+(padL-6)+'" y="'+(y+4)+'" text-anchor="end" fill="#64748b" font-size="10">'+(Math.round(v*10)/10)+'h</text>';}
  s+='<path d="'+area+'" fill="#4ade8022"/>';
  s+='<path d="'+path.trim()+'" fill="none" stroke="#4ade80" stroke-width="2"/>';
  s+='<text x="'+padL+'" y="'+(H-8)+'" fill="#64748b" font-size="10">第1个任务</text>';
  s+='<text x="'+(W-padR)+'" y="'+(H-8)+'" text-anchor="end" fill="#64748b" font-size="10">第'+n+'个任务</text>';
  s+='</svg>';return s;
}
function bottlenecksHTML(b){
  if(!b)return '<div class="chart-empty">暂无数据</div>';
  const items=[];
  if(b.slowestTotal)items.push({k:'累计最耗时',t:b.slowestTotal.taskType,m:'共 '+b.slowestTotal.minutes+' 分钟'});
  if(b.mostFrequent)items.push({k:'最频繁',t:b.mostFrequent.taskType,m:'共 '+b.mostFrequent.count+' 次'});
  if(b.slowestAvg)items.push({k:'单次平均最慢',t:b.slowestAvg.taskType,m:'平均 '+b.slowestAvg.avgMinutes+' 分钟/次'});
  if(!items.length)return '<div class="chart-empty">暂无数据</div>';
  return items.map(x=>'<div class="bn"><div class="k">'+x.k+'</div><div class="t">'+esc(x.t)+'</div><div class="m">'+x.m+'</div></div>').join('');
}
async function load(){
  try{
    const [report,emps,audit]=await Promise.all([j('/enterprise/report?period=30'),j('/enterprise/employees'),j('/enterprise/audit')]);
    document.getElementById('updateTime').textContent='更新于 '+new Date().toLocaleTimeString();
    const est='<span class="est">估算</span>';
    const a=report.assumptions||{manualTimeMultiplier:2,cnyPerHour:50};
    // 披露文案直接引用后端返回的假设常量，不再手写数字，杜绝文案与代码打架。
    document.getElementById('discloseNote').innerHTML='数据全部存在本机 <b>~/.otto-enterprise/data.db</b>，零云端。标 '+est+' 的指标基于假设（纯人工耗时按 <b>'+a.manualTimeMultiplier+'×</b> Otto 折算、人力 <b>¥'+a.cnyPerHour+'/时</b>），非实测。省时 = Otto 耗时 ×（倍率−1），只算净节省、不双算。';
    const cards=[
      {l:'总任务数',v:report.totalTasks,c:'blue',s:'近 30 天',e:0},
      {l:'省下时间',v:report.timeSavedHours+'h',c:'green',s:'约 '+(report.timeSavedHours/8).toFixed(1)+' 个工作日（净节省）',e:1},
      {l:'省下人力成本',v:'¥'+report.laborSavedCNY,c:'green',s:'按 ¥'+a.cnyPerHour+'/时折算',e:1},
      {l:'Token 成本',v:'¥'+report.tokenCostCNY,c:'orange',s:(report.totalTokens||0)+' tokens',e:0},
      {l:'净收益',v:'¥'+report.netBenefitCNY,c:(report.netBenefitCNY>=0?'green':'orange'),s:'省下人力 − Token 成本',e:1},
      {l:'每 ¥1 Token 产出',v:'¥'+report.laborPerTokenCNY,c:'blue',s:'估算省下的人力（非纯倍率）',e:1},
      {l:'活跃员工',v:report.activeEmployees,c:'blue',s:'正在使用 Otto',e:0},
    ];
    document.getElementById('cards').innerHTML=cards.map(c=>'<div class="card"><div class="label">'+c.l+(c.e?est:'')+'</div><div class="value '+c.c+'">'+c.v+'</div><div class="sub">'+c.s+'</div></div>').join('');
    document.getElementById('barChart').innerHTML=barChartSVG(report.byType);
    document.getElementById('lineChart').innerHTML=lineChartSVG(report.trend);
    document.getElementById('bottlenecks').innerHTML=bottlenecksHTML(report.bottlenecks);
    const tb=document.querySelector('#taskTable tbody');
    tb.innerHTML=report.byType.length?report.byType.map(t=>'<tr><td>'+esc(t.taskType)+'</td><td>'+t.count+'</td><td>'+t.minutes+'</td><td>'+t.tokens+'</td><td>'+t.costCNY+'</td></tr>').join(''):'<tr><td colspan="5" class="empty">暂无任务数据</td></tr>';
    const eb=document.querySelector('#empTable tbody');
    eb.innerHTML=emps.employees.length?emps.employees.map(e=>'<tr><td>'+esc(e.name)+'</td><td>'+esc(e.role||'-')+'</td><td>'+esc(e.department||'-')+'</td><td>'+esc(e.status)+'</td><td>'+esc(e.onboarded_at)+'</td></tr>').join(''):'<tr><td colspan="5" class="empty">暂无员工</td></tr>';
    const ab=document.querySelector('#auditTable tbody');
    ab.innerHTML=audit.logs.length?audit.logs.slice(0,15).map(l=>'<tr><td>'+esc(l.created_at)+'</td><td>'+esc(l.event)+'</td><td>'+esc(l.employee_id)+'</td><td>'+esc(l.detail)+'</td></tr>').join(''):'<tr><td colspan="4" class="empty">暂无动态</td></tr>';
  }catch(err){document.getElementById('updateTime').textContent='加载失败：'+err.message;}
}
load();setInterval(load,10000);
</script>
</body></html>`;
}

/**
 * 组装企业服务端（不 listen）。会算好 host/port/token：
 * 监听非本地又没给 token → 自动生成一枚并回传（调用方负责打印/落盘），绝不裸奔。
 */
export function createEnterpriseServer(opts: EnterpriseServerOptions = {}): {
  server: Server;
  host: string;
  port: number;
  adminToken: string;
  generatedToken: boolean;
} {
  const host = opts.host || process.env.OTTO_ENTERPRISE_HOST || '127.0.0.1';
  const port = opts.port || parseInt(process.env.OTTO_ENTERPRISE_PORT || String(DEFAULT_PORT), 10);
  let adminToken = opts.adminToken ?? process.env.OTTO_ENTERPRISE_ADMIN_TOKEN ?? '';
  let generatedToken = false;
  if (!adminToken && !isLoopback(host)) {
    adminToken = randomBytes(18).toString('base64url');
    generatedToken = true;
  }
  const server = createServer(makeHandler(adminToken));
  return { server, host, port, adminToken, generatedToken };
}

/** 组装并 listen；返回 http.Server。打印访问地址与（如有）自动生成的 token。 */
export function startEnterpriseServer(opts: EnterpriseServerOptions = {}): Server {
  const { server, host, port, adminToken, generatedToken } = createEnterpriseServer(opts);
  server.listen(port, host, () => {
    const tokenQuery = adminToken ? `?token=${adminToken}` : '';
    console.log(`[Otto Enterprise] 服务端运行于 http://${host}:${port}`);
    console.log(`[Otto Enterprise] 老板看板: http://localhost:${port}/enterprise/dashboard${tokenQuery}`);
    console.log(`[Otto Enterprise] 数据: ~/.otto-enterprise/data.db（本地，零云端）`);
    if (adminToken) {
      console.log(
        `[Otto Enterprise] 管理令牌${generatedToken ? '（自动生成，请保存）' : ''}: ${adminToken}`,
      );
    } else {
      console.log('[Otto Enterprise] 仅本机访问，未设管理令牌（设 OTTO_ENTERPRISE_ADMIN_TOKEN 可加固）');
    }
    console.log('[Otto Enterprise] Ctrl+C 停止');
  });
  return server;
}
