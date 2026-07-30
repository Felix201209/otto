/**
 * @license Copyright 2026 Felix SPDX-License-Identifier: Apache-2.0
 *
 * KnowledgeCapture：会话结束后自动沉淀知识条目到本地知识库。
 *
 * 在每轮 turn/chat 完成后异步运行：判断本轮是否值得捕获，
 * 提取候选条目，做脱敏 + 去重 + 相似合并后写入 LocalKnowledgeStore。
 * 高置信度（>0.8）自动写入，低置信度暂不处理（避免噪音污染）。
 * 完全异步，沉淀失败不影响主对话流。
 */

import { createHash } from 'crypto';
import {
  LocalKnowledgeStore,
  type KnowledgeEntry,
} from './localKnowledgeStore.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** 一条候选知识条目（尚未写入，需经去重/脱敏/置信度筛选）。 */
export interface KnowledgeCandidate {
  /** 自动分类 */
  category: 'preference' | 'decision' | 'solution' | 'research' | 'convention';
  /** 沉淀文本 */
  content: string;
  /** 自动标签 */
  tags: string[];
  /** 来源会话 */
  sourceSessionId: string;
  /** 来源消息 id 列表（可为空） */
  sourceMessageIds: string[];
  /** 置信度 0-1；>0.8 自动写入，否则跳过 */
  confidence: number;
  /** 内容指纹（sha256 前 16 hex，供去重） */
  fingerprint: string;
  /** 是否有真实工具结果或明确验收结果作为支撑。 */
  verified?: boolean;
  /** 对后续工作的影响强度，由捕获层给出提示，服务端会重新判定。 */
  impactScore?: number;
  /** 可解释的价值信号，不包含对话原文。 */
  significanceSignals?: string[];
}

/** 一次经过脱敏和原子化的知识观察，可供企业证据池长期聚合。 */
export interface KnowledgeObservation {
  category: KnowledgeCandidate['category'];
  content: string;
  tags: string[];
  sourceSessionId: string;
  confidence: number;
  fingerprint: string;
  verified: boolean;
  impactScore: number;
  significanceSignals: string[];
  observedAt: string;
}

/** ingestCandidates 返回值 */
export interface IngestResult {
  /** 成功写入的条目数 */
  written: number;
  /** 因去重跳过的条目数 */
  skippedDuplicate: number;
  /** 因脱敏后为空跳过的条目数 */
  skippedSanitized: number;
  /** 因置信度过低跳过的条目数 */
  skippedLowConfidence: number;
  /** 本次实际新增的脱敏条目；供组织知识库等下游精确同步，不能用 recent 猜测。 */
  entries: KnowledgeEntry[];
  /** 本轮有效观察，包括本地已存在的重复项；企业侧用它判断长期复现。 */
  observations: KnowledgeObservation[];
}

/** 精简版消息记录（用于 shouldCapture / extractCandidates 分析） */
export interface SimpleMessage {
  role: 'user' | 'assistant' | 'tool';
  text: string;
  /** 工具名（仅 role==='tool' 时有值） */
  toolName?: string;
  /** 工具调用是否成功（仅 role==='tool' 时有效） */
  toolSuccess?: boolean;
}

// ---------------------------------------------------------------------------
// Secret detection regexps（禁止自动沉淀：API Key / Password / Token / Cookie）
// ---------------------------------------------------------------------------
const SECRET_PATTERNS: RegExp[] = [
  // OpenAI / 类 OpenAI API key
  /sk-[a-zA-Z0-9]{20,}/gi,
  // Bearer token
  /Bearer\s+[a-zA-Z0-9\-_\.]{20,}/gi,
  // api_key / apikey / api-key = ...
  /api[_-]?key\s*[:=]\s*\S+/gi,
  // access_token / secret_key / password = ...
  /(?:access|secret|refresh)_?(?:token|key)\s*[:=]\s*\S+/gi,
  /password\s*[:=]\s*\S+/gi,
  // 通用 token= 模式
  /token\s*[:=]\s*[a-zA-Z0-9\-_\.]{16,}/gi,
  // Authorization: Bearer ...
  /Authorization\s*[:=]\s*Bearer\s+\S+/gi,
  // Cookie 大段（>60 字符的 key=value; 模式）
  /Cookie\s*[:=]\s*.{60,}/gi,
  // GitHub personal access token
  /ghp_[a-zA-Z0-9]{36,}/gi,
  /github_pat_[a-zA-Z0-9]{22,}/gi,
  // 通用 private key 头
  /-----BEGIN\s+(?:RSA|EC|DSA|OPENSSH)\s+PRIVATE\s+KEY-----/gi,
];

