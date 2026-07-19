/**
 * @license
 * Copyright 2025 Otto
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * 「新版本更新说明」首启弹窗。
 *
 * 行为：App 启动后读 app 版本（preload appVersion()）与 localStorage 里
 * 上次已读版本比对——不一致且 CHANGELOG 里有当前版本条目 → 弹居中对话框
 * 列出本版新增/改动；点「知道了」或 Esc/遮罩关闭并记录已读，下次启动不再弹。
 *
 * CHANGELOG 随每次发版在此文件顶部补一段（最新在前）——发布流程的一部分。
 */

import React, { useEffect, useId, useState } from 'react';
import { IconSparkle, IconClose } from './icons.js';

interface ChangelogEntry {
  version: string;
  date: string;
  items: string[];
}

/** 版本更新说明（最新在前；只有列在这里的版本会触发弹窗）。 */
const CHANGELOG: ChangelogEntry[] = [
  {
    version: '1.8.8',
    date: '2026-07-19',
    items: [
      '融合队友最新文案、数据可视化和市场调研专家：脚本与依赖说明会真实随客户端安装，并补齐跨平台启动、失败校验和安全输出',
      '融合队友最新本地语音识别更新：新增 faster-whisper 优先后端、VAD 和高质量解码参数，并修复仅安装 faster-whisper 时被依赖预检错误阻断',
      '融合队友最新 Agent 目录更新：固定为 1 个企业工作 Agent 与 8 个通用专家，移除相互冲突的部门、CEO 和自动生成目录入口',
      '延续 v1.8.7 的真实企业登录、邀请码注册与组织树修复；交付版仍保留但默认关闭可逆的内部免登录通道',
      '修复 macOS 构建服务器一键包时夹带扩展属性的问题，Ubuntu 解压后会严格校验文件清单且不再生成 ._* 元数据文件',
    ],
  },
  {
    version: '1.8.7',
    date: '2026-07-19',
    items: [
      '正式恢复企业登录页和会话验证：未登录用户进入账号密码登录，内部免登录代码保留但在交付版默认关闭',
      '修复企业邀请码注册后的组织连接：支持 HTTPS 引入链接，注册成功后恢复真实会话并加载所属企业完整组织树',
      '融合队友最新客户端能力：视频编辑器资源随安装包交付，并同步园区服务对话与右侧工作面板；未完成持久会话的本地配对入口继续隐藏',
      '增强本地语音能力：优先使用本机转录，改进 Whisper 识别、依赖诊断和多环境兼容提示',
      '完善自动 Skill 最小可用闭环，并修复 OpenAI / Anthropic 工具消息缺失关联时的会话恢复',
      '修复 Windows 发布脚本兼容性，并统一 macOS 双架构与 Windows 更新资产生成流程',
    ],
  },
  {
    version: '1.8.6',
    date: '2026-07-18',
    items: [
      '修复企业工作区与自动 Skill 专家把 Node 运行时模块带入 Electron renderer 后导致的启动黑屏，并新增构建边界回归测试',
      '职位动态赋权仍按安全评审结果保持暂缓，不向测试成员暴露尚未接通的调岗、离职或权限提升入口',
      '保留 v1.8.5 的内部免登录测试开关：登录页只是默认屏蔽，没有删除；邀请注册链接和已有真实会话仍会连接对应企业，合成内测身份不会访问企业接口',
      '合入队友最新组织更新：成员可读取完整组织架构，运行中打开邀请链接也会先切换到对应企业服务器',
      '新增浏览器发现本机 Otto 与设置面板接入；尚未接通服务端持久会话的企业配对入口继续屏蔽',
      '默认会话继续使用全局自动执行策略；离开仅当前会话自动模式时服务端会安全回到手动授权',
    ],
  },
  {
    version: '1.8.5',
    date: '2026-07-18',
    items: [
      '内部测试版默认屏蔽企业登录页，直接进入完整工作区；本地测试身份没有管理员权限，也不会伪造服务端会话',
      '适配新企业 Microservice 的过渡阶段：启动不再依赖旧版登录与邀请码接口，同时保留完整真实认证代码供 HTTPS 协议稳定后恢复',
      '完整合入队友最新更新：PPT 原生可编辑文本与表格、智能版式和逐页主题，以及新版 Word、PDF、表格生成引擎',
      '飞书文档搜索兼容旧的顶层调用；Wiki 新建内容固定为同一轮完成“建节点、写文档”的两步流程，并补充死节点删除兜底说明',
      '新增工作日志驱动的主动洞察、会议前 10 分钟提醒和右下角 Toast；修复整点与多时段调度、跨日去重、旧消息复用、时区显示和已结束会议误报',
      '加固跨盘搜索：工作区外路径必须显式授权，同时正确支持工作区内以“..”开头的合法目录；并改进跨目录读取与命令取消反馈',
      '修复自动 Skill 把“合格模式数量”误当“单个模式出现次数”的回归，三天重复工作流会重新进入待确认区',
      '企业与身份面板补齐剪贴板链路，并如实标注本机职位邀请为 24 小时、手工粘贴且暂不跨设备同步',
      '发布继续拒绝向公网 HTTP 发送账号密码；新服务具备 HTTPS 和版本化健康检查前，仅用于免登录内部联调',
    ],
  },
  {
    version: '1.8.4',
    date: '2026-07-17',
    items: [
      '修复企业账号或手机号密码登录、会话恢复与过期退出；连接旧版企业服务器时会在发送密码前明确提示升级',
      '修复企业邀请码无法读取或生成：管理员可创建、复制和换新 7 天引入链接，失败后保留现场并支持直接重试',
      '企业身份控制台补齐成员用量、最后使用时间、表格语义和键盘操作，弹窗保存期间不会误关闭或丢失输入',
      '增强桌面客户端与企业服务器的健康握手、本机服务复用和退出收尾，连接异常会给出可执行的错误说明',
      '加固管理看板、登录限流、企业隔离、邀请码事务与用量配额，并让健康检查可核验版本和源码提交',
      '企业积分管理新增管理员充值、兑换码和审计流水，并补齐租户隔离与原子账本；本版不强制模型消费扣费',
    ],
  },
  {
    version: '1.8.3',
    date: '2026-07-14',
    items: [
      '企业成员引入改为可直接分享的公网链接：5 小时有效，换新后旧链接立即失效，并能一键打开 Otto 预填邀请码',
      '首次注册补齐企业邀请码、姓名、手机号、短信验证和密码；注册后自动保持登录，退出前增加确认',
      '企业后台按企业隔离成员、预设岗位标签并展示 Token 用量；邀请入口和成员管理统一到身份控制台',
      '附件改成清晰的横向文件卡片，显示格式与大小，长文件名和删除按钮不再挤压重叠',
      'PPT 制作与联网搜索作为内置能力随时可用，工作日志和设置入口进一步简化',
    ],
  },
  {
    version: '1.7.3',
    date: '2026-07-12',
    items: [
      'Lark CLI 复用已校验的固定版本原生缓存，热启动实测由 2.51 秒降到 0.38 秒',
      '保留首次零安装能力；首次下载完成后，后续飞书命令不再重复承担 npx 启动开销',
    ],
  },
  {
    version: '1.7.2',
    date: '2026-07-11',
    items: [
      '内部测试阶段所有身份统一使用成员自己的 API，不再进入尚未上线的企业中转站路径',
      '旧企业会话如果保存过 Otto 托管模型，会自动回退到当前个人模型',
      '未绑定个人 API 时明确引导设置，不再返回 mock 内容',
      '模型请求失败后不再留下空白 Otto 消息，错误会正确收口并显示可读原因',
      '聊天、图片生成与 token 计数增加绝对地址校验，防止 /v1/chat/stream 相对 URL 再次出现',
      '补齐 CEO、会议与六个部门共 27 个独立 Imagegen 专家头像',
    ],
  },
  {
    version: '1.7.1',
    date: '2026-07-11',
    items: [
      'Otto 工作方式改成日常对话、企业办公、工作代码等通俗场景名称，不再暴露 Codex、Cursor 等开发工具术语',
      '模型切换现在会真正应用到当前对话；修复 Codex OAuth 接入、系统提示词传递和错误自称 Gemini',
      '个人版补齐 8 位通用办公专家，并优化专家入口、图标和操作文案',
      '飞书授权二维码可直接显示，授权链接和工具实时进度会在对话中清晰呈现',
      '飞书操作不再卡在 Otto 桌面确认；同时修复空回复、引用旧消息和回复乱序',
    ],
  },
  {
    version: '1.7.0',
    date: '2026-07-11',
    items: [
      '新增个人版与企业版：个人版使用自己的 API，只保留基础 Otto、会议 Agent 和自动 Skill；企业版只使用 Otto 托管模型',
      '重复工作会先进入自动 Skill 候选区，只有用户确认后才写入个人 Skill，拒绝后不会反复推荐',
      '企业管理者可构建组织框架；Agent 目录收敛为固定 9 个基础 Agent，避免额外角色入口造成混乱',
      '固定目录包含 1 个企业工作 Agent 与 8 个通用专家；会议能力统一收敛到“会议 Agent”',
      '工作日志升级为日期日历；点击日期在主区查看日程，Otto 也能通过统一工具自主新建日程',
      '企业版新增 Skill 专区、部门/公司市场、个人/Skill 排行榜，以及可收起的企业与好友入口',
      '企业模型与积分进入设计预览：¥100 = 10,000 Credits，DeepSeek 成本预算基准为 ¥90，高端模型显示积分倍率',
    ],
  },
  {
    version: '1.6.5',
    date: '2026-07-11',
    items: [
      '修复 Windows PPT 失败后的 Marp 依赖链、命令乱码和全局 npm 安装安全问题',
      '外部文档渲染改为参数数组执行，并支持 Windows 本地代码页错误解码与安全中止',
    ],
  },
  {
    version: '1.6.4',
    date: '2026-07-11',
    items: [
      '已配置模型支持完整编辑：协议、接口地址、API Key、模型 ID、显示名、上下文窗口和启用状态均可修改',
      'API Key 留空会安全保留旧密钥；修改模型 ID 或地址会原子替换，不留下重复旧模型',
      '聊天框新增轻量语音输入：点击录音、再次点击停止，识别和可选润色后填回草稿，不自动发送',
      '新增手动、当前会话自动、所有会话自动三种授权模式；删除和高风险操作始终要求确认',
      'PPT 改为完整本地生成，不再依赖 Otto 云端地址、登录或上传，VS Code 扩展同步支持',
      '修复停止生成后工具卡片仍在处理、停止按钮无法恢复，以及本地用户权限误拦截等问题',
    ],
  },
  {
    version: '1.6.3',
    date: '2026-07-10',
    items: [
      '修复飞书首条消息错误返回 mock：每个飞书会话现在会先初始化隔离的真实 AI runtime 再处理消息',
      '飞书连接失败时改为显示真实初始化错误，不再用占位回复伪装连接成功',
      '对齐 EasyCode 的飞书会话隔离逻辑，并新增首消息与 server 端到端回归测试',
    ],
  },
  {
    version: '1.6.2',
    date: '2026-07-10',
    items: [
      '工作日志记录真实交付成果：可一键总结当前工作并保存 Markdown 报告，月历悬浮查看当天逐条明细',
      '会议结束后可主动生成会议纪要，园区报修支持飞书与短信逐级通知',
      '设置与诊断移除用量统计；暂时隐藏尚未开放的 Skill 与排行榜入口，减少空白页面',
      '修复工作日志日期、会话隔离、设置窗口 Esc 关闭及最新通知类型错误',
    ],
  },
  {
    version: '1.6.1',
    date: '2026-07-10',
    items: [
      '模型管理修复：已配置模型现在可以删除（列表内两击确认），删除当前生效模型会自动回退',
      '模型列表显示真实厂商（按接入域名识别：智谱 GLM / 阿里通义 / DeepSeek 等），不再一律显示 OpenAI',
    ],
  },
  {
    version: '1.6.0',
    date: '2026-07-10',
    items: [
      '软件更新全自动：下载完成后点「立即安装并重启」，Otto 自动完成覆盖安装并重启（mac 免拖拽 / win 静默安装）',
      '设置与诊断中心改为悬浮大窗，对话保持在底层，点遮罩即可返回',
      '工作日志升级：月历视图（有记录的日期亮点，悬浮查看当天逐条明细）+「总结当下工作」一键生成当日工作报告',
      '顶栏新增黑/白底色一键切换按钮',
      '右侧面板：「智能体」更名「专家」，「自主开发」更名「企业AI自主开发」，移除聊天区悬浮小圆钮（入口统一在面板）',
      '诊断中心下架用量统计',
    ],
  },
  {
    version: '1.5.2',
    date: '2026-07-10',
    items: [
      '偏好设置新增「外观」：跟随系统 / 浅色 / 深色三选一，立即生效并记住选择',
      '检查更新遇到网络抖动时自动重试，减少"打开发布页"兜底出现的概率',
      '园区服务入口显示完整企业品牌名（随企业配置变化）',
    ],
  },
  {
    version: '1.5.0',
    date: '2026-07-09',
    items: [
      '全新品牌 IP「Otto 小刺猬」上线：应用图标与对话头像焕新——刺猬是企业，每根刺尖连接一位员工的 Otto',
      '右侧面板新增「园区 AI 服务」入口（自主开发上方）：访客邀约 / 会议室 / 报修 / 班车 / 餐饮一键直达',
      '右侧面板新增 排行榜 / Skill 市场 / 工作日志 三个 tab；顶栏部门岗位随飞书自动同步',
      '升级后首次启动自动展示更新说明（本弹窗）',
      '移除内置浏览器 tab；修复企业面板按钮无响应问题',
    ],
  },
  {
    version: '1.4.4',
    date: '2026-07-09',
    items: [
      '右侧面板新增「园区 AI 服务」入口（自主开发上方），访客邀约 / 会议室 / 报修 / 班车 / 餐饮一键直达',
      '右侧面板新增 排行榜 / Skill 市场 / 工作日志 三个 tab',
      '顶栏显示部门与岗位，随飞书组织架构自动同步',
      '自动生成的技能会以智能体形式出现在侧栏',
      '飞书开关现在直接控制真实守护进程',
      '移除内置浏览器 tab',
      '新增本弹窗：每次升级后首次启动自动展示更新内容',
    ],
  },
];

