/**
 * @license
 * Copyright 2025 Otto
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Electron 主进程（Issue #4 + #9）。
 *
 * 职责：
 *   1. 建主窗口（含图标占位），加载 renderer（dist/renderer/index.html）。
 *   2. 安全基线：禁 nodeIntegration、开 contextIsolation + sandbox、本地 CSP、
 *      导航/新窗口/权限/webview 全部按白名单收紧。
 *   3. 用 ServerManager 确保有可用 otto-server：发现已运行的就复用，否则
 *      同进程内嵌拉起（embedded-only；随 app 退出而停）。
 *   4. 把发现/拉起的 server 端点经 IPC（拉取 + 主动推送）交给 preload，
 *      供 renderer 建 WS 连接。
 *   5. 完整生命周期：单实例锁、activate、window-all-closed、before-quit、
 *      渲染进程崩溃 / 卡死处置。
 *
 * 注意：package.json 无 "type":"module" → main/preload 均编译为 CJS（Electron 标准，
 * 且 import.meta.url 在 CJS 输出下会被 tsc 直接拒绝/TS1470）。__dirname 用 CJS 原生
 * 全局变量，不需要（也不能用）ESM 的 fileURLToPath(import.meta.url) 重建。
 */

import {
  app,
  BrowserWindow,
  ipcMain,
  nativeImage,
  nativeTheme,
  session,
  shell,
  type NativeImage,
} from 'electron';
import { fileURLToPath } from 'node:url';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { DEFAULT_HOST, DEFAULT_PORT, type ServerEndpoint } from 'otto-server';
import { ServerManager } from './server-manager.js';
import { installAppMenu } from './menu.js';

/**
 * renderer 静态资源目录。与 createWindow 的 loadFile 用同一推导
 * （dist/main → dist/renderer），开发模式与 asar 打包内路径均成立；
 * 也是 isLocalAppUrl 白名单的锚点。
 */
const RENDERER_DIR = path.join(__dirname, '../renderer');

/** 渲染进程崩溃自动重载的退避：窗口期内超过上限就不再 reload，防白屏无限闪烁。 */
const CRASH_RELOAD_WINDOW_MS = 60_000;
const CRASH_RELOAD_MAX = 3;

/** server 生命周期管理器（发现/拉起/探活/退出清理）。 */
const serverManager = new ServerManager();
/** 当前 server 端点（发现的或拉起的）。renderer 经 IPC 取它建 WS。 */
let endpoint: ServerEndpoint | undefined;
/** 主窗口单例引用。 */
let mainWindow: BrowserWindow | undefined;

// ── IPC channel 名（与 preload 对齐）──
const IPC = {
  getEndpoint: 'otto:get-endpoint',
  endpointChanged: 'otto:endpoint-changed',
  openExternal: 'otto:open-external',
  openPath: 'otto:open-path',
  feishuStart: 'otto:feishu-start',
  feishuStop: 'otto:feishu-stop',
  feishuStatus: 'otto:feishu-status',
  skillLeaderboard: 'otto:skill-leaderboard',
  workLogToday: 'otto:worklog-today',
  auditLogRecent: 'otto:auditlog-recent',
  skillShareList: 'otto:skill-share-list',
  skillMarketplace: 'otto:skill-marketplace',
} as const;

/**
 * 飞书一键开关在桌面端的现状（诚实说明）。
 *
 * 飞书 daemon 的真实启停逻辑在 CLI 包（otto feishu daemon），它依赖 `otto --feishu`
 * 这个 CLI 进程入口（通过 process.argv[1] 定位 otto.js）。在 Electron 主进程里
 * process.argv[1] 指向的是 Electron/app 入口而非 otto.js，直接调用会 spawn 错误的
 * 进程；且 desktop 目前并未依赖 CLI 包。因此桌面端暂不直接代管飞书 daemon。
 *
 * 处置：注册这三个 handler，让 renderer 的调用不再 reject 报「操作失败」，而是拿到
 * 一句明确的「桌面端暂不支持、请用 CLI」——诚实告知，绝不假报「已开启 / 运行中」。
 */
const FEISHU_DESKTOP_NOTICE =
  '桌面端暂不支持在此一键启停飞书守护进程。\n' +
  '请在终端使用命令行：otto feishu daemon start / stop / status。\n' +
  '（该能力后续接入桌面端后此开关才会启用。）';

// ────────────────────────────────────────────────────────────────────────
// 窗口
// ────────────────────────────────────────────────────────────────────────