// ---------------------------------------------------------------------------
// 信号词库：用于 shouldCapture 判断本轮是否有"实质性知识产出"
// ---------------------------------------------------------------------------

/** 用户偏好信号词 */
const PREFERENCE_SIGNALS = [
  '偏好', 'prefer', '喜欢', '不喜欢', '常用', '习惯', 'always', 'never',
  '我一般', '我通常', '我应该', '我倾向于', 'keep it', '请记住', 'remember',
  '配置', '设置', '默认', '风格', '命名', '约定',
];

/** 决策信号词 */
const DECISION_SIGNALS = [
  '决定', '选择', '选定', '最终方案', '拍板', '就这个', '用这个',
  'decide', 'settle on', 'go with', 'final answer', 'use this',
  '建议', '推荐', 'recommend', '最好', '应该这样', '最佳实践',
];

/** 解决方案信号词 */
const SOLUTION_SIGNALS = [
  '解决', '修好了', '修复', '搞定', '错误原因', '根因', '排查',
  'root cause', 'fix', 'resolve', 'fix is', 'solution',
  '步骤', '修改', '调整', '配置改为', '需要改', '改为',
];

/** 调研/研究信号词 */
const RESEARCH_SIGNALS = [
  '查了', '搜索', 'find', 'found', '搜索发现', '检索',
  '文档', '官方说', '源码', '源码里',
];

/** 低价值信号词：闲聊、临时状态、模型未确认的猜测 */
const LOW_VALUE_SIGNALS = [
  '你好', 'hello', 'hi', '谢谢', 'thanks', '天气', '好玩',
  '可能', '也许', 'maybe', 'perhaps', '不确定', 'not sure',
  '暂时', '临时的', 'temporary', '测试一下', '试试',
];

const VERIFIED_RESULT_SIGNALS = [
  '已修复', '已解决', '验证通过', '测试通过', '验收通过', '已恢复', '已上线',
  '生效', '结果为', '确认有效', 'fixed', 'resolved', 'verified', 'tests passed',
];

const HIGH_IMPACT_SIGNALS = [
  '最终决定', '正式采用', '统一规定', '必须', '禁止', '制度', '标准流程',
  '重大', '宕机', '事故', '数据丢失', '安全', '合规', '法律', '合同', '客户投诉',
  '金额', '成本', '收入', '损失', 'sla', '生产环境',
];

// ---------------------------------------------------------------------------
// KnowledgeCapture 类
// ---------------------------------------------------------------------------

export class KnowledgeCapture {
  private store: LocalKnowledgeStore;

  constructor(store?: LocalKnowledgeStore) {
    this.store = store ?? new LocalKnowledgeStore();
  }

  // ── 1. shouldCapture ────────────────────────────────────────────────

