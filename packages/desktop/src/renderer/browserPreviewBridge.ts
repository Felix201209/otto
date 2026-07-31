/**
 * 浏览器静态预览桥。
 *
 * Electron 会由 preload 注入 window.otto；只有普通浏览器缺少该对象时才启用这里的
 * 纯本地模拟实现。它不访问园区服务器，所有会话、模型和回复均为演示数据。
 */

import { parkISODate, parkMinuteOfDay } from './parkBusinessTime.js';

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
  const previewDirectMessages = new Map<
    string,
    Array<Record<string, unknown>>
  >();
  let previewApplicationSequence = 0;
  const previewMeetingSlots = makePreviewMeetingSlots();

  function makePreviewMeetingSlots(): Array<Record<string, unknown>> {
    const roomIds = [
      'preview-room-medium',
      'preview-room-large',
      'preview-room-auditorium',
    ];
    const slots: Array<Record<string, unknown>> = [];
    const referenceTime = new Date();
    const currentMinutes = parkMinuteOfDay(referenceTime);
    for (let day = 0; day <= 30; day += 1) {
      for (const roomId of roomIds) {
        for (let minutes = 9 * 60; minutes < 23 * 60; minutes += 10) {
          const key = `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
          const end = minutes + 10;
          const endKey = `${String(Math.floor(end / 60)).padStart(2, '0')}:${String(end % 60).padStart(2, '0')}`;
          slots.push({
            id: `${roomId}-${parkISODate(referenceTime, day)}-${key}`,
            roomId,
            date: parkISODate(referenceTime, day),
            slotKey: key,
            label: `${key}–${endKey}`,
            status:
              day === 0 && minutes <= currentMinutes
                ? 'closed'
                : day === 1 &&
                    roomId === 'preview-room-medium' &&
                    key === '10:00'
                  ? 'booked'
                  : 'available',
            updatedAt: new Date().toISOString(),
          });
        }
      }
    }
    return slots;
  }

  function makeSession(
    sessionId: string,
    title: string,
  ): Record<string, unknown> {
    return {
      sessionId,
      title,
      model: currentModel,
      status: 'idle',
      messageCount: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
  }
  function readModels(): Array<Record<string, unknown>> {
    try {
      const stored: unknown = JSON.parse(
        localStorage.getItem(modelStorageKey) ?? '[]',
      );
      if (Array.isArray(stored) && stored.length > 0)
        return stored as Array<Record<string, unknown>>;
    } catch {
      /* 隐私模式或损坏数据时使用默认模型 */
    }
    return [
      {
        id: 'preview-model',
        displayName: 'GPT-5.1',
        provider: 'openai',
        enabled: true,
      },
    ];
  }
  function persistModels(): void {
    try {
      localStorage.setItem(modelStorageKey, JSON.stringify(models));
    } catch {
      /* 不可持久化时仍可在当前页使用 */
    }
  }
  function emit(type: string, payload: Record<string, unknown>): void {
    const frame = { type, payload };
    frameHandlers.forEach((handler) => {
      try {
        handler(frame);
      } catch {
        /* 单个监听器不阻断 */
      }
    });
  }
  function emitModels(): void {
    emit('models_list', { models, current: currentModel });
  }
  function id(prefix: string): string {
    return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }

  const bridge: Record<string, unknown> = {
    connect: () => {
      connected = true;
      connectionHandlers.forEach((handler) => {
        try {
          handler(true);
        } catch {
          /* 忽略 */
        }
      });
      window.setTimeout(() => {
        emit('sessions_list', { sessions });
        emitModels();
      }, 40);
      return Promise.resolve(true);
    },
    disconnect: () => {
      connected = false;
      connectionHandlers.forEach((handler) => {
        try {
          handler(false);
        } catch {
          /* 忽略 */
        }
      });
    },
    isConnected: () => connected,
    onFrame: (handler: (frame: PreviewFrame) => void) => {
      frameHandlers.add(handler);
      return () => frameHandlers.delete(handler);
    },
    onConnectionChange: (handler: (state: boolean) => void) => {
      connectionHandlers.add(handler);
      try {
        handler(connected);
      } catch {
        /* 忽略 */
      }
      return () => connectionHandlers.delete(handler);
    },
    send: (frame: { type?: string; payload?: Record<string, unknown> }) => {
      const payload = frame.payload ?? {};
      if (frame.type === 'list_sessions') emit('sessions_list', { sessions });
      if (frame.type === 'get_models' || frame.type === 'list_models')
        emitModels();
      if (frame.type === 'get_history')
        emit('history', { sessionId: payload.sessionId, messages: [] });
      if (frame.type === 'create_session') {
        const session = makeSession(
          id('preview-session'),
          String(payload.title ?? '新对话'),
        );
        sessions = [session, ...sessions];
        emit('session_created', {
          session,
          clientRequestId: payload.clientRequestId,
        });
      }
      if (frame.type === 'set_model') {
        currentModel = String(payload.model ?? currentModel);
        sessions = sessions.map((session) =>
          session.sessionId === payload.sessionId
            ? { ...session, model: currentModel, updatedAt: Date.now() }
            : session,
        );
        emitModels();
      }
      if (frame.type === 'save_custom_model') {
        const provider = String(payload.provider ?? 'openai');
        const modelId = String(payload.modelId ?? 'gpt-5.1');
        const model = {
          id: String(
            payload.replaceId ?? `custom:${provider}:${modelId}:${Date.now()}`,
          ),
          displayName: String(payload.displayName ?? modelId),
          provider,
          baseUrl: String(payload.baseUrl ?? ''),
          enabled: true,
          isCustom: true,
        };
        models = [...models.filter((item) => item.id !== model.id), model];
        currentModel = model.id;
        persistModels();
        window.setTimeout(emitModels, 50);
      }
      if (frame.type === 'delete_custom_model') {
        models = models.filter((item) => item.id !== payload.id);
        if (!models.some((item) => item.id === currentModel))
          currentModel = String(models[0]?.id ?? '');
        persistModels();
        window.setTimeout(emitModels, 50);
      }
      if (frame.type === 'send_user_message') {
        const sessionId = String(payload.sessionId ?? 'preview-session');
        const messageId = id('assistant');
        emit('message_start', {
          message: {
            id: messageId,
            sessionId,
            role: 'assistant',
            content: [{ type: 'text', value: '' }],
            timestamp: Date.now(),
            source: 'local',
            isStreaming: true,
          },
        });
        window.setTimeout(() => {
          const text =
            '这是浏览器本地预览。园区服务的完整模拟流程可在右侧「园区服务」中演示。';
          emit('chat_chunk', { sessionId, messageId, delta: text });
          emit('chat_complete', {
            sessionId,
            messageId,
            text,
            finishReason: 'stop',
          });
        }, 160);
      }
    },
    parkConfig: () => Promise.resolve(null),
    onMenu: () => () => {},
    onUpdateProgress: () => () => {},
    onNotificationUnreadChanged: () => () => {},
    onNotificationSessionOpen: () => () => {},
    onEnterpriseRegistrationIntent: () => () => {},
    onEnterpriseSessionInvalidated: () => () => {},
    onEnterpriseAccountUpdated: () => () => {},
    notificationShow: () => Promise.resolve(),
    notificationMarkRead: () => Promise.resolve(),
    notificationGetUnread: () => Promise.resolve([]),
    appVersion: () => Promise.resolve('1.9.10-browser-preview'),
    openExternal: () => Promise.resolve(),
    openPath: () => Promise.resolve(),
    inspectLocalPath: () =>
      Promise.resolve({
        exists: false,
        kind: 'missing' as const,
        canOpen: false,
      }),
    activateLocalPath: () =>
      Promise.resolve({ ok: false, error: '浏览器预览不支持打开本地文件' }),
    saveTextFile: () => Promise.resolve(null),
    getPathForFile: (file: File) =>
      (file as File & { path?: string }).path || file.name,
    readClipboardText: () =>
      navigator.clipboard?.readText?.() ?? Promise.resolve(''),
    updateCheck: () =>
      Promise.resolve({
        status: 'up-to-date',
        currentVersion: '1.9.10',
        latestVersion: null,
      }),
    updateDownload: () =>
      Promise.resolve({ ok: false, error: '浏览器预览不支持更新' }),
    updateCancel: () => Promise.resolve(),
    updateInstall: () =>
      Promise.resolve({ ok: false, message: '浏览器预览不支持安装' }),
    themeGet: () => Promise.resolve('dark'),
    themeSet: () => Promise.resolve('dark'),
    enterpriseSession: () =>
      Promise.resolve({
        serverUrl: 'browser-preview://local',
        account: previewAccount,
      }),
    enterpriseLogout: () => Promise.resolve(),
    enterprisePresenceHeartbeat: () => Promise.resolve(),
    enterpriseMessagesUnread: () => Promise.resolve([]),
    enterpriseAtoaInbox: () => Promise.resolve([]),
    enterpriseOrganizationFeaturesGet: () =>
      Promise.resolve({
        direct_messaging: true,
        knowledge_base: true,
        park_service: true,
        worklog: true,
        usage_audit: true,
      }),
    enterpriseOrganizationView: () =>
      Promise.resolve({
        organization: {
          id: previewAccount.organizationId,
          name: previewAccount.organizationName,
          status: 'active',
          parkId: 'preview-park',
          createdAt: previewAccount.createdAt,
        },
        members: [
          {
            ...previewAccount,
            role: '企业员工',
            department: '入驻企业',
            departmentId: 'preview-department',
            positionTitle: '员工',
            avatarUrl: null,
            ottoOnline: true,
            ottoLastSeenAt: new Date().toISOString(),
          },
          {
            id: 'preview-colleague',
            username: 'preview.colleague',
            name: '演示同事',
            role: '企业员工',
            department: '入驻企业',
            departmentId: 'preview-department',
            positionId: null,
            positionTitle: '项目经理',
            avatarUrl: null,
            isAdmin: false,
            status: 'active',
            ottoOnline: true,
            ottoLastSeenAt: new Date().toISOString(),
          },
          {
            id: 'preview-colleague-two',
            username: 'preview.colleague.two',
            name: '演示同事二',
            role: '企业员工',
            department: '入驻企业',
            departmentId: 'preview-department',
            positionId: null,
            positionTitle: '运营经理',
            avatarUrl: null,
            isAdmin: false,
            status: 'active',
            ottoOnline: false,
            ottoLastSeenAt: new Date(Date.now() - 20 * 60_000).toISOString(),
          },
        ],
        employeeCount: 3,
        structure: [],
        features: {
          direct_messaging: true,
          knowledge_base: true,
          park_service: true,
          worklog: true,
          usage_audit: true,
        },
      }),
    enterpriseMessagesList: (peerAccountId: string) =>
      Promise.resolve(previewDirectMessages.get(peerAccountId) ?? []),
    enterpriseE2eeDevicesList: () =>
      Promise.resolve([
        {
          accountId: previewAccount.id,
          deviceId: 'browser-preview-device',
          deviceName: '浏览器预览设备',
          identitySigningPublicKey: 'preview-signing-key',
          deviceExchangePublicKey: 'preview-exchange-key',
          keyFingerprint: '0'.repeat(64),
          approvalState: 'approved',
          approvedByDeviceId: null,
          approvedAt: new Date().toISOString(),
          isCurrentDevice: true,
          createdAt: new Date().toISOString(),
          lastSeenAt: new Date().toISOString(),
          revokedAt: null,
        },
      ]),
    enterpriseE2eeDeviceApprove: () =>
      Promise.resolve({
        accountId: previewAccount.id,
        deviceId: 'browser-preview-device',
        deviceName: '浏览器预览设备',
        identitySigningPublicKey: 'preview-signing-key',
        deviceExchangePublicKey: 'preview-exchange-key',
        keyFingerprint: '0'.repeat(64),
        approvalState: 'approved',
        approvedByDeviceId: null,
        approvedAt: new Date().toISOString(),
        isCurrentDevice: true,
        createdAt: new Date().toISOString(),
        lastSeenAt: new Date().toISOString(),
        revokedAt: null,
      }),
    enterpriseE2eeDeviceVerification: () =>
      Promise.resolve({
        safetyNumber:
          '00000 00000 00000 00000 00000 00000 00000 00000 00000 00000 00000 00000',
        qrPayload: 'otto-e2ee-verify:v1:e30',
        deviceFingerprints: ['0'.repeat(64), '0'.repeat(64)],
      }),
    enterpriseE2eeDeviceRevoke: () => Promise.resolve(),
    enterpriseE2eeRecoveryExport: () =>
      Promise.resolve('{"v":1,"preview":true}'),
    enterpriseE2eeRecoveryImport: () => Promise.resolve(),
    enterpriseMessageSend: (
      peerAccountId: string,
      content: string,
      attachments: Array<Record<string, unknown>> = [],
    ) => {
      const message = {
        id: id('preview-message'),
        senderAccountId: previewAccount.id,
        recipientAccountId: peerAccountId,
        content,
        createdAt: new Date().toISOString(),
        readAt: null,
        attachments: attachments.map((attachment) => ({
          id: id('preview-attachment'),
          fileName: attachment.fileName,
          mimeType: attachment.mimeType,
          size: attachment.size,
        })),
      };
      previewDirectMessages.set(peerAccountId, [
        ...(previewDirectMessages.get(peerAccountId) ?? []),
        message,
      ]);
      return Promise.resolve(message);
    },
    enterpriseParkView: () =>
      Promise.resolve({
        id: 'preview-park',
        name: '北控宏创科技园',
        slug: 'browser-preview',
        brandName: '北控宏创园区服务',
        adminOrganizationId: 'preview-park-admin',
        status: 'active',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        isAdminOrganization: false,
        tenantAddress: '科技大厦 A 座',
        tenantRoomNumber: '1203 室',
      }),
    enterpriseTicketList: () => Promise.resolve(previewTickets),
    enterpriseParkPublications: () => Promise.resolve([]),
    enterpriseParkResources: () =>
      Promise.resolve({
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
            openingHours: '工作日 09:00–23:00',
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
            openingHours: '工作日 09:00–23:00',
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
            openingHours: '工作日 09:00–23:00',
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
      const formData =
        input.formData && typeof input.formData === 'object'
          ? (input.formData as Record<string, unknown>)
          : {};
      if (serviceId === 'meeting-room') {
        const selectedSlots = previewMeetingSlots.filter(
          (item) =>
            item.roomId === formData.roomId &&
            item.date === formData.date &&
            String(item.slotKey) >= String(formData.startTime) &&
            String(item.slotKey) < String(formData.endTime),
        );
        if (
          !selectedSlots.length ||
          selectedSlots.some((slot) => slot.status !== 'available')
        ) {
          const booked = selectedSlots.some((slot) => slot.status === 'booked');
          return Promise.reject(
            new Error(
              booked ? '该时段刚刚已被预约，请选择其他时段' : '该时段暂未开放',
            ),
          );
        }
        for (const slot of selectedSlots) {
          slot.status = 'booked';
          slot.updatedAt = now;
        }
      }
      previewApplicationSequence += 1;
      const ticket = {
        id: id('preview-ticket'),
        applicationNumber: `${parkISODate().replace(/-/g, '')}${String(previewApplicationSequence).padStart(3, '0')}`,
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
        recipients:
          serviceId === 'repair'
            ? [{ id: 'preview-repairer', name: '维修工作人员' }]
            : [
                { id: 'preview-cs-1', name: '客服一组' },
                { id: 'preview-cs-2', name: '客服二组' },
              ],
        deliveryStatus: serviceId === 'renovation' ? '已投递客服部' : '已投递',
        readAt: null,
        creatorUpdateAt: null,
        creatorUpdateReadAt: null,
        isCreator: true,
        isRecipient: false,
        notifications: [],
      };
      previewTickets = [ticket, ...previewTickets];
      return Promise.resolve(ticket);
    },
    enterpriseTicketRead: (ticketId: string) => {
      const ticket =
        previewTickets.find((item) => item.id === ticketId) ?? null;
      if (!ticket) return Promise.reject(new Error('申请单不存在'));
      const viewed = {
        ...ticket,
        creatorUpdateReadAt: new Date().toISOString(),
        readAt: ticket.isRecipient ? new Date().toISOString() : ticket.readAt,
      };
      previewTickets = previewTickets.map((item) =>
        item.id === ticketId ? viewed : item,
      );
      return Promise.resolve(viewed);
    },
    enterpriseTicketAction: (ticketId: string) => {
      const ticket =
        previewTickets.find((item) => item.id === ticketId) ?? null;
      return ticket
        ? Promise.resolve(ticket)
        : Promise.reject(new Error('申请单不存在'));
    },
    enterpriseUsageRecord: () => Promise.resolve({ recorded: false }),
    enterpriseKnowledgeRecord: () =>
      Promise.resolve({ status: 'exists', added: false }),
    enterpriseKnowledgeList: () => Promise.resolve([]),
    enterpriseKnowledgeReview: () =>
      Promise.reject(new Error('预览模式不支持知识审核')),
    enterpriseKnowledgeRevise: () =>
      Promise.reject(new Error('预览模式不支持知识修订')),
    enterpriseKnowledgeRevisions: () => Promise.resolve([]),
  };

  previewWindow.otto = new Proxy(bridge, {
    get(target, key) {
      return key in target
        ? target[key as string]
        : () => Promise.resolve(null);
    },
  });
}