const SEEN_KEY = 'otto:whats-new-seen';

export function WhatsNewDialog(): React.JSX.Element | null {
  const [entry, setEntry] = useState<ChangelogEntry | null>(null);
  const uid = useId();
  const titleId = `${uid}-title`;

  useEffect(() => {
    let cancelled = false;
    void window.otto
      ?.appVersion()
      .then((ver) => {
        if (cancelled || !ver) return;
        let seen: string | null = null;
        try {
          seen = localStorage.getItem(SEEN_KEY);
        } catch {
          /* localStorage 不可用则每次都弹，可接受 */
        }
        if (seen === ver) return;
        const found = CHANGELOG.find((e) => e.version === ver);
        if (found) setEntry(found);
        else {
          // 本版没写更新说明（如开发构建）：静默记录，避免每次启动都查。
          try {
            localStorage.setItem(SEEN_KEY, ver);
          } catch {
            /* ignore */
          }
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  if (!entry) return null;

  const dismiss = (): void => {
    try {
      localStorage.setItem(SEEN_KEY, entry.version);
    } catch {
      /* ignore */
    }
    setEntry(null);
  };

  return (
    <div
      className="otto-park-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) dismiss();
      }}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          dismiss();
        }
      }}
    >
      <div
        className="otto-park-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="otto-park-dialog__head">
          <span className="otto-park-dialog__headicon" aria-hidden>
            <IconSparkle size={18} />
          </span>
          <div className="otto-park-dialog__headtext">
            <h2 className="otto-park-dialog__title" id={titleId}>
              Otto 更新到 v{entry.version}
            </h2>
            <div className="otto-park-dialog__subtitle">{entry.date} · 本次更新内容</div>
          </div>
          <button
            type="button"
            className="otto-park-dialog__close"
            onClick={dismiss}
            aria-label="关闭"
          >
            <IconClose size={14} />
          </button>
        </div>
        <ul className="otto-whatsnew__list">
          {entry.items.map((item, i) => (
            <li key={i} className="otto-whatsnew__item">
              {item}
            </li>
          ))}
        </ul>
        <div className="otto-whatsnew__actions">
          <button
            type="button"
            className="otto-hub__btn otto-hub__btn--primary"
            onClick={dismiss}
            autoFocus
          >
            知道了
          </button>
        </div>
      </div>
    </div>
  );
}