  /**
   * 判断本轮对话是否值得自动沉淀知识。
   *
   * 规则：
   *  - 总消息数必须 > 3（太少的内容只是开场寒暄）
   *  - 有明确决策、偏好表达、解决方案描述、调研结论 → true
   *  - 只有闲聊 / 没有真实成功结果且对话太短（<3 轮交换）→ false
   */
  shouldCapture(messages: SimpleMessage[]): boolean {
    if (messages.length === 0) return false;

    // 过滤出实质性消息（tool 结果只算成功的；user/assistant 纯文本）
    const substantive = messages.filter(
      (m) =>
        (m.role === 'user' || m.role === 'assistant') &&
        m.text.trim().length > 10,
    );
    const successfulTools = messages.filter(
      (m) => m.role === 'tool' && m.toolSuccess === true,
    ).length;

    // 短对话只在有真实成功工具结果且用户、助手都给出实质内容时沉淀。
    if (messages.length <= 3) {
      const shortText = messages.map((message) => message.text).join('\n').toLowerCase();
      const hasVerifiedConclusion = VERIFIED_RESULT_SIGNALS.some((signal) =>
        shortText.includes(signal.toLowerCase()));
      const hasHighImpactConclusion = HIGH_IMPACT_SIGNALS.some((signal) =>
        shortText.includes(signal.toLowerCase()));
      return substantive.length >= 2 && (
        successfulTools >= 1 || (hasVerifiedConclusion && hasHighImpactConclusion)
      );
    }

    if (substantive.length < 3 && successfulTools === 0) return false;

    const fullText = messages.map((m) => m.text).join('\n');

    // 低价值信号：闲聊为主
    const lowHits = LOW_VALUE_SIGNALS.filter((s) =>
      fullText.toLowerCase().includes(s.toLowerCase()),
    ).length;
    if (lowHits >= 3 && substantive.length < 8) {
      return false;
    }

    // 正信号检测
    const signalGroups = [
      PREFERENCE_SIGNALS,
      DECISION_SIGNALS,
      SOLUTION_SIGNALS,
      RESEARCH_SIGNALS,
    ];
    let totalHits = 0;
    const hitGroups = new Set<string>();
    for (const group of signalGroups) {
      const hits = group.filter((s) =>
        fullText.toLowerCase().includes(s.toLowerCase()),
      ).length;
      if (hits > 0) {
        totalHits += hits;
        hitGroups.add(group[0]); // use first signal as group marker
      }
    }

    // 至少命中 2 类信号，或同一类命中 ≥3 次
    if (hitGroups.size >= 2 || totalHits >= 3) return true;

    // 补充：有成功工具结果（写了文件 / 修了代码）
    if (successfulTools >= 1) return true;

    return false;
  }

  // ── 2. extractCandidates ────────────────────────────────────────────

  /**
   * 从对话历史中提取候选知识条目。
   * 实现策略：对每轮 assistant 回复做启发式分析，提取可沉淀的知识片段。
   */
  extractCandidates(
    messages: SimpleMessage[],
    sessionId: string,
  ): KnowledgeCandidate[] {
    const candidates: KnowledgeCandidate[] = [];
    const hasSuccessfulTool = messages.some(
      (message) => message.role === 'tool' && message.toolSuccess === true,
    );

    // 收集所有 assistant 回复（整段）
    const assistantBlocks: { text: string; index: number }[] = [];
    for (let i = 0; i < messages.length; i++) {
      const m = messages[i];
      if (m.role === 'assistant' && m.text.trim().length > 20) {
        assistantBlocks.push({ text: m.text, index: i });
      }
    }

    for (const block of assistantBlocks) {
      const text = block.text;
      const extracted = this.tryExtract(text, sessionId, hasSuccessfulTool);
      for (const entry of extracted) {
        const verifiedByLanguage = VERIFIED_RESULT_SIGNALS.some((signal) =>
          text.toLowerCase().includes(signal.toLowerCase()));
        const highImpactHits = HIGH_IMPACT_SIGNALS.filter((signal) =>
          text.toLowerCase().includes(signal.toLowerCase()));
        const verified = hasSuccessfulTool || verifiedByLanguage;
        const impactScore = Math.min(
          1,
          0.45 + (verified ? 0.2 : 0) + Math.min(0.3, highImpactHits.length * 0.1),
        );
        candidates.push({
          ...entry,
          confidence: verified ? Math.max(entry.confidence, 0.85) : entry.confidence,
          verified,
          impactScore,
          significanceSignals: [
            ...(hasSuccessfulTool ? ['successful_tool_result'] : []),
            ...(verifiedByLanguage ? ['verified_result'] : []),
            ...highImpactHits.slice(0, 4).map((signal) => `impact:${signal}`),
          ],
        });
      }
    }

    // 从 user 消息提取偏好
    for (const m of messages) {
      if (m.role === 'user') {
        const pref = this.tryExtractPreference(m.text, sessionId);
        if (pref) candidates.push(pref);
      }
    }

    return candidates;
  }

