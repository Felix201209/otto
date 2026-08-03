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
  sections: LegalDocumentSection[];
}

export interface LegalDocumentSection {
  id: string;
  title: string;
  paragraphs: string[];
  items?: string[];
  important?: boolean;
}

export interface LegalDocumentReference {
  id: LegalDocumentDefinition['id'];
  version: string;
  hash: string;
}

export const CURRENT_LEGAL_DOCUMENTS: readonly LegalDocumentDefinition[] = [
  {
    id: 'terms',
    title: 'Otto 用户服务协议',
    version: '2026-08-03',
    effectiveAt: '2026-08-03',
    required: true,
    summary: [
      'Otto 仅在企业授权、账号权限和模块许可范围内提供服务。',
      '用户应对提交内容具有合法使用权，不得利用 Otto 实施违法或侵权行为。',
      '私有化部署由客户管理运行环境、账号权限、备份与外部模型供应商配置。',
      '服务中断、数据导出、账号注销和争议处理按本协议及适用法律执行。',
    ],
    sourceUrls: [
      'https://www.npc.gov.cn/npc/c2/c30834/202009/t20200921_307713.html',
      'https://www.cac.gov.cn/2023-07/13/c_1690898327029107.htm',
    ],
    sections: [
      {
        id: 'scope',
        title: '一、协议主体与适用范围',
        paragraphs: [
          '本协议由使用 Otto 的自然人用户与本页面列明的服务提供方或私有化部署方共同订立，适用于 Otto 桌面端、企业服务端及部署方明确启用的配套模块。',
          '私有化部署场景中，部署方负责其运行环境、成员账号、组织权限、模型供应商及业务配置；Otto 软件提供方与部署方的责任边界还应以双方商业合同为准。',
        ],
      },
      {
        id: 'service',
        title: '二、服务内容与 AI 能力边界',
        paragraphs: [
          'Otto 提供对话、Agent 工具调用、文件处理、企业协作、知识与工作流等能力，实际可用功能以部署版本、License、管理员授权和界面显示为准。',
          'AI 输出基于模型推断，可能不完整、不准确或不适用于特定目的。医疗、法律、财务、安全生产及其他高风险决策不得仅依赖 AI 输出，用户应进行适当的人工复核。',
        ],
      },
      {
        id: 'account',
        title: '三、账号、设备与企业权限',
        paragraphs: [
          '用户应提供真实、合法且必要的注册信息，妥善保管账号、验证码、密码、设备恢复材料和安全号码，不得出借、转让或共同使用个人账号。',
          '企业账号的组织、部门、岗位、角色和模块权限由企业服务器作为权威来源；管理员可依法依约进行入职、调岗、离职、设备撤销和访问控制。',
        ],
        items: [
          '发现账号、设备或恢复材料异常时，应立即撤销设备、修改凭据并联系管理员。',
          '用户不得绕过权限校验、审计、配额、License 或安全门禁。',
        ],
      },
      {
        id: 'content',
        title: '四、用户内容与合法使用',
        paragraphs: [
          '用户应确保其输入、上传、授权访问及要求 Otto 处理的内容具有合法来源和相应权利，不侵犯国家安全、商业秘密、知识产权、个人信息及其他合法权益。',
        ],
        items: [
          '不得利用 Otto 生成、传播或协助实施违法、有害、欺诈、侵权或绕过安全控制的内容。',
          '不得上传无权处理的个人信息、密钥、凭据、受管制数据或第三方机密。',
          '不得通过自动化调用干扰服务、消耗他人配额、探测其他租户或破坏系统稳定性。',
        ],
      },
      {
        id: 'tools',
        title: '五、工具调用与高风险操作',
        paragraphs: [
          'Otto 可在用户授权范围内读取文件、执行命令、访问外部服务或调用企业系统。涉及删除、覆盖、外发、付款、审批、权限变更等高风险行为时，应经过产品提供的确认、策略和审计路径。',
          '用户仍应核对操作目标、范围和结果；不得要求 Otto 绕过系统权限、审批或安全限制。',
        ],
        important: true,
      },
      {
        id: 'models',
        title: '六、模型供应商与第三方服务',
        paragraphs: [
          '部署方或用户配置外部模型、短信、飞书、对象存储及其他第三方服务时，相关数据会按完成请求所必需的范围发送给对应服务商。第三方的可用性、地域、留存和计费规则由其自身协议决定。',
          '部署方应在启用第三方服务前完成供应商评估、数据流确认和必要告知，不得把第三方服务的承诺表述为 Otto 自身承诺。',
        ],
        important: true,
      },
      {
        id: 'security',
        title: '七、私聊加密与安全边界',
        paragraphs: [
          '标记为端到端加密的私聊消息和附件由客户端加密，企业服务器保存密文及必要路由元数据。用户明确授权给 Otto 的内容，或在本机解密后交给 Otto 的内容，不再处于“Otto 无法读取”的边界内。',
          '当前安全能力以部署健康状态和发布门禁为准。在经过审计的会话协议正式启用前，不应宣称具备 Signal Double Ratchet、完整前向保密或入侵后恢复能力。',
        ],
        important: true,
      },
      {
        id: 'fees',
        title: '八、商业授权、费用与配额',
        paragraphs: [
          '企业版功能、席位、模块、用量、续费和支持服务以订单、License 及商业合同为准。界面展示的估算用量不替代双方确认的结算记录。',
          '授权失效或超出配额时，服务可按合同限制非必要功能，但依法应保留的数据访问、导出、注销和安全处置入口不应仅因商业授权失效而关闭。',
        ],
      },
      {
        id: 'availability',
        title: '九、变更、中断与维护',
        paragraphs: [
          '为安全修复、版本升级、容量维护、第三方故障或不可抗力，服务可能暂时中断。部署方应根据业务重要性配置高可用、备份、恢复演练和通知机制。',
          '对用户权益有重大影响的功能或协议变化，应以显著方式通知；需要重新同意的，旧版本同意不得自动沿用。',
        ],
      },
      {
        id: 'intellectual-property',
        title: '十、知识产权',
        paragraphs: [
          'Otto 软件、商标、界面和文档的权利归相应权利人所有。用户保留其依法享有的输入和业务内容权利；AI 输出能否获得或不侵犯第三方权利，应结合具体内容和适用法律判断。',
          '开源组件依各自许可证使用，商业交付不改变第三方开源许可证赋予或限制的权利。',
        ],
      },
      {
        id: 'suspension',
        title: '十一、暂停、终止与数据处理',
        paragraphs: [
          '用户严重违反法律、本协议或企业安全策略，或其行为对系统及他人造成现实风险时，部署方可采取警示、限制、暂停或终止措施，并保留必要安全记录。',
          '账号注销、员工离职或服务终止后的数据删除、匿名化、导出、法定留存和备份宽限期，按照隐私规则、企业制度及适用法律执行。',
        ],
        important: true,
      },
      {
        id: 'liability',
        title: '十二、责任限制与风险分配',
        paragraphs: [
          '任何免责或责任限制均不得排除法律规定不得排除的责任。对与用户有重大利害关系的限制，部署方应采用显著方式提示并按要求说明。',
          '因用户违法使用、越权配置、泄露凭据、未执行必要复核，或其自行选择的第三方服务造成的损失，由责任方依法律和合同承担；具体赔偿范围以适用法律和商业合同为准。',
        ],
        important: true,
      },
      {
        id: 'law-dispute',
        title: '十三、适用法律、投诉与争议解决',
        paragraphs: [
          '本协议的订立、履行和解释适用中华人民共和国法律。用户可先通过本页面列明的联系方式投诉或协商；协商不成的，按照部署方经法务确认并在正式版本中明确的争议解决条款处理。',
          '部署方未配置准确主体、地址、联系方式和争议解决条款前，本页面应显示未就绪，不得作为已完成正式法律交付的依据。',
        ],
        important: true,
      },
      {
        id: 'effective',
        title: '十四、生效与版本',
        paragraphs: [
          '用户勾选同意或在设置中确认时，系统记录文档编号、版本、完整正文哈希和时间。正文、关键处理规则或权利义务变化会产生新版本，并要求用户重新阅读确认。',
        ],
      },
    ],
  },
  {
    id: 'privacy',
    title: 'Otto 隐私与数据处理规则',
    version: '2026-08-03',
    effectiveAt: '2026-08-03',
    required: true,
    summary: [
      '默认在所连接的企业服务器和用户本机处理数据，默认不跨境传输。',
      '健康遥测默认不包含聊天、文件、会议原文或个人记忆，管理员可查看并关闭。',
      '用户可查看处理目录、导出个人数据、撤回可选处理同意并申请注销。',
      '注销后删除或匿名化个人数据；法定留存和加密备份只限存储、安全与审计。',
    ],
    sourceUrls: [
      'https://www.cac.gov.cn/2024-09/30/c_1729384452307680.htm',
      'https://www.cac.gov.cn/2021-08/20/c_1631050028355286.htm',
    ],
    sections: [
      {
        id: 'scope-controller',
        title: '一、适用范围与个人信息处理者',
        paragraphs: [
          '本规则适用于 Otto 桌面端、企业服务端及部署方启用的企业协作、园区、知识、工作流和支持诊断能力。页面顶部列明的主体为当前部署声明的个人信息处理者，隐私联系人负责受理个人信息权利请求。',
          '若主体名称或隐私联系方式显示“待配置”，说明部署尚未完成法律交付准备；用户应联系部署管理员，不应把本规则视为已由实际处理者确认的最终版本。',
        ],
      },
      {
        id: 'principles',
        title: '二、处理原则与合法性基础',
        paragraphs: [
          '处理个人信息遵循合法、正当、必要、诚信、目的明确、最小范围、公开透明和安全保障原则。',
          '处理活动根据具体场景以履行合同、依法履行义务、实施人力资源管理、应对公共卫生或紧急保护、处理依法公开信息、取得个人同意等适用基础进行；基于同意的处理可依法撤回。',
        ],
      },
      {
        id: 'categories',
        title: '三、处理的信息种类',
        paragraphs: [
          '实际处理种类取决于部署配置和用户使用的功能。设置中的“数据处理目录”列出每类数据的目的、位置、保护、留存、删除和接收方。',
        ],
        items: [
          '账号与企业身份：手机号、用户名、姓名、企业、部门、岗位、角色、设备标识及登录安全记录。',
          '用户内容：对话、提示词、文件、附件、会议材料、知识条目、工作日志和工具调用上下文。',
          '业务数据：园区申请、工单、审批、用量、配额、License 与组织配置。',
          '安全与运行数据：会话、审计、错误、性能、容量、备份和密钥版本元数据。',
          '可能的敏感个人信息：账号凭据、特定身份、金融或交易信息、行踪位置、通信内容及未满十四周岁未成年人信息；仅在特定目的和充分必要时处理。',
        ],
      },
      {
        id: 'purposes',
        title: '四、处理目的与方式',
        paragraphs: [
          '个人信息用于身份验证、组织权限、提供 Agent 和协作能力、完成用户请求、同步与恢复、安全审计、计量结算、客户支持及履行法律义务。',
          '处理方式包括收集、存储、使用、传输、检索、加密、备份、导出、删除和匿名化。Otto 不应将私聊、文件、会议或个人记忆原文用于未明确告知的运营遥测或模型训练。',
        ],
      },
      {
        id: 'devices-local',
        title: '五、本机数据与桌面权限',
        paragraphs: [
          '桌面端为离线能力和本机缓存使用 SQLite/SQLCipher、系统安全存储及用户选择的文件目录。文件、目录、剪贴板、通知、浏览器和系统命令权限仅应在功能需要和用户授权范围内使用。',
          '目录授权、文件快照和能力令牌应遵守产品安全限制；用户撤销授权后，后续读取不得仅依赖历史绝对路径。',
        ],
      },
      {
        id: 'enterprise-storage',
        title: '六、企业服务器、存储位置与留存',
        paragraphs: [
          '企业集群以 PostgreSQL 保存账号、组织、审计、消息密文和对象元数据，以 S3/MinIO 保存附件密文和备份对象，以 Redis/兼容缓存保存会话、限流、锁和短期状态。离线或开发部署可使用本地数据库和对象存储。',
          '各类数据保存期限在数据处理目录中列明。达到目的、用户注销或期限届满后删除或匿名化；安全、财务、争议处理及备份恢复所需记录在法定或合同期限内最小保留。',
        ],
      },
      {
        id: 'e2ee',
        title: '七、私聊与附件端到端加密',
        paragraphs: [
          'E2EE 私聊的正文、附件内容和必要附件元数据在客户端加密，服务器仅保存密文、设备信封和路由元数据。对象存储无法获得客户端文件密钥或附件明文。',
          '用户明确授权某段消息给 Otto，或在本机解密后交给 Otto 处理时，对应明文会在该处理范围内可见。当前设备信封协议不等同于 Signal Double Ratchet；完整前向保密和入侵后恢复仅在经审计协议通过发布门禁后成立。',
        ],
        important: true,
      },
      {
        id: 'providers',
        title: '八、模型供应商、委托处理与共同接收方',
        paragraphs: [
          '用户或部署方选择外部模型、短信、飞书、对象存储、云 KMS、监控和支持服务时，会向对应服务商提供完成目的所必需的数据。模型请求可能包含用户主动提交的提示词、上下文和文件内容。',
          '部署方应公开实际供应商清单、处理目的、数据种类、地域和联系方式，并通过合同、权限和审计约束受托方。未配置的第三方不应收到数据。',
        ],
        important: true,
      },
      {
        id: 'cross-border',
        title: '九、数据跨境',
        paragraphs: [
          '默认数据区域和跨境状态显示在“隐私与数据”页面。关闭跨境配置标记不代表技术上绝无跨境；境外模型、云服务、支持诊断或管理员操作均可能改变数据流。',
          '发生适用的数据出境前，部署方应完成数据流梳理、影响评估、告知、单独同意及法律要求的安全评估、认证或标准合同等程序。',
        ],
        important: true,
      },
      {
        id: 'security',
        title: '十、安全保护与事件处置',
        paragraphs: [
          'Otto 采用身份认证、租户隔离、最小权限、TLS、客户端 E2EE、数据库或字段加密、对象存储保护、审计、备份、密钥轮换和安全发布门禁等措施。具体启用状态以运维安全状态页和部署检查结果为准。',
          '发生或可能发生泄露、篡改、丢失时，处理者应依法采取补救、记录、报告和通知措施。任何安全能力在未完成实际配置、构建和验证前不得仅凭源代码存在宣称正式交付。',
        ],
      },
      {
        id: 'rights',
        title: '十一、个人信息权利与申请方式',
        paragraphs: [
          '用户可通过“隐私与数据”页面或页面顶部的隐私联系人，依法请求查阅、复制、导出、更正、补充、删除个人信息，撤回基于同意的处理，解释处理规则或注销账号。',
          '处理者可为保护账号和他人权益进行必要身份核验，并在适用法律期限内答复；无法满足的，应说明理由和申诉途径。撤回同意不影响撤回前处理活动的效力，也不影响基于其他合法性基础的必要处理。',
        ],
      },
      {
        id: 'deletion-backups',
        title: '十二、注销、删除与备份恢复',
        paragraphs: [
          '账号注销会删除或匿名化可删除的个人数据；财务、安全、争议和法定义务记录按最小范围留存。企业最后一名管理员应先移交权限。',
          '备份在隔离恢复窗口内可能暂存已删除数据，但不得用于日常业务；恢复旧备份时应重放删除台账，宽限期届满后清理备份副本和孤儿对象。',
        ],
      },
      {
        id: 'minors',
        title: '十三、未成年人信息',
        paragraphs: [
          'Otto 企业服务原则上面向具备相应工作授权的用户。处理不满十四周岁未成年人个人信息时，部署方应取得监护人同意，制定专门规则并采取严格保护措施；无法满足时不应开通相关账号或处理。',
        ],
        important: true,
      },
      {
        id: 'changes-contact',
        title: '十四、规则变更、公开与联系',
        paragraphs: [
          '本规则应公开并便于查阅和保存。处理目的、方式、种类、接收方、跨境或用户权利发生实质变化时，部署方应显著通知；依法需要同意的，应发布新版本并重新取得同意。',
          '用户可通过页面顶部的隐私联系方式咨询、投诉或行使权利。处理者名称、地址、联系方式、实际供应商和争议渠道未配置完整前，正式上线门禁应保持未就绪。',
        ],
      },
    ],
  },
] as const;