/**
 * 加载窗口图标占位：dist/renderer/icon.png 存在则用，否则返回空 image
 * （Electron 在无图标时回退默认，不报错）。真正的品牌图标由 #8 打包时补。
 */
function loadIcon(): NativeImage {
  const iconPath = path.join(RENDERER_DIR, 'icon.png');
  if (fs.existsSync(iconPath)) {
    return nativeImage.createFromPath(iconPath);
  }
  return nativeImage.createEmpty();
}

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 720,
    minHeight: 480,
    title: 'Otto',
    // 初始底色跟随系统深浅：暗色 #181818 / 浅色 #ffffff。硬编码任一固定色会在
    // 系统主题与之相反时于内容就绪前（及窗口边缘）闪出错误底色。themeSource 已
    // 在 whenReady 里设为 'system'，故 shouldUseDarkColors 反映的即 OS 当前主题。
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#181818' : '#ffffff',
    icon: loadIcon(),
    // 内容就绪再显示，避免白屏闪烁。
    show: false,
    autoHideMenuBar: process.platform !== 'darwin',
    webPreferences: {
      // ── 安全基线（Issue #4）──
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webviewTag: false,
      // 禁用 renderer 直接走 Node 的 experimental features。
      preload: path.join(__dirname, '../preload/index.js'),
    },
  });

  win.once('ready-to-show', () => win.show());

  hardenWebContents(win);

  void win.loadFile(path.join(RENDERER_DIR, 'index.html'));
  return win;
}

/** 收紧单个窗口 webContents 的导航 / 新窗口行为。 */
function hardenWebContents(win: BrowserWindow): void {
  // 外链统一走系统浏览器，不在 app 内开新窗口。
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isExternalUrl(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });

  // 阻止 renderer 导航离开本地 app（防被劫持加载远程页）。
  win.webContents.on('will-navigate', (event, url) => {
    if (!isLocalAppUrl(url)) {
      event.preventDefault();
      if (isExternalUrl(url)) void shell.openExternal(url);
    }
  });

  // 渲染进程崩溃 / 卡死：记录并尝试恢复（重载）。带退避：60s 内最多重载
  // CRASH_RELOAD_MAX 次，超限视为必现崩溃，改为展示错误页，防白屏无限闪烁。
  let crashReloadTimes: number[] = [];
  win.webContents.on('render-process-gone', (_e, details) => {
    console.error('[otto-desktop] renderer 进程退出:', details.reason);
    if (details.reason === 'clean-exit' || win.isDestroyed()) return;
    const now = Date.now();
    crashReloadTimes = crashReloadTimes.filter(
      (t) => now - t < CRASH_RELOAD_WINDOW_MS,
    );
    if (crashReloadTimes.length < CRASH_RELOAD_MAX) {
      crashReloadTimes = [...crashReloadTimes, now];
      win.webContents.reload();
    } else {
      console.error(
        '[otto-desktop] renderer 短时间内反复崩溃，停止自动重载，改为展示错误页',
      );
      void win.webContents.loadURL(crashPageDataUrl());
    }
  });
  win.webContents.on('unresponsive', () => {
    console.warn('[otto-desktop] renderer 无响应');
  });
}

/**
 * 是否本地 app 资源：仅放行 renderer 目录内的 file:// URL。
 * 只判 file:// 前缀会放行任意本地文件，被劫持时可导航到磁盘上任何页面。
 */
function isLocalAppUrl(url: string): boolean {
  if (!url.startsWith('file://')) return false;
  try {
    const target = path.resolve(fileURLToPath(url));
    return (
      target === RENDERER_DIR || target.startsWith(RENDERER_DIR + path.sep)
    );
  } catch {
    // 非法 file URL（如带 host 段）→ 拒绝。
    return false;
  }
}