  /** 从 assistant 文本提取候选 */
  private tryExtract(
    text: string,
    sessionId: string,
    corroboratedByTool = false,
  ): KnowledgeCandidate[] {
    const results: KnowledgeCandidate[] = [];
    const lowerText = text.toLowerCase();
    const isVerifiedHighImpact = VERIFIED_RESULT_SIGNALS.some((signal) =>
      lowerText.includes(signal.toLowerCase()))
      && HIGH_IMPACT_SIGNALS.some((signal) => lowerText.includes(signal.toLowerCase()));

    // 检测解决方案模式："问题是" / "解决" / "root cause" / 步骤列表
    if (
      /问题|原因|根因|root cause|排查|debug/i.test(text) &&
      (text.length > 80
        || /\d\.\s/.test(text)
        || (corroboratedByTool && text.length > 30)
        || isVerifiedHighImpact)
    ) {
      const content = this.buildKnowledgeAtom(text, [
        /问题|原因|根因|root cause|排查|debug/i,
        /解决|修复|调整|改为|fix|resolve/i,
        /验证|测试|验收|恢复|生效|通过|verified|passed/i,
      ]);
      if (content.length >= 20) {
        results.push({
          category: 'solution',
          content,
          tags: this.extractTags(text),
          sourceSessionId: sessionId,
          sourceMessageIds: [],
          confidence: 0.75,
          fingerprint: this.fingerprint(content),
        });
        return results;
      }
    }

    // 检测决策/推荐模式
    if (/建议|推荐|推荐使用|recommend|最好用|best practice/i.test(text)) {
      const sentences = this.splitSentences(text);
      for (const s of sentences) {
        if (
          s.length > 20 &&
          /建议|推荐|应该|should|recommend|最好|最佳/i.test(s)
        ) {
          const content = this.buildKnowledgeAtom(s, [
            /决定|建议|推荐|应该|should|recommend|最好|最佳/i,
            /适用|条件|前提|仅当|除非/i,
          ]);
          if (content.length >= 15) {
            results.push({
              category: 'decision',
              content,
              tags: this.extractTags(s),
              sourceSessionId: sessionId,
              sourceMessageIds: [],
              confidence: 0.7,
              fingerprint: this.fingerprint(content),
            });
            if (results.length >= 3) break;
          }
        }
      }
    }

    // 检测调研结论
    if (/发现|根据|根据文档|源码里|官方说明|查阅|查了/i.test(text)) {
      const sentences = this.splitSentences(text);
      for (const s of sentences) {
        if (s.length > 15 && /发现|根据|按照|文档|官方|规范/i.test(s)) {
          const content = this.buildKnowledgeAtom(s, [
            /发现|根据|按照|文档|官方|规范/i,
          ]);
          if (content.length >= 15) {
            results.push({
              category: 'research',
              content,
              tags: this.extractTags(s),
              sourceSessionId: sessionId,
              sourceMessageIds: [],
              confidence: 0.65,
              fingerprint: this.fingerprint(content),
            });
            if (results.length >= 2) break;
          }
        }
      }
    }

    return results;
  }

