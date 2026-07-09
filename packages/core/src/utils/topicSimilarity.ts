/**
 * @license
 * Copyright 2026 Felix
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * 话题相似度判定 —— 用于"识别新话题创建新任务 / 识别同一话题合并任务"。
 *
 * 算法：字符级 bigram（2-gram）Jaccard 相似度。
 *   - 选它而非按空格分词的原因：中文任务标题/目标描述通常没有空格分隔
 *     （比如"合同审查流程优化" vs "优化合同审查的流程"），按空格分词对中文
 *     基本失效；bigram 是字符级操作，中英文/混合文本都能用同一套逻辑处理，
 *     不需要额外的分词器依赖。
 *   - Jaccard = |交集| / |并集|，直观、无需训练、计算成本 O(n)，适合"新建
 *     项目/任务前查一下是否已有相似任务"这种低延迟场景。
 *
 * 局限（如实说明，不夸大）：
 *   - 这是字面相似度，不是语义相似度——"猫追老鼠"和"老鼠追猫"会被判定为
 *     高度相似（bigram 重叠很高），尽管语义相反。对"同一件事换了个说法"的
 *     场景（真实使用场景的大多数）有效，但不能识别真正的语义等价/对立。
 *   - 不做实体消歧、不做同义词归并。是一个轻量、可解释、无外部依赖的启发式，
 *     不是 embedding/LLM 语义匹配的替代品。
 */

/** 归一化：转小写、把连续空白折叠成单个空格，去首尾空白。 */
function normalize(text: string): string {
  return text.toLowerCase().trim().replace(/\s+/g, ' ');
}

/** 生成字符级 bigram 集合。长度 < 2 的文本退化为以整串本身作单一"gram"。 */
function bigrams(text: string): Set<string> {
  const s = normalize(text);
  if (s.length < 2) return new Set(s ? [s] : []);
  const grams = new Set<string>();
  for (let i = 0; i < s.length - 1; i++) {
    grams.add(s.slice(i, i + 2));
  }
  return grams;
}

/**
 * 计算两段文本的 Jaccard 相似度，范围 [0, 1]。两者都为空文本时返回 0
 * （视为"无法判定相似"，而非"完全相同"，避免空标题误判为处处匹配）。
 */
export function textSimilarity(a: string, b: string): number {
  const setA = bigrams(a);
  const setB = bigrams(b);
  if (setA.size === 0 && setB.size === 0) return 0;
  if (setA.size === 0 || setB.size === 0) return 0;

  let intersection = 0;
  for (const g of setA) {
    if (setB.has(g)) intersection++;
  }
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/** 一个"候选话题/任务"的最小信息，用于话题匹配。 */
export interface TopicCandidate {
  id: string;
  /** 用于比较的文本：通常是 title + goal/description 拼接。 */
  text: string;
}

/** 匹配结果：命中的候选 + 相似度分数。 */
export interface TopicMatch {
  id: string;
  score: number;
}

/**
 * 默认相似度阈值：达到或超过视为"同一话题"，应合并而非新建。
 * 0.5 是经验值——两段完全不相关的中文短句 bigram 重叠通常远低于此，
 * 而"同一件事换了个说法"的重写通常能到 0.6+。可由调用方按场景覆盖。
 */
export const DEFAULT_MERGE_THRESHOLD = 0.5;

/**
 * 在候选集合里找与 `text` 最相似的一个，且相似度达到阈值。
 * 找不到满足阈值的候选则返回 null（意味着"这是一个新话题，应新建"）。
 */
export function findMostSimilarTopic(
  text: string,
  candidates: TopicCandidate[],
  threshold: number = DEFAULT_MERGE_THRESHOLD,
): TopicMatch | null {
  let best: TopicMatch | null = null;
  for (const c of candidates) {
    const score = textSimilarity(text, c.text);
    if (score >= threshold && (!best || score > best.score)) {
      best = { id: c.id, score };
    }
  }
  return best;
}