/** 反复崩溃后的兜底错误页（data: URL；朴素静态页，无脚本）。 */
function crashPageDataUrl(): string {
  const html =
    '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">' +
    '<title>Otto - 界面已停止响应</title></head>' +
    '<body style="margin:0;display:flex;align-items:center;justify-content:center;' +
    'min-height:100vh;background:#181818;color:#ddd;' +
    'font-family:system-ui,-apple-system,sans-serif">' +
    '<div style="max-width:32em;padding:2em;line-height:1.8">' +
    '<h1 style="font-size:1.3em;color:#fff">Otto 界面多次崩溃</h1>' +
    '<p>渲染进程在短时间内反复异常退出，已停止自动恢复以避免闪烁。</p>' +
    '<p>请退出并重新启动 Otto；若问题持续出现，请附终端日志反馈。</p>' +
    '</div></body></html>';
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

/** 是否可放行到系统浏览器的外链（仅 http/https）。 */
function isExternalUrl(url: string): boolean {
  return /^https?:\/\//i.test(url);
}

// ────────────────────────────────────────────────────────────────────────
// 安全：CSP + 权限
// ────────────────────────────────────────────────────────────────────────

/** 本地 CSP：只允许自身资源 + 连本地 server WS/HTTP。 */
function applyCsp(): void {
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    const host = endpoint?.host ?? DEFAULT_HOST;
    const port = endpoint?.port ?? DEFAULT_PORT;
    const csp = [
      "default-src 'self'",
      // renderer 由 webpack 内联样式（style-loader）→ 需要 'unsafe-inline' 样式。
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data:",
      "font-src 'self' data:",
      // 仅允许连本地 server（HTTP 拉历史 + WS 实时）。
      `connect-src 'self' http://${host}:${port} ws://${host}:${port}`,
      "script-src 'self'",
      "object-src 'none'",
      "base-uri 'self'",
      "frame-src 'none'",
    ].join('; ');
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [csp],
      },
    });
  });

  // 一律拒绝 renderer 的权限请求（摄像头/麦克风/地理位置等都用不到）。
  session.defaultSession.setPermissionRequestHandler((_wc, _perm, cb) =>
    cb(false),
  );
}

// ────────────────────────────────────────────────────────────────────────
// server 端点：发现/拉起 + 推送给 renderer
// ────────────────────────────────────────────────────────────────────────

/** 确保 server 可用并把端点缓存下来；失败不抛（renderer 显示「未连接」）。 */
async function ensureEndpoint(): Promise<void> {
  try {
    const ensured = await serverManager.ensure();
    endpoint = ensured.endpoint;
    console.log(
      `[otto-desktop] server ${ensured.ownership} @ http://${endpoint.host}:${endpoint.port}`,
    );
    pushEndpointToRenderer();
  } catch (e) {
    console.error('[otto-desktop] server 启动失败:', e);
  }
}

/** 主动把最新端点推给 renderer（preload 据此触发 connect）。 */
function pushEndpointToRenderer(): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(IPC.endpointChanged, endpoint ?? null);
  }
}

// ────────────────────────────────────────────────────────────────────────
// IPC
// ────────────────────────────────────────────────────────────────────────