  /**
   * 把回答压缩为可复用的知识原子，而不是保存整段会话。
   * 最多保留结论、条件、验证结果三类句子，并移除大段代码和说话人标记。
   */
  private buildKnowledgeAtom(text: string, priorities: RegExp[]): string {
    const withoutCodeBlocks = text.replace(/```[\s\S]*?```/gu, ' [代码细节已省略] ');
    const segments = withoutCodeBlocks
      .split(/\r?\n+|(?<=[。！？!?；;])/u)
      .map((segment) => segment
        .replace(/^\s*(?:用户|助手|assistant|user)\s*[:：]\s*/iu, '')
        .replace(/^\s*[#>*-]+\s*/u, '')
        .replace(/\s+/gu, ' ')
        .trim())
      .filter((segment) => segment.length >= 12);
    const selected: string[] = [];
    for (const priority of priorities) {
      const match = segments.find((segment) => priority.test(segment));
      if (match && !selected.includes(match)) selected.push(match);
    }
    for (const segment of segments) {
      if (selected.length >= 3) break;
      if (!selected.includes(segment)) selected.push(segment);
    }
    return this.sanitizeSecrets(selected.join('\n').slice(0, 700));
  }

  /** 从 user 消息提取偏好 */
  private tryExtractPreference(
    text: string,
    sessionId: string,
  ): KnowledgeCandidate | null {
    const lowerT = text.toLowerCase();
    const hasPreferenceSignal = PREFERENCE_SIGNALS.some((s) =>
      lowerT.includes(s.toLowerCase()),
    );
    if (!hasPreferenceSignal || text.length < 15) return null;

    // 排除："你知道" / "你能" / "会吗" 等能力问询
    if (/你能|你会|你知道|can you|do you know/i.test(text) && text.length < 100)
      return null;

    const content = this.sanitizeSecrets(text);
    if (content.length < 10) return null;

    return {
      category: 'preference',
      content,
      tags: this.extractTags(text),
      sourceSessionId: sessionId,
      sourceMessageIds: [],
      confidence: 0.85,
      fingerprint: this.fingerprint(content),
    };
  }

  /** 简单按句号/换行/中文句号分割句子 */
  private splitSentences(text: string): string[] {
    return text
      .split(/[。\n.!?;；]/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  }

  /** 从文本提取关键词作标签 */
  private extractTags(text: string): string[] {
    const tags: string[] = [];
    const lower = text.toLowerCase();

    // 技术栈标签
    const techPatterns: [RegExp, string][] = [
      [/react/i, 'react'],
      [/vue/i, 'vue'],
      [/angular/i, 'angular'],
      [/next\.?js/i, 'nextjs'],
      [/node\.?js/i, 'nodejs'],
      [/typescript/i, 'typescript'],
      [/javascript/i, 'javascript'],
      [/python/i, 'python'],
      [/golang|go\s+lang/i, 'go'],
      [/rust/i, 'rust'],
      [/docker/i, 'docker'],
      [/kubernetes|k8s/i, 'kubernetes'],
      [/git/i, 'git'],
      [/linux/i, 'linux'],
      [/macos|mac\s+os/i, 'macos'],
      [/vscode/i, 'vscode'],
      [/feishu|飞书|lark/i, 'feishu'],
      [/API/i, 'api'],
      [/database|数据库|sql/i, 'database'],
      [/redis/i, 'redis'],
      [/mongodb/i, 'mongodb'],
      [/postgres/i, 'postgresql'],
      [/graphql/i, 'graphql'],
      [/tailwind/i, 'tailwind'],
      [/prisma/i, 'prisma'],
      [/electron/i, 'electron'],
    ];

    for (const [pattern, tag] of techPatterns) {
      if (pattern.test(lower) && !tags.includes(tag)) {
        tags.push(tag);
      }
    }

    // 通用概念标签
    const conceptPatterns: [RegExp, string][] = [
      [/auth|登录|鉴权|权限/i, 'auth'],
      [/deploy|部署|上线/i, 'deploy'],
      [/debug|调试|排查|报错|错误/i, 'debug'],
      [/config|配置|设置/i, 'config'],
      [/test|测试|单测/i, 'testing'],
      [/performance|性能|优化|加速/i, 'performance'],
      [/security|安全|加密/i, 'security'],
      [/ci|cd|pipeline|流水线/i, 'cicd'],
      [/monitoring|监控|日志|log/i, 'monitoring'],
    ];

    for (const [pattern, tag] of conceptPatterns) {
      if (pattern.test(lower) && !tags.includes(tag)) {
        tags.push(tag);
      }
    }

    return tags.slice(0, 5);
  }

  // ── 3. ingestCandidates ─────────────────────────────────────────────

  /**
   * 处理候选条目：高置信度自动写入，低置信度跳过。
   * 写入前对每条做脱敏 + 去重检查。
   */
  async ingestCandidates(
    candidates: KnowledgeCandidate[],
  ): Promise<IngestResult> {
    const result: IngestResult = {
      written: 0,
      skippedDuplicate: 0,
      skippedSanitized: 0,
      skippedLowConfidence: 0,
      entries: [],
      observations: [],
    };

    for (const candidate of candidates) {
      if (candidate.confidence < 0.8) {
        result.skippedLowConfidence++;
        continue;
      }

      // 脱敏
      const sanitizedContent = this.sanitizeSecrets(candidate.content);
      if (sanitizedContent.length < 10) {
        result.skippedSanitized++;
        continue;
      }

      const fp = this.fingerprint(sanitizedContent);
      result.observations.push({
        category: candidate.category,
        content: sanitizedContent,
        tags: candidate.tags.slice(0, 8),
        sourceSessionId: candidate.sourceSessionId,
        confidence: candidate.confidence,
        fingerprint: fp,
        verified: candidate.verified === true,
        impactScore: Math.min(1, Math.max(0, candidate.impactScore ?? 0.5)),
        significanceSignals: (candidate.significanceSignals ?? []).slice(0, 8),
        observedAt: new Date().toISOString(),
      });

      // 去重
      try {
        const existing = await this.store.findByFingerprint(fp);
        if (existing) {
          result.skippedDuplicate++;
          continue;
        }

        const entry = await this.store.upsert(
          candidate.category,
          sanitizedContent,
          candidate.tags,
          fp,
          candidate.confidence,
        );
        result.written++;
        result.entries.push(entry);
      } catch {
        // 写入失败静默忽略，不阻塞
      }
    }

    // 写入后做一次相似条目合并
    try {
      await this.store.mergeSimilar(0.85);
    } catch {
      // 合并失败忽略
    }

    return result;
  }

  // ── 4. 密钥脱敏 ──────────────────────────────────────────────────────

  /**
   * 检测并脱敏密钥/Token/密码等敏感内容。
   * 返回脱敏后的文本；若脱敏后为空，说明整段都是密钥。
   */
  sanitizeSecrets(content: string): string {
    let result = content;
    for (const pattern of SECRET_PATTERNS) {
      result = result.replace(pattern, (match) => {
        if (match.length <= 4) return match;
        return match.slice(0, 2) + '***' + match.slice(-2);
      });
    }

    // 额外检测 key=value 形式的敏感行并整行脱敏
    const lines = result.split('\n');
    const sensitiveLinePattern = /(?:api[_-]?key|secret|token|password|authorization)\s*[:=]/i;
    result = lines
      .map((line) => {
        if (sensitiveLinePattern.test(line) && line.length > 10) {
          return line.replace(/[:=]\s*\S+/, '=***REDACTED***');
        }
        return line;
      })
      .join('\n')
      .trim();

    return result;
  }

  // ── 5. 内容指纹 ──────────────────────────────────────────────────────

  /**
   * 生成内容指纹：sha256 前 16 hex。
   *
   * 对内容做稳健归一化后再哈希：
   *   1. 转小写
   *   2. 所有空白字符（空格、换行、制表符等）折叠为单个空格
   *   3. 去除首尾空白
   *
   * 这样 "Hello   World" 和 "hello
world" 会生成相同的指纹，
   * 避免因格式化差异导致去重失效。
   */
  fingerprint(content: string): string {
    const normalized = content
      .toLowerCase()
      .replace(/\s+/g, ' ')
      .trim();
    return createHash('sha256')
      .update(normalized)
      .digest('hex')
      .slice(0, 16);
  }
}
