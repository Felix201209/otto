/**
 * @license
 * Copyright 2025 Otto
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * 仅用于「无 Electron 环境」下的可视化自检：mock 一个假的 window.otto 桥，
 * 回放样例 server 帧，把填充版界面真渲染出来截图。不参与交付构建。
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
import { createRoot } from 'react-dom/client';
import { App } from '../src/renderer/App.js';

type Frame = any;
const handlers = new Set<(f: Frame) => void>();
const emit = (f: Frame): void => {
  for (const h of handlers) h(f);
};

// —— 样例时间（浏览器运行，可用 Date）——
const today = new Date();
today.setHours(0, 0, 0, 0);
const t = (h: number, m: number): number => today.getTime() + h * 3600000 + m * 60000;
const yest = today.getTime() - 86400000;
const ty = (h: number, m: number): number => yest + h * 3600000 + m * 60000;

const SESSIONS = [
  { sessionId: 's1', source: 'feishu', title: '优化用户登录流程', status: 'idle', createdAt: t(11, 0), updatedAt: t(11, 24), lastMessagePreview: '我来帮你优化登录流程的代码…', messageCount: 3 },
  { sessionId: 's2', source: 'local', title: '修复数据导出问题', status: 'idle', createdAt: t(10, 0), updatedAt: t(10, 48), lastMessagePreview: '已定位到导出时的字段映射问…', messageCount: 5 },
  { sessionId: 's3', source: 'feishu', title: '实现定时任务', status: 'idle', createdAt: t(9, 0), updatedAt: t(9, 15), lastMessagePreview: '定时任务功能已实现，包含…', messageCount: 4 },
  { sessionId: 's4', source: 'local', title: '接口性能优化建议', status: 'idle', createdAt: ty(18, 0), updatedAt: ty(18, 30), lastMessagePreview: '基于你的接口日志，我发现…', messageCount: 6 },
  { sessionId: 's5', source: 'feishu', title: '增加登录设备管理', status: 'idle', createdAt: ty(16, 0), updatedAt: ty(16, 20), lastMessagePreview: '我来帮你实现设备管理功能…', messageCount: 7 },
  { sessionId: 's6', source: 'local', title: '前端页面加载慢', status: 'idle', createdAt: ty(14, 0), updatedAt: ty(14, 5), lastMessagePreview: '我分析了加载性能，主要问题…', messageCount: 3 },
];

const DIFF = `@@ -45,15 +45,10 @@ async function login(credentials: LoginRequest) {
   // 验证用户输入
-  if (!credentials.email) {
-    throw new Error('邮箱不能为空')
-  }
-  if (!credentials.password) {
-    throw new Error('密码不能为空')
-  }
+  validateLoginInput(credentials)

   // 验证用户
   const user = await findUserByEmail(credentials.email)`;

const HISTORY: Record<string, Frame[]> = {
  s1: [
    {
      id: 'u1', sessionId: 's1', role: 'user', source: 'feishu', timestamp: t(11, 24),
      content: [{ type: 'text', value: '帮我优化一下登录流程的代码，减少重复验证逻辑' }],
    },
    {
      id: 'a1', sessionId: 's1', role: 'assistant', source: 'feishu', timestamp: t(11, 24),
      toolsCompleted: true,
      content: [
        { type: 'text', value: '我来帮你优化登录流程的代码，减少重复验证逻辑。我会分析当前代码，找出重复的验证逻辑，然后提取为公共方法。' },
        { type: 'text', value: '登录流程已优化完成！我将重复的输入验证逻辑提取到了 `validateLoginInput` 方法中，并通过单元测试确保功能正常。' },
      ],
      associatedToolCalls: [
        { id: 't1', toolName: 'edit_file', displayName: '编辑文件', status: 'success', parameters: {}, confirmationDetails: { type: 'edit', filePath: 'src/services/auth/login.ts', fileDiff: DIFF } },
        { id: 't2', toolName: 'run_shell_command', displayName: '终端运行', status: 'success', parameters: {}, confirmationDetails: { type: 'exec', command: 'npm run lint' } },
      ],
    },
  ],
};

const MODELS: Frame[] = [
  { id: 'claude-opus-4', displayName: 'Claude Opus 4' },
  { id: 'claude-sonnet-4', displayName: 'Claude Sonnet 4' },
  { id: 'gpt-5', displayName: '高端推理模型' },
  { id: 'gemini-2.5-pro', displayName: 'Gemini 2.5 Pro' },
  { id: 'deepseek-v4', displayName: 'DeepSeek V4' },
  { id: 'glm-5', displayName: 'GLM-5' },
];

const previewAccount = {
  id: 'browser-dev',
  organizationId: 'park-admin',
  organizationName: '宏创园区管理方',
  employeeId: null,
  username: 'dev',
  phone: null,
  name: '园区管理员',
  role: '园区管理员',
  department: '园区管理部',
  departmentId: 'park-dept',
  isAdmin: true,
  status: 'active',
  tags: [],
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

const previewTenantOrganizations = [
  { id: 'tenant-smart', name: '宏创智能制造', slug: 'hongchuang-smart', parkId: 'park-hc', status: 'active', industry: '智能制造', employeeCount: 36, departmentCount: 4, onlineCount: 12, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
  { id: 'tenant-digital', name: '北辰数字科技', slug: 'beichen-digital', parkId: 'park-hc', status: 'active', industry: '软件与信息服务', employeeCount: 24, departmentCount: 3, onlineCount: 8, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
  { id: 'tenant-logistics', name: '远达供应链', slug: 'yuanda-logistics', parkId: 'park-hc', status: 'active', industry: '现代物流', employeeCount: 18, departmentCount: 3, onlineCount: 5, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
];

const previewOrganizationViews: Record<string, any> = {
  'tenant-smart': {
    organization: { id: 'tenant-smart', name: '宏创智能制造', status: 'active', industry: '智能制造', createdAt: new Date().toISOString() },
    employeeCount: 36,
    members: [
      { id: 'smart-owner', username: 'smart.owner', name: '李总', role: '企业负责人', department: '管理层', departmentId: 'smart-management', positionId: 'smart-owner-pos', positionTitle: '企业负责人', avatarUrl: null, isAdmin: true, status: 'active', ottoOnline: true },
      { id: 'smart-pm', username: 'smart.pm', name: '王敏', role: '项目经理', department: '研发中心', departmentId: 'smart-rd', positionId: 'smart-pm-pos', positionTitle: '项目经理', avatarUrl: null, isAdmin: false, status: 'active', ottoOnline: true },
      { id: 'smart-engineer', username: 'smart.engineer', name: '周工', role: '工程师', department: '研发中心', departmentId: 'smart-rd', positionId: 'smart-engineer-pos', positionTitle: '工程师', avatarUrl: null, isAdmin: false, status: 'active', ottoOnline: false },
    ],
    structure: [
      { id: 'smart-management', organizationId: 'tenant-smart', name: '管理层', parentDepartmentId: null, memberCount: 1, positions: [{ id: 'smart-owner-pos', organizationId: 'tenant-smart', departmentId: 'smart-management', title: '企业负责人', roleMapping: 'enterprise_admin', createdAt: '', updatedAt: '' }], createdAt: '', updatedAt: '' },
      { id: 'smart-rd', organizationId: 'tenant-smart', name: '研发中心', parentDepartmentId: null, memberCount: 2, positions: [{ id: 'smart-pm-pos', organizationId: 'tenant-smart', departmentId: 'smart-rd', title: '项目经理', roleMapping: 'department_admin', createdAt: '', updatedAt: '' }, { id: 'smart-engineer-pos', organizationId: 'tenant-smart', departmentId: 'smart-rd', title: '工程师', roleMapping: 'member', createdAt: '', updatedAt: '' }], createdAt: '', updatedAt: '' },
      { id: 'smart-product', organizationId: 'tenant-smart', name: '产品组', parentDepartmentId: 'smart-rd', memberCount: 0, positions: [], createdAt: '', updatedAt: '' },
    ],
    park: { id: 'park-hc', name: '宏创园区', brandName: '宏创园区服务', adminOrganizationId: 'park-admin', status: 'active', createdAt: '', updatedAt: '', isAdminOrganization: false },
  },
};

const previewPublication = {
  id: 'pub-preview',
  serviceId: 'announcement',
  title: '园区停水通知',
  body: '今天 14:00-16:00 园区将进行管线检修，请提前准备。',
  createdAt: new Date().toISOString(),
};

const previewTicket = {
  id: 'ticket-preview',
  serviceId: 'repair',
  title: '客户报修',
  status: '待派单',
  formData: {
    location: 'A 座 3 楼会议室',
    category: '照明',
    description: '会议室灯坏了，需要安排维修。',
  },
  creator: previewAccount,
  isCreator: true,
  isRecipient: false,
  responseType: '',
  responseText: '',
  readAt: null,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

const mockBridge = {
  async connect(): Promise<boolean> {
    return true;
  },
  disconnect(): void {},
  send(frame: Frame): void {
    if (frame.type === 'list_sessions') emit({ type: 'sessions_list', payload: { sessions: SESSIONS } });
    else if (frame.type === 'get_models') emit({ type: 'models_list', payload: { models: MODELS, current: 'claude-opus-4' } });
    else if (frame.type === 'get_history') emit({ type: 'history', payload: { sessionId: frame.payload.sessionId, messages: HISTORY[frame.payload.sessionId] ?? [] } });
    // 智能体启动自检：create_session → 回一份新会话摘要（store 据此关联并选中，再发开场消息）。
    else if (frame.type === 'create_session') {
      const sid = `sx-${Date.now()}`;
      const summary = { sessionId: sid, source: 'local', title: frame.payload?.title || '新对话', status: 'idle', createdAt: Date.now(), updatedAt: Date.now(), messageCount: 0 };
      SESSIONS.unshift(summary as Frame);
      emit({ type: 'session_upsert', payload: { session: summary } });
    }
    // 收到用户消息 → 短暂延时后回一条助手消息（演示专家开场后的回应）。
    else if (frame.type === 'send_user_message') {
      const sid = frame.payload.sessionId;
      const aid = `a-${Date.now()}`;
      window.setTimeout(() => {
        emit({ type: 'message_start', payload: { message: { id: aid, sessionId: sid, role: 'assistant', source: 'local', timestamp: Date.now(), content: [] } } });
        emit({ type: 'chat_chunk', payload: { sessionId: sid, messageId: aid, delta: '好的！我已按角色就位，并会用 use_skill 加载对应技能。先跟我说说这次的具体需求吧——主题、受众和目标，我们就开始。' } });
        emit({ type: 'chat_complete', payload: { sessionId: sid, messageId: aid } });
      }, 300);
    }
    // setup 落盘闭环自检：modelId 含 "fail" → 模拟 save_failed；否则追加模型并广播 models_list。
    else if (frame.type === 'save_custom_model') {
      const p = frame.payload;
      window.setTimeout(() => {
        if (String(p.modelId).includes('fail')) {
          emit({ type: 'error', payload: { code: 'save_failed', message: '写入 ~/.otto-user/custom-models.json 失败：权限被拒' } });
          return;
        }
        MODELS.push({ id: `custom:${p.provider}:${p.modelId}`, displayName: p.displayName || p.modelId, provider: p.provider });
        emit({ type: 'models_list', payload: { models: MODELS, current: 'claude-opus-4' } });
      }, 600);
    }
  },
  onFrame(h: (f: Frame) => void): () => void {
    handlers.add(h);
    return () => handlers.delete(h);
  },
  onConnectionChange(h: (c: boolean) => void): () => void {
    h(true);
    return () => {};
  },
  isConnected(): boolean {
    return true;
  },
  onMenu(): () => void {
    return () => {};
  },
  async appVersion(): Promise<string> {
    return '1.7.0-preview';
  },
  onUpdateProgress(): () => void {
    return () => {};
  },
  async openExternal(): Promise<void> {},
  async openPath(): Promise<void> {},
  async writeClipboard(): Promise<boolean> { return true; },
  async saveTextFile(): Promise<string | null> { return null; },
  async feishuStart(): Promise<any> { return { text: '浏览器演示模式不启动飞书守护' }; },
  async feishuStop(): Promise<any> { return { text: '浏览器演示模式不启动飞书守护' }; },
  async feishuStatus(): Promise<any> { return { text: '浏览器演示模式', running: false }; },
  async feishuGetConfig(): Promise<any> { return { ok: false, config: null, error: '浏览器演示模式不支持' }; },
  async feishuSaveConfig(): Promise<any> { return { ok: false, config: null, error: '浏览器演示模式不支持' }; },
  async feishuClearConfig(): Promise<any> { return { ok: false, config: null, error: '浏览器演示模式不支持' }; },
  async parkConfig(): Promise<any> { return null; },
  async themeGet(): Promise<string> { return 'system'; },
  async themeSet(value: string): Promise<string> { return value; },
  async skillLeaderboard(): Promise<any> { return { leaderboard: '浏览器演示模式暂未接入排行榜。', starBoard: '', tabs: [] }; },
  async workLogToday(): Promise<any> { return { summary: '', date: new Date().toISOString().slice(0, 10), totalActions: 0, workResults: 0 }; },
  async workLogRecent(): Promise<any> { return []; },
  async workLogReport(): Promise<any> { return { ok: false, message: '浏览器演示模式暂未接入工作日志导出。' }; },
  async skillShareList(): Promise<any> { return { text: '浏览器演示模式暂未接入部门共享 Skill。' }; },
  async skillMarketplace(): Promise<any> { return { text: '浏览器演示模式暂未接入公司 Skill 市场。' }; },
  async setLocalTestUrl(): Promise<void> {},
  async updateCheck(): Promise<any> { return { status: 'up-to-date', currentVersion: '1.9.0-preview', latestVersion: null }; },
  async updateDownload(): Promise<any> { return { ok: false, error: '浏览器演示模式不支持下载更新。' }; },
  async updateCancel(): Promise<void> {},
  async updateInstall(): Promise<any> { return { ok: false, message: '浏览器演示模式不支持安装更新。' }; },
  async voiceGetConfig(): Promise<any> { return { enabled: false, asrProvider: 'openai', asrEndpoint: '', asrModel: '', hasAsrApiKey: false }; },
  async voiceSaveConfig(): Promise<any> { return {}; },
  async voiceTranscribe(): Promise<any> { return { text: '', rawText: '', polished: false }; },
  async autoGeneratedAgentProfiles(): Promise<any[]> { return []; },
  async createDiagnosticBundle(): Promise<any> {
    return {
      ok: true,
      path: `${location.origin}/otto-diagnostic-preview.zip`,
      fileCount: 6,
      message: '演示模式：真实客户端会导出到桌面，并自动打开所在位置。',
    };
  },
  async enterpriseSession(): Promise<any> { return { serverUrl: 'http://127.0.0.1:7637', account: previewAccount }; },
  async enterprisePasswordLogin(): Promise<any> {
    return { serverUrl: 'http://127.0.0.1:7637', account: previewAccount, expiresAt: new Date(Date.now() + 86400000).toISOString() };
  },
  async enterpriseRegistrationRequest(): Promise<any> { return {}; },
  async enterpriseRegistrationIntent(): Promise<any> { return null; },
  onEnterpriseRegistrationIntent(): () => void { return () => {}; },
  onEnterpriseSessionInvalidated(): () => void { return () => {}; },
  async enterpriseRegister(): Promise<any> { return {}; },
  async enterpriseLogout(): Promise<void> {},
  async enterpriseAccounts(): Promise<any> { return [previewAccount]; },
  async enterpriseAccountCreate(): Promise<any> { return {}; },
  async enterpriseAccountUpdate(): Promise<any> { return {}; },
  async enterpriseUsageRecord(): Promise<any> { return { recorded: false, source: 'client_reported' }; },
  async enterpriseKnowledgeRecord(): Promise<any> { return { status: 'added', added: true }; },
  async enterpriseKnowledgeList(): Promise<any> { return []; },
  async enterpriseOrganizationView(organizationId?: string): Promise<any> {
    if (organizationId && previewOrganizationViews[organizationId]) return previewOrganizationViews[organizationId];
    return {
      organization: { id: 'park-admin', name: '宏创园区管理方', status: 'active', industry: '园区运营服务', createdAt: new Date().toISOString() },
      members: [previewAccount],
      employeeCount: 1,
      structure: [{ id: 'park-dept', organizationId: 'park-admin', name: '园区管理部', parentDepartmentId: null, memberCount: 1, positions: [], createdAt: '', updatedAt: '' }],
      park: { id: 'park-hc', name: '宏创园区', brandName: '宏创园区服务', adminOrganizationId: 'park-admin', status: 'active', createdAt: '', updatedAt: '', isAdminOrganization: true },
    };
  },
  async enterpriseParkTenants(): Promise<any> { return previewTenantOrganizations; },
  async enterpriseOrganizationInviteGet(): Promise<any> {
    return {
      organization: { id: 'local', name: '本地开发' },
      invite: {
        id: 'invite-local',
        organizationId: 'local',
        code: 'ECP4-XZTU',
        link: 'http://127.0.0.1:7777/enterprise/join/ECP4-XZTU',
        status: 'active',
        issuedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 604800000).toISOString(),
        validHours: 168,
      },
    };
  },
  async enterpriseOrganizationInviteIssue(): Promise<any> { return {}; },
  async enterpriseParkPublications(): Promise<any> { return [previewPublication]; },
  async enterpriseTicketList(): Promise<any> { return [previewTicket]; },
  async enterpriseTicketSubmit(input: any): Promise<any> {
    return {
      ...previewTicket,
      id: `ticket-${Date.now()}`,
      serviceId: input?.serviceId || 'repair',
      title: input?.title || '园区服务申请',
      formData: input?.formData || previewTicket.formData,
      status: '待派单',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  },
  async enterpriseTicketAction(_id: string, input: any): Promise<any> {
    return {
      ...previewTicket,
      status: input?.action === 'complete' ? '待验收' : '处理中',
      responseType: input?.responseType || '已受理',
      responseText: input?.responseText || '工作人员已收到，将尽快处理。',
      updatedAt: new Date().toISOString(),
    };
  },
  async enterpriseTicketRead(): Promise<any> { return { ...previewTicket, readAt: new Date().toISOString() }; },
  async enterpriseTicketInbox(): Promise<any> { return [previewTicket]; },
  async enterpriseTicketSubmitLegacy(): Promise<any> { return previewTicket; },
};

(window as any).otto = new Proxy(mockBridge, {
  get(target, key) {
    if (key in target) return target[key as keyof typeof target];
    if (typeof key === 'string' && key.startsWith('on')) return () => () => {};
    return async () => null;
  },
});
// 自检钩子：让截图脚本能注入任意 server 帧（仅 preview，不参与交付）。
(window as any).__emitTestFrame = (f: Frame): void => emit(f);

// setup 自检：默认带 MODELS（不自动弹 setup）。要演示「首启无模型自动弹引导」时，
// 在 URL 加 ?empty 让 get_models 回空列表。
if (new URLSearchParams(location.search).has('empty')) MODELS.length = 0;

const root = document.getElementById('root');
if (root) createRoot(root).render(<App />);
