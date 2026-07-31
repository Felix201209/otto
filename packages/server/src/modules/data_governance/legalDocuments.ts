/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'node:crypto';

export interface LegalDocumentDefinition {
  id: 'terms' | 'privacy';
  title: string;
  version: string;
  effectiveAt: string;
  required: true;
  summary: string[];
  sourceUrls: string[];
}

export const CURRENT_LEGAL_DOCUMENTS: readonly LegalDocumentDefinition[] = [
  {
    id: 'terms',
    title: 'Otto 用户服务协议',
    version: '2026-07-29',
    effectiveAt: '2026-07-29',
    required: true,
    summary: [
      'Otto 仅在企业授权、账号权限和模块许可范围内提供服务。',
      '用户应对提交内容具有合法使用权，不得利用 Otto 实施违法或侵权行为。',
      '私有化部署由客户管理运行环境、账号权限、备份与外部模型供应商配置。',
      '服务中断、数据导出、账号注销和争议处理按本协议及适用法律执行。',
    ],
    sourceUrls: [
      'https://www.miit.gov.cn/zcfg/qtl/art/2023/art_f4e8f71ae1dc43b0980b962907b7738f.html',
    ],
  },
  {
    id: 'privacy',
    title: 'Otto 隐私与数据处理规则',
    version: '2026-07-29',
    effectiveAt: '2026-07-29',
    required: true,
    summary: [
      '默认在所连接的企业服务器和用户本机处理数据，默认不跨境传输。',
      '健康遥测默认不包含聊天、文件、会议原文或个人记忆，管理员可查看并关闭。',
      '用户可查看处理目录、导出个人数据、撤回可选处理同意并申请注销。',
      '注销后删除或匿名化个人数据；法定留存和加密备份只限存储、安全与审计。',
    ],
    sourceUrls: [
      'https://www.cac.gov.cn/2024-09/30/c_1729384452307680.htm',
      'https://www.npc.gov.cn/WZWSREL25wYy9jMzA4MzQvMjAyMTA4L3QyMDIxMDgyMF8zMTMwODguaHRtbD9yZWY9aW1i',
    ],
  },
] as const;

export function legalDocumentHash(document: LegalDocumentDefinition): string {
  return createHash('sha256')
    .update(JSON.stringify(document), 'utf8')
    .digest('hex');
}

export interface DataProcessingActivity {
  id: string;
  category: string;
  purpose: string;
  sensitivity: 'ordinary' | 'sensitive' | 'security';
  storage: 'user_device' | 'enterprise_server' | 'configured_provider';
  atRest: string;
  transport: string;
  retention: string;
  deletion: string;
  recipients: string[];
  crossBorder: boolean;
}

