/**
 * 浏览器静态预览桥。
 *
 * Electron 会由 preload 注入 window.otto；只有普通浏览器缺少该对象时才启用这里的
 * 纯本地模拟实现。它不访问园区服务器，所有会话、模型和回复均为演示数据。
 */

type PreviewFrame = { type: string; payload: Record<string, unknown> };
type PreviewWindow = { otto?: unknown };

const previewWindow = window as unknown as PreviewWindow;

if (!previewWindow.otto) {
  const frameHandlers = new Set<(frame: PreviewFrame) => void>();
  const connectionHandlers = new Set<(connected: boolean) => void>();
  const modelStorageKey = 'otto:browser-preview-models';
  let connected = false;
  let currentModel: string | null = 'preview-model';
  let sessions = [makeSession('preview-session', '园区服务本地演示')];
  let models = readModels();
  const previewAccount = {
    id: 'preview-account',
    organizationId: 'preview-organization',
    organizationName: '北控宏创科技园',
    accountType: 'enterprise',
    employeeId: 'preview-employee',
    username: 'preview.user',
    phone: '+8613800000000',
    name: '本地测试用户',
    role: '企业员工',
    department: '入驻企业',
    positionId: null,
    positionTitle: '员工',
    isAdmin: false,
    status: 'active',
    tags: ['企业用户'],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  let previewTickets: Array<Record<string, unknown>> = [];
  const previewMeetingSlots = makePreviewMeetingSlots();

  function localISODate(offsetDays: number): string {
    const date = new Date();
    date.setHours(12, 0, 0, 0);
    date.setDate(date.getDate() + offsetDays);
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  }
  function makePreviewMeetingSlots(): Array<Record<string, unknown>> {
    const roomIds = ['preview-room-medium', 'preview-room-large', 'preview-room-auditorium'];
    const slots: Array<Record<string, unknown>> = [];
    for (let day = 1; day <= 30; day += 1) {
      for (const roomId of roomIds) {
        for (const slot of [
          { key: 'morning', label: '上午 09:00–12:00' },
          { key: 'afternoon', label: '下午 14:00–18:00' },
        ]) {
          slots.push({
            id: `${roomId}-${localISODate(day)}-${slot.key}`,
            roomId,
            date: localISODate(day),
            slotKey: slot.key,
            label: slot.label,
            status: day === 1 && roomId === 'preview-room-medium' && slot.key === 'morning' ? 'booked' : 'available',
            updatedAt: new Date().toISOString(),
          });
        }
      }
    }
    return slots;
  }

  function makeSession(sessionId: string, title: string): Record<string, unknown> {
    return { sessionId, title, model: currentModel, status: 'idle', messageCount: 0, createdAt: Date.now(), updatedAt: Date.now() };
  }
  function readModels(): Array<Record<string, unknown>> {
    try {
      const stored: unknown = JSON.parse(localStorage.getItem(modelStorageKey) ?? '[]');
      if (Array.isArray(stored) && stored.length > 0) return stored as Array<Record<string, unknown>>;
    } catch { /* 隐私模式或损坏数据时使用默认模型 */ }
    return [{ id: 'preview-model', displayName: 'gpt-5.1（本地预览）', provider: 'openai', enabled: true }];
  }
  function persistModels(): void {
    try { localStorage.setItem(modelStorageKey, JSON.stringify(models)); } catch { /* 不可持久化时仍可在当前页使用 */ }
  }
  function emit(type: string, payload: Record<string, unknown>): void {
    const frame = { type, payload };
    frameHandlers.forEach((handler) => { try { handler(frame); } catch { /* 单个监听器不阻断 */ } });
  }
  function emitModels(): void { emit('models_list', { models, current: currentModel }); }
  function id(prefix: string): string { return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`; }

  const bridge: Record<string, unknown> = {
    connect: () => {
      connected = true;
      connectionHandlers.forEach((handler) => { try { handler(true); } catch { /* 忽略 */ } });
      window.setTimeout(() => { emit('sessions_list', { sessions }); emitModels(); }, 40);
      return Promise.resolve(true);
    },
    disconnect: () => {
      connected = false;
      connectionHandlers.forEach((handler) => { try { handler(false); } catch { /* 忽略 */ } });
    },
    isConnected: () => connected,
    onFrame: (handler: (frame: PreviewFrame) => void) => { frameHandlers.add(handler); return () => frameHandlers.delete(handler); },
    onConnectionChange: (handler: (state: boolean) => void) => {
      connectionHandlers.add(handler);
      try { handler(connected); } catch { /* 忽略 */ }
      return () => connectionHandlers.delete(handler);
    },
    send: (frame: { type?: string; payload?: Record<string, unknown> }) => {
      const payload = frame.payload ?? {};
      if (frame.type === 'list_sessions') emit('sessions_list', { sessions });
      if (frame.type === 'get_models' || frame.type === 'list_models') emitModels();
      if (frame.type === 'get_history') emit('history', { sessionId: payload.sessionId, messages: [] });
      if (frame.type === 'create_session') {
        const session = makeSession(id('preview-session'), String(payload.title ?? '新对话'));
        sessions = [session, ...sessions];
        emit('session_created', { session, clientRequestId: payload.clientRequestId });
      }
      if (frame.type === 'set_model') {
        currentModel = String(payload.model ?? currentModel);
        sessions = sessions.map((session) => session.sessionId === payload.sessionId ? { ...session, model: currentModel, updatedAt: Date.now() } : session);
        emitModels();
      }
      if (frame.type === 'save_custom_model') {
        const provider = String(payload.provider ?? 'openai');
        const modelId = String(payload.modelId ?? 'gpt-5.1');
        const model = { id: String(payload.replaceId ?? `custom:${provider}:${modelId}:${Date.now()}`), displayName: String(payload.displayName ?? modelId), provider, baseUrl: String(payload.baseUrl ?? ''), enabled: true, isCustom: true };
        models = [...models.filter((item) => item.id !== model.id), model];
        currentModel = model.id;
        persistModels();
        window.setTimeout(emitModels, 50);
      }
      if (frame.type === 'delete_custom_model') {
        models = models.filter((item) => item.id !== payload.id);
        if (!models.some((item) => item.id === currentModel)) currentModel = String(models[0]?.id ?? '');
        persistModels();
        window.setTimeout(emitModels, 50);
      }
      if (frame.type === 'send_user_message') {
        const sessionId = String(payload.sessionId ?? 'preview-session');
        const messageId = id('assistant');
        emit('message_start', { message: { id: messageId, sessionId, role: 'assistant', content: [{ type: 'text', value: '' }], timestamp: Date.now(), source: 'local', isStreaming: true } });
        window.setTimeout(() => {
          const text = '这是浏览器本地预览。园区服务的完整模拟流程可在右侧「园区服务」中演示。';
          emit('chat_chunk', { sessionId, messageId, delta: text });
          emit('chat_complete', { sessionId, messageId, text, finishReason: 'stop' });
        }, 160);
      }
    },
    parkConfig: () => Promise.resolve(null),
    onMenu: () => () => {}, onUpdateProgress: () => () => {},
    appVersion: () => Promise.resolve('1.9.2-browser-preview'),
    openExternal: () => Promise.resolve(), openPath: () => Promise.resolve(), saveTextFile: () => Promise.resolve(null),
    getPathForFile: (file: File) => (file as File & { path?: string }).path || file.name,
    readClipboardText: () => navigator.clipboard?.readText?.() ?? Promise.resolve(''),
    updateCheck: () => Promise.resolve({ status: 'up-to-date', currentVersion: '1.9.2', latestVersion: null }),
    updateDownload: () => Promise.resolve({ ok: false, error: '浏览器预览不支持更新' }), updateCancel: () => Promise.resolve(), updateInstall: () => Promise.resolve({ ok: false, message: '浏览器预览不支持安装' }),
    themeGet: () => Promise.resolve('dark'), themeSet: () => Promise.resolve('dark'),
    enterpriseSession: () => Promise.resolve({
      serverUrl: 'browser-preview://local',
      account: previewAccount,
    }),
    enterpriseLogout: () => Promise.resolve(),
    enterpriseTicketList: () => Promise.resolve(previewTickets),
    enterpriseParkResources: () => Promise.resolve({
      settings: {
        parkingTotal: 180,
        parkingNote: '固定车位需由客服确认，新能源车位优先分配。',
        updatedAt: new Date().toISOString(),
      },
      meetingRooms: [
        {
          id: 'preview-room-medium',
          name: '中会议室',
          location: '位置待园区管理员补充',
          capacity: 30,
          priceHalfDay: 400,
          equipment: ['投屏', '视频会议', '白板'],
          imageUrl: null,
          openingHours: '工作日 09:00–18:00',
          enabled: true,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
        {
          id: 'preview-room-large',
          name: '大会议室',
          location: '位置待园区管理员补充',
          capacity: 50,
          priceHalfDay: 500,
          equipment: ['投屏', '视频会议', '白板'],
          imageUrl: null,
          openingHours: '工作日 09:00–18:00',
          enabled: true,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
        {
          id: 'preview-room-auditorium',
          name: '报告厅',
          location: '位置待园区管理员补充',
          capacity: 80,
          priceHalfDay: 800,
          equipment: ['投屏', '视频会议', '白板'],
          imageUrl: null,
          openingHours: '工作日 09:00–18:00',
          enabled: true,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      ],
      meetingSlots: previewMeetingSlots,
    }),
    enterpriseTicketSubmit: (input: Record<string, unknown>) => {
      const now = new Date().toISOString();
      const serviceId = String(input.serviceId || 'repair');
      const formData = input.formData && typeof input.formData === 'object'
        ? input.formData as Record<string, unknown>
        : {};
      if (serviceId === 'meeting-room') {
        const slot = previewMeetingSlots.find((item) => (
          item.roomId === formData.roomId
          && item.date === formData.date
          && item.slotKey === formData.slotKey
        ));
        if (!slot || slot.status !== 'available') {
          return Promise.reject(new Error(slot?.status === 'booked' ? '该时段刚刚已被预约，请选择其他时段' : '该时段暂未开放'));
        }
        slot.status = 'booked';
        slot.updatedAt = now;
      }
      const ticket = {
        id: id('preview-ticket'),
        serviceId,
        title: String(input.title || '园区服务申请'),
        description: String(input.description || ''),
        formData,
        targetTags: serviceId === 'repair' ? ['维修工作人员'] : ['客服人员'],
        status: serviceId === 'repair' ? '待接单' : '待派单',
        category: input.category ? String(input.category) : null,
        location: input.location ? String(input.location) : null,
        urgency: input.urgency ? String(input.urgency) : null,
        contact: input.contact ? String(input.contact) : null,
        contactPhone: input.contactPhone ? String(input.contactPhone) : null,
        responseType: null,
        responseText: null,
        responseAt: null,
        createdAt: now,
        updatedAt: now,
        creator: {
          id: previewAccount.id,
          name: previewAccount.name,
          username: previewAccount.username,
        },
        recipientCount: serviceId === 'repair' ? 1 : 2,
        recipients: serviceId === 'repair'
          ? [{ id: 'preview-repairer', name: '维修工作人员' }]
          : [{ id: 'preview-cs-1', name: '客服一组' }, { id: 'preview-cs-2', name: '客服二组' }],
        deliveryStatus: serviceId === 'renovation' ? '已投递客服部' : '已投递',
        readAt: null,
        isCreator: true,
        isRecipient: false,
        notifications: [],
      };
      previewTickets = [ticket, ...previewTickets];
      return Promise.resolve(ticket);
    },
    enterpriseTicketRead: (ticketId: string) => {
      const ticket = previewTickets.find((item) => item.id === ticketId) ?? null;
      return ticket ? Promise.resolve(ticket) : Promise.reject(new Error('申请单不存在'));
    },
    enterpriseTicketAction: (ticketId: string) => {
      const ticket = previewTickets.find((item) => item.id === ticketId) ?? null;
      return ticket ? Promise.resolve(ticket) : Promise.reject(new Error('申请单不存在'));
    },
    enterpriseUsageRecord: () => Promise.resolve({ recorded: false }), enterpriseKnowledgeRecord: () => Promise.resolve({ added: false }), enterpriseKnowledgeList: () => Promise.resolve([]),
  };

  previewWindow.otto = new Proxy(bridge, {
    get(target, key) { return key in target ? target[key as string] : () => Promise.resolve(null); },
  });
}