function registerIpc(): void {
  // renderer 经 preload 拉当前端点（连接前 / 重连时）。
  ipcMain.handle(IPC.getEndpoint, () => endpoint ?? null);

  // host-only 命令（替代 webview 的 vscode host 命令；交付文档 [WEBVIEW] §5）。
  ipcMain.handle(IPC.openExternal, (_e, url: unknown) => {
    if (typeof url === 'string' && isExternalUrl(url)) {
      return shell.openExternal(url);
    }
    return Promise.resolve();
  });
  // 飞书一键开关（诚实占位）：桌面端暂不代管飞书 daemon，见 FEISHU_DESKTOP_NOTICE。
  // 返回明确的「暂不支持」而非 reject，让 renderer 显示真话而不是「操作失败」。
  // running 恒为 false：桌面端并未托管进程，不谎报「运行中」。
  ipcMain.handle(IPC.feishuStart, () =>
    Promise.resolve({ text: FEISHU_DESKTOP_NOTICE }),
  );
  ipcMain.handle(IPC.feishuStop, () =>
    Promise.resolve({ text: FEISHU_DESKTOP_NOTICE }),
  );
  ipcMain.handle(IPC.feishuStatus, () =>
    Promise.resolve({ text: FEISHU_DESKTOP_NOTICE, running: false }),
  );

  // Skill 排行榜：读取本地 skill-shares.json，返回排行榜+明星榜文本
  ipcMain.handle(IPC.skillLeaderboard, async (_e, teamId?: string) => {
    try {
      const sharesPath = path.join(process.cwd(), '.otto', 'org', 'skill-shares.json');
      let shares: any[] = [];
      try {
        const raw = await fs.promises.readFile(sharesPath, 'utf-8');
        shares = JSON.parse(raw);
      } catch { /* 文件不存在，返回空 */ }

      const activeShares = shares.filter((s: any) =>
        (!teamId || s.teamId === teamId) && s.status === 'active',
      );
      const teamName = activeShares[0]?.teamName || '本小组';

      // 排行榜文本
      const medals = ['1.', '2.', '3.'];
      const maxInstalls = Math.max(...activeShares.map((s: any) => s.installCount || 0), 1);
      const maxUsage = Math.max(...activeShares.map((s: any) => s.usageCount || 0), 1);

      const lbLines: string[] = [`${teamName} Skill 排行榜`, ''];
      const scored = activeShares.map((s: any) => {
        const ratingScore = (s.rating || 0) / 5 * 100;
        const installScore = (s.installCount || 0) / maxInstalls * 100;
        const successRate = s.usageCount > 0 ? (s.successCount || 0) / s.usageCount * 100 : 50;
        const usageScore = (s.usageCount || 0) / maxUsage * 100;
        return { s, score: ratingScore * 0.35 + installScore * 0.25 + successRate * 0.25 + usageScore * 0.15 };
      }).sort((a: any, b: any) => b.score - a.score);

      scored.forEach((item: any, i: number) => {
        const rank = i < 3 ? medals[i] : `${i + 1}.`;
        const stars = '⭐'.repeat(Math.round(item.s.rating || 0));
        lbLines.push(`${rank} ${item.s.skillName} (v${item.s.version || 1})`);
        lbLines.push(`   ${item.s.featureDescription || ''}`);
        lbLines.push(`   ${item.s.sharedByName} | ${stars || '暂无'}(${item.s.ratingCount || 0}人) | 装${item.s.installCount || 0} | 用${item.s.usageCount || 0} | ${item.score.toFixed(0)}分`);
        lbLines.push('');
      });

      // 明星榜文本
      const contributorMap: Record<string, any> = {};
      for (const s of activeShares) {
        if (!contributorMap[s.sharedBy]) {
          contributorMap[s.sharedBy] = { name: s.sharedByName, count: 0, installs: 0, skills: [] };
        }
        contributorMap[s.sharedBy].count++;
        contributorMap[s.sharedBy].installs += s.installCount || 0;
        contributorMap[s.sharedBy].skills.push(s.skillName);
      }
      const sbLines: string[] = [`${teamName} 贡献明星榜`, ''];
      Object.values(contributorMap).sort((a: any, b: any) => b.installs - a.installs).forEach((c: any, i: number) => {
        const rank = i < 3 ? medals[i] : `${i + 1}.`;
        sbLines.push(`${rank} ${c.name}`);
        sbLines.push(`   分享${c.count}个 | 安装${c.installs}次 | ${c.skills.join('、')}`);
        sbLines.push('');
      });

      return {
        leaderboard: lbLines.join('\n'),
        starBoard: sbLines.join('\n'),
        tabs: [
          { id: 'leaderboard', label: '排行榜', icon: '' },
          { id: 'stars', label: '明星榜', icon: '' },
        ],
      };
    } catch (err) {
      return {
        leaderboard: '暂无排行榜数据',
        starBoard: '暂无明星榜数据',
        tabs: [
          { id: 'leaderboard', label: '排行榜', icon: '' },
          { id: 'stars', label: '明星榜', icon: '' },
        ],
      };
    }
  });

  // 工作日志：读取今天的 JSONL 日志，生成汇总文本
  ipcMain.handle(IPC.workLogToday, async () => {
    try {
      const os = require('os');
      const pathMod = require('path');
      const worklogDir = pathMod.join(os.homedir(), '.otto-user', 'memory', 'worklog', 'daily');
      const today = new Date().toISOString().split('T')[0];
      const filePath = pathMod.join(worklogDir, `${today}.jsonl`);

      let entries: any[] = [];
      try {
        const raw = await fs.promises.readFile(filePath, 'utf-8');
        entries = raw.trim().split('\n').filter((l: string) => l.length > 0).map((l: string) => JSON.parse(l));
      } catch { /* 文件不存在 */ }

      if (entries.length === 0) {
        return { summary: '今天还没有操作记录。', date: today, totalActions: 0 };
      }

      const byCategory: Record<string, number> = {};
      let successCount = 0;
      let failCount = 0;
      const actionCounts: Record<string, number> = {};

      for (const entry of entries) {
        byCategory[entry.category] = (byCategory[entry.category] || 0) + 1;
        if (entry.success) successCount++; else failCount++;
        actionCounts[entry.action] = (actionCounts[entry.action] || 0) + 1;
      }

      const topActions = Object.entries(actionCounts).sort((a, b) => b[1] - a[1]).slice(0, 5);
      const firstTime = entries[0]?.timestamp || '';
      const lastTime = entries[entries.length - 1]?.timestamp || '';

      const cats = Object.entries(byCategory).sort((a, b) => b[1] - a[1]).map(([c, n]) => `${c}:${n}`).join(' | ');

      let summary = `今日工作日志 (${today})\n\n`;
      summary += `总操作：${entries.length} 次\n`;
      summary += `成功：${successCount}  失败：${failCount}\n`;
      summary += `首次：${firstTime.substring(11, 19) || '—'}\n`;
      summary += `最后：${lastTime.substring(11, 19) || '—'}\n\n`;
      summary += `分类：${cats}\n\n`;
      summary += `高频操作：\n`;
      for (const [action, count] of topActions) {
        summary += `  ${action} (${count}次)\n`;
      }

      return { summary, date: today, totalActions: entries.length };
    } catch (err) {
      return { summary: '读取工作日志失败。', date: '', totalActions: 0 };
    }
  });

  // 审计日志：读取最近N天的审计记录，生成报告
  ipcMain.handle(IPC.auditLogRecent, async (_e, days?: number, limit?: number) => {
    try {
      const os = require('os');
      const pathMod = require('path');
      const auditDir = pathMod.join(os.homedir(), '.otto-user', 'audit');
      const dayCount = days || 7;
      const maxResults = limit || 50;

      const entries: any[] = [];
      const today = new Date();
      for (let i = 0; i < dayCount; i++) {
        const d = new Date(today);
        d.setDate(d.getDate() - i);
        const dateStr = d.toISOString().split('T')[0];
        const filePath = pathMod.join(auditDir, `audit-${dateStr}.jsonl`);
        try {
          const raw = await fs.promises.readFile(filePath, 'utf-8');
          const dayEntries = raw.trim().split('\n').filter((l: string) => l.length > 0).map((l: string) => JSON.parse(l));
          entries.push(...dayEntries);
        } catch { /* 文件不存在 */ }
      }

      if (entries.length === 0) {
        return { report: `最近 ${dayCount} 天无审计记录。`, count: 0 };
      }

      // 按时间倒序
      entries.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
      const recent = entries.slice(0, maxResults);

      const byUser: Record<string, number> = {};
      const byCategory: Record<string, number> = {};
      let highRisk = 0;
      let successCount = 0;

      for (const e of entries) {
        byUser[e.userId] = (byUser[e.userId] || 0) + 1;
        byCategory[e.category] = (byCategory[e.category] || 0) + 1;
        if (e.riskLevel === 'high') highRisk++;
        if (e.success) successCount++;
      }

      let report = `审计日志 (最近${dayCount}天)\n\n`;
      report += `总操作：${entries.length} | 成功：${successCount} | 失败：${entries.length - successCount} | 高风险：${highRisk}\n\n`;
      report += `按用户：\n`;
      for (const [user, count] of Object.entries(byUser).sort((a, b) => b[1] - a[1])) {
        report += `  ${user}: ${count}次\n`;
      }
      report += `\n按类别：\n`;
      for (const [cat, count] of Object.entries(byCategory).sort((a, b) => b[1] - a[1])) {
        report += `  ${cat}: ${count}次\n`;
      }
      report += `\n最近 ${recent.length} 条记录：\n`;
      for (const e of recent) {
        const time = e.timestamp.substring(5, 19).replace('T', ' ');
        const risk = e.riskLevel === 'high' ? '[高风险]' : e.riskLevel === 'medium' ? '[中风险]' : '';
        report += `  ${time} ${e.userId} ${e.action} ${e.success ? 'OK' : 'FAIL'} ${risk}\n`;
      }

      return { report, count: entries.length };
    } catch (err) {
      return { report: '读取审计日志失败。', count: 0 };
    }
  });

  // 部门共享 Skill 列表
  ipcMain.handle(IPC.skillShareList, async (_e, teamId?: string) => {
    try {
      const sharesPath = path.join(process.cwd(), '.otto', 'org', 'skill-shares.json');
      let shares: any[] = [];
      try {
        shares = JSON.parse(await fs.promises.readFile(sharesPath, 'utf-8'));
      } catch { /* 无文件 */ }

      const active = shares.filter((s: any) =>
        s.status === 'active' && (!teamId || s.teamId === teamId),
      );

      if (active.length === 0) {
        return { text: '本部门暂无共享 Skill。' };
      }

      const lines: string[] = ['部门共享 Skill 列表', ''];
      for (const s of active) {
        const stars = '⭐'.repeat(Math.round(s.rating || 0));
        lines.push(`${s.skillName} (v${s.version || 1})`);
        lines.push(`  功能：${s.featureDescription || '暂无描述'}`);
        lines.push(`  分享者：${s.sharedByName}`);
        lines.push(`  评分：${stars || '暂无'} (${s.ratingCount || 0}人) | 安装：${s.installCount || 0}次 | 使用：${s.usageCount || 0}次`);
        if (s.note) lines.push(`  备注：${s.note}`);
        lines.push('');
      }
      return { text: lines.join('\n') };
    } catch {
      return { text: '读取 Skill 列表失败。' };
    }
  });

  // 公司 Skill 市场
  ipcMain.handle(IPC.skillMarketplace, async () => {
    try {
      const sharesPath = path.join(process.cwd(), '.otto', 'org', 'skill-shares.json');
      let shares: any[] = [];
      try {
        shares = JSON.parse(await fs.promises.readFile(sharesPath, 'utf-8'));
      } catch { /* 无文件 */ }

      const market = shares.filter((s: any) =>
        s.publishedToMarketplace === true && s.status === 'active',
      );

      if (market.length === 0) {
        return { text: '公司 Skill 市场暂无已发布的 Skill。\n\n部门共享的 Skill 需要分享者「发布到市场」后才会在此显示。' };
      }

      // 按评分排序
      market.sort((a: any, b: any) => (b.rating || 0) - (a.rating || 0));

      const lines: string[] = ['公司 Skill 市场', ''];
      for (const s of market) {
        const stars = '⭐'.repeat(Math.round(s.rating || 0));
        lines.push(`${s.skillName} (v${s.version || 1})`);
        lines.push(`  功能：${s.featureDescription || '暂无描述'}`);
        lines.push(`  分享者：${s.sharedByName} (${s.teamName})`);
        lines.push(`  评分：${stars || '暂无'} (${s.ratingCount || 0}人) | 安装：${s.installCount || 0}次 | 使用：${s.usageCount || 0}次`);
        lines.push('');
      }
      return { text: lines.join('\n') };
    } catch {
      return { text: '读取 Skill 市场失败。' };
    }
  });

  ipcMain.handle(IPC.openPath, (_e, p: unknown) => {
    // 仅允许打开用户 home 目录内的绝对路径（防越界打开 /etc/passwd 等敏感文件，code review LOW）。
    // realpath 解析符号链接后再比较前缀，防 home 内 symlink 指向外部绕过；
    // 目标不存在（realpath 抛 ENOENT）时直接拒绝。
    if (typeof p === 'string' && p.length > 0 && path.isAbsolute(p)) {
      let home: string;
      let resolved: string;
      try {
        home = fs.realpathSync(app.getPath('home'));
        resolved = fs.realpathSync(path.resolve(p));
      } catch {
        return Promise.resolve('');
      }
      if (resolved === home || resolved.startsWith(home + path.sep)) {
        return shell.openPath(resolved);
      }
    }
    return Promise.resolve('');
  });
}

// ────────────────────────────────────────────────────────────────────────
// 生命周期
// ────────────────────────────────────────────────────────────────────────

// 单实例锁：第二次启动直接聚焦已开窗口，避免多开多个 server 抢端口。
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(async () => {
    // 让 Chromium 的 prefers-color-scheme 跟随 macOS 系统深浅色主题：这是
    // renderer 里 @media (prefers-color-scheme: dark) 能被触发的关键。'system'
    // 虽是默认值，但显式设定可确保不被别处改写，且 activate 重建窗口时同样生效。
    nativeTheme.themeSource = 'system';

    registerIpc();
    installAppMenu(() => mainWindow);

    // 先建窗（show:false，ready-to-show 再显），同时并发确保 server。
    mainWindow = createWindow();
    applyCsp();
    await ensureEndpoint();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        mainWindow = createWindow();
        // 窗口重建后把已知端点补推一次。
        mainWindow.webContents.once('did-finish-load', pushEndpointToRenderer);
      }
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('before-quit', () => {
    // 仅内嵌 server 随 app 退出而停；discovered（headless/CLI 已在跑）故意留活。
    void serverManager.shutdown();
  });
}