export function dataProcessingInventory(): DataProcessingActivity[] {
  const crossBorder = process.env.OTTO_CROSS_BORDER_DATA_ENABLED === 'true';
  return [
    {
      id: 'identity', category: '账号与企业身份', purpose: '登录、组织与权限控制',
      sensitivity: 'sensitive', storage: 'enterprise_server', atRest: '密码仅保存强哈希；资料存于企业数据库',
      transport: '公网仅允许 HTTPS；会话令牌通过 Authorization 请求头传输',
      retention: '账号存续期间', deletion: '注销时删除标识并将账号和员工记录匿名化',
      recipients: ['企业管理员', 'Otto 企业服务器'], crossBorder: false,
    },
    {
      id: 'collaboration', category: '私聊与附件', purpose: '企业协作与 A2A',
      sensitivity: 'sensitive', storage: 'enterprise_server', atRest: '客户端对消息正文、附件内容和附件元数据执行端到端 AES-256-GCM 加密；服务器只保存密文、设备信封与路由元数据',
      transport: 'HTTPS/TLS 叠加设备级端到端加密与 Ed25519 签名', retention: '账号存续期间或企业配置期限',
      deletion: '注销时删除本人参与的私聊密文、附件密文和设备目录', recipients: ['聊天双方的已授权设备'], crossBorder: false,
    },
    {
      id: 'personal_intelligence', category: '个人记忆、工作日志与自动 Skill', purpose: '跨设备恢复与个性化协助',
      sensitivity: 'sensitive', storage: 'user_device', atRest: '本机活动文件由操作系统磁盘保护；桌面同步镜像使用系统安全存储；服务器快照使用 AES-256-GCM',
      transport: 'HTTPS/TLS', retention: '账号存续期间', deletion: '注销时删除服务器快照并清理当前设备托管文件',
      recipients: ['用户本人', '所连接的企业服务器'], crossBorder: false,
    },
    {
      id: 'park_services', category: '园区申请与服务记录', purpose: '办理园区服务、统计次数和费用',
      sensitivity: 'sensitive', storage: 'enterprise_server', atRest: '企业数据库；备份加密',
      transport: 'HTTPS/TLS', retention: '业务办理和合同/财务所需期限',
      deletion: '注销时清除联系人、电话、说明等个人字段，保留匿名化服务类型、时间、状态和金额统计',
      recipients: ['所属企业', '所属园区授权工作人员'], crossBorder: false,
    },
    {
      id: 'model_requests', category: '模型请求', purpose: '生成回答和执行 Agent 工作',
      sensitivity: 'sensitive', storage: 'configured_provider', atRest: '由客户选择的模型供应商规则决定',
      transport: '供应商 HTTPS API', retention: '由客户配置和供应商条款决定',
      deletion: 'Otto 仅能删除本地和企业服务器副本；供应商副本按其协议处理',
      recipients: ['客户配置的模型供应商'], crossBorder,
    },
    {
      id: 'telemetry', category: '授权、健康与用量遥测', purpose: 'License 校验、稳定性和容量分析',
      sensitivity: 'security', storage: 'enterprise_server', atRest: '签名队列；不包含聊天、文件、会议和个人记忆原文',
      transport: 'HTTPS + HMAC-SHA256 请求签名、时间戳与一次性随机数', retention: '默认 90 天，可由部署方缩短或关闭',
      deletion: '到期清理；关闭后停止产生和上传新遥测', recipients: ['客户管理员', '明确配置的 Otto 运营端点'], crossBorder: false,
    },
    {
      id: 'audit_backup', category: '安全审计与加密备份', purpose: '安全追溯、容灾和恢复',
      sensitivity: 'security', storage: 'enterprise_server', atRest: '审计存于数据库；备份使用 AES-256-GCM',
      transport: '异地副本由客户配置的安全通道传输', retention: '安全日志不少于 180 天；备份默认 30 天',
      deletion: '注销后备份仅限隔离存储与安全恢复，到期自动清除；恢复时重新应用删除账本',
      recipients: ['客户安全管理员'], crossBorder: false,
    },
  ];
}

export function dataGovernanceConfiguration() {
  const controllerName = process.env.OTTO_DATA_CONTROLLER_NAME?.trim() || '';
  const privacyContact = process.env.OTTO_PRIVACY_CONTACT?.trim() || '';
  const region = process.env.OTTO_DATA_REGION?.trim() || 'CN';
  const crossBorder = process.env.OTTO_CROSS_BORDER_DATA_ENABLED === 'true';
  const storageVolumeEncrypted =
    process.env.OTTO_STORAGE_VOLUME_ENCRYPTED === 'true';
  const configuredTelemetryRetention = Number(
    process.env.OTTO_TELEMETRY_RETENTION_DAYS || 90,
  );
  const telemetryRetentionDays = Number.isFinite(configuredTelemetryRetention)
    ? Math.max(1, Math.min(3650, Math.floor(configuredTelemetryRetention)))
    : 90;
  return {
    controller: {
      name: controllerName || '待部署管理员配置',
      privacyContact: privacyContact || '待部署管理员配置',
      configured: Boolean(controllerName && privacyContact),
    },
    residency: {
      mode: process.env.OTTO_DATA_RESIDENCY?.trim() || 'customer_server',
      region,
      crossBorderEnabled: crossBorder,
      localizationReady: region === 'CN' && !crossBorder,
    },
    security: {
      publicTransport: 'HTTPS/TLS required',
      database: 'SQLite on the selected enterprise server',
      storageVolumeEncrypted,
      encryptedData: ['account sync snapshots', 'desktop account-sync mirrors', 'direct-message bodies', 'message attachment objects', 'data-protection backups'],
      hashedData: ['passwords', 'session tokens', 'SMS verification codes'],
      plaintextData: ['non-content business fields needed for search, permissions and statistics'],
    },
    retention: {
      securityAuditMinimumDays: 180,
      encryptedBackupDefaultDays: 30,
      healthTelemetryDefaultDays: telemetryRetentionDays,
    },
    readiness: {
      configured: Boolean(
        controllerName && privacyContact && storageVolumeEncrypted,
      ),
      warnings: [
        ...(!controllerName ? ['OTTO_DATA_CONTROLLER_NAME 未配置'] : []),
        ...(!privacyContact ? ['OTTO_PRIVACY_CONTACT 未配置'] : []),
        ...(!storageVolumeEncrypted
          ? ['OTTO_STORAGE_VOLUME_ENCRYPTED 未确认，结构化业务字段缺少磁盘级静态保护']
          : []),
        ...(crossBorder ? ['已开启跨境数据处理，需单独同意、影响评估和适用出境机制'] : []),
      ],
    },
  };
}