export function legalDocumentHash(document: LegalDocumentDefinition): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        schemaVersion: 1,
        id: document.id,
        title: document.title,
        version: document.version,
        effectiveAt: document.effectiveAt,
        required: document.required,
        summary: document.summary,
        sections: document.sections,
        sourceUrls: document.sourceUrls,
      }),
      'utf8',
    )
    .digest('hex');
}

export function currentLegalDocumentReferences(): LegalDocumentReference[] {
  return CURRENT_LEGAL_DOCUMENTS.map((document) => ({
    id: document.id,
    version: document.version,
    hash: legalDocumentHash(document),
  }));
}

export function requireCurrentLegalDocumentReferences(
  value: unknown,
): LegalDocumentReference[] {
  const invalid = (): never => {
    throw new Error('用户协议或隐私规则已更新，请重新阅读后确认');
  };
  if (
    !Array.isArray(value) ||
    value.length !== CURRENT_LEGAL_DOCUMENTS.length
  ) {
    return invalid();
  }
  const expected = currentLegalDocumentReferences();
  const received = new Map<string, LegalDocumentReference>();
  for (const entry of value) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) invalid();
    const record = entry as Record<string, unknown>;
    if (
      (record.id !== 'terms' && record.id !== 'privacy') ||
      typeof record.version !== 'string' ||
      typeof record.hash !== 'string' ||
      !/^[0-9a-f]{64}$/u.test(record.hash) ||
      received.has(record.id)
    ) {
      invalid();
    }
    const id = record.id as LegalDocumentReference['id'];
    received.set(id, {
      id,
      version: record.version as string,
      hash: record.hash as string,
    });
  }
  for (const reference of expected) {
    const actual = received.get(reference.id);
    if (
      !actual ||
      actual.version !== reference.version ||
      actual.hash !== reference.hash
    ) {
      invalid();
    }
  }
  return expected;
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
      id: 'identity',
      category: '账号与企业身份',
      purpose: '登录、组织与权限控制',
      sensitivity: 'sensitive',
      storage: 'enterprise_server',
      atRest: '密码仅保存强哈希；资料存于企业数据库',
      transport: '公网仅允许 HTTPS；会话令牌通过 Authorization 请求头传输',
      retention: '账号存续期间',
      deletion: '注销时删除标识并将账号和员工记录匿名化',
      recipients: ['企业管理员', 'Otto 企业服务器'],
      crossBorder: false,
    },
    {
      id: 'collaboration',
      category: '私聊与附件',
      purpose: '企业协作与 A2A',
      sensitivity: 'sensitive',
      storage: 'enterprise_server',
      atRest:
        '客户端对消息正文、附件内容和附件元数据执行端到端 AES-256-GCM 加密；服务器只保存密文、设备信封与路由元数据',
      transport: 'HTTPS/TLS 叠加设备级端到端加密与 Ed25519 签名',
      retention: '账号存续期间或企业配置期限',
      deletion: '注销时删除本人参与的私聊密文、附件密文和设备目录',
      recipients: ['聊天双方的已授权设备'],
      crossBorder: false,
    },
    {
      id: 'personal_intelligence',
      category: '个人记忆、工作日志与自动 Skill',
      purpose: '跨设备恢复与个性化协助',
      sensitivity: 'sensitive',
      storage: 'user_device',
      atRest:
        '本机活动文件由操作系统磁盘保护；桌面同步镜像使用系统安全存储；服务器快照使用 AES-256-GCM',
      transport: 'HTTPS/TLS',
      retention: '账号存续期间',
      deletion: '注销时删除服务器快照并清理当前设备托管文件',
      recipients: ['用户本人', '所连接的企业服务器'],
      crossBorder: false,
    },
    {
      id: 'park_services',
      category: '园区申请与服务记录',
      purpose: '办理园区服务、统计次数和费用',
      sensitivity: 'sensitive',
      storage: 'enterprise_server',
      atRest: '企业数据库；备份加密',
      transport: 'HTTPS/TLS',
      retention: '业务办理和合同/财务所需期限',
      deletion:
        '注销时清除联系人、电话、说明等个人字段，保留匿名化服务类型、时间、状态和金额统计',
      recipients: ['所属企业', '所属园区授权工作人员'],
      crossBorder: false,
    },
    {
      id: 'model_requests',
      category: '模型请求',
      purpose: '生成回答和执行 Agent 工作',
      sensitivity: 'sensitive',
      storage: 'configured_provider',
      atRest: '由客户选择的模型供应商规则决定',
      transport: '供应商 HTTPS API',
      retention: '由客户配置和供应商条款决定',
      deletion: 'Otto 仅能删除本地和企业服务器副本；供应商副本按其协议处理',
      recipients: ['客户配置的模型供应商'],
      crossBorder,
    },
    {
      id: 'telemetry',
      category: '授权、健康与用量遥测',
      purpose: 'License 校验、稳定性和容量分析',
      sensitivity: 'security',
      storage: 'enterprise_server',
      atRest: '签名队列；不包含聊天、文件、会议和个人记忆原文',
      transport: 'HTTPS + HMAC-SHA256 请求签名、时间戳与一次性随机数',
      retention: '默认 90 天，可由部署方缩短或关闭',
      deletion: '到期清理；关闭后停止产生和上传新遥测',
      recipients: ['客户管理员', '明确配置的 Otto 运营端点'],
      crossBorder: false,
    },
    {
      id: 'audit_backup',
      category: '安全审计与加密备份',
      purpose: '安全追溯、容灾和恢复',
      sensitivity: 'security',
      storage: 'enterprise_server',
      atRest: '审计存于数据库；备份使用 AES-256-GCM',
      transport: '异地副本由客户配置的安全通道传输',
      retention: '安全日志不少于 180 天；备份默认 30 天',
      deletion:
        '注销后备份仅限隔离存储与安全恢复，到期自动清除；恢复时重新应用删除账本',
      recipients: ['客户安全管理员'],
      crossBorder: false,
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
  const legalDocumentsApproved =
    process.env.OTTO_LEGAL_DOCUMENTS_APPROVED === 'true';
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
      database:
        '桌面/离线部署使用 SQLite/SQLCipher；企业集群权威数据源使用 PostgreSQL',
      storageVolumeEncrypted,
      encryptedData: [
        'account sync snapshots',
        'desktop account-sync mirrors',
        'direct-message bodies',
        'message attachment objects',
        'data-protection backups',
      ],
      hashedData: ['passwords', 'session tokens', 'SMS verification codes'],
      plaintextData: [
        'non-content business fields needed for search, permissions and statistics',
      ],
    },
    retention: {
      securityAuditMinimumDays: 180,
      encryptedBackupDefaultDays: 30,
      healthTelemetryDefaultDays: telemetryRetentionDays,
    },
    readiness: {
      configured: Boolean(
        controllerName &&
        privacyContact &&
        storageVolumeEncrypted &&
        legalDocumentsApproved,
      ),
      legalDocumentsApproved,
      warnings: [
        ...(!controllerName ? ['OTTO_DATA_CONTROLLER_NAME 未配置'] : []),
        ...(!privacyContact ? ['OTTO_PRIVACY_CONTACT 未配置'] : []),
        ...(!storageVolumeEncrypted
          ? [
              'OTTO_STORAGE_VOLUME_ENCRYPTED 未确认，结构化业务字段缺少磁盘级静态保护',
            ]
          : []),
        ...(!legalDocumentsApproved
          ? [
              'OTTO_LEGAL_DOCUMENTS_APPROVED 未确认，正式文本尚未通过部署方法务审核',
            ]
          : []),
        ...(crossBorder
          ? ['已开启跨境数据处理，需单独同意、影响评估和适用出境机制']
          : []),
      ],
    },
  };
}
