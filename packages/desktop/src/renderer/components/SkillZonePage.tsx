/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  EnterpriseSkillLeaderboard,
  EnterpriseSkillMarketItem,
  EnterpriseSkillSort,
  EnterpriseSkillVisibility,
  LocalSkillShareCandidate,
} from '../../preload/index.js';
import { IconCheck, IconChevron, IconPackage, IconRegenerate } from './icons.js';

type Section = 'market' | 'mine' | 'ranking' | 'review';
type MarketScope = 'department' | 'company';

interface SkillZonePageProps {
  onBack: () => void;
  accountId: string;
  isAdmin: boolean;
}

const EMPTY_LEADERBOARD: EnterpriseSkillLeaderboard = {
  skills: [],
  contributors: [],
  generatedAt: '',
};

function skillStatusLabel(status: EnterpriseSkillMarketItem['status']): string {
  if (status === 'pending_review') return '待审核';
  if (status === 'archived') return '已停用';
  return '已上架';
}

function visibilityLabel(visibility: EnterpriseSkillVisibility): string {
  return visibility === 'company' ? '全公司' : '本部门';
}

function formatCount(value: number): string {
  return new Intl.NumberFormat('zh-CN', { notation: value >= 10_000 ? 'compact' : 'standard' }).format(value);
}

function SkillFacts({ skill }: { skill: EnterpriseSkillMarketItem }): React.JSX.Element {
  return (
    <dl className="otto-skillzone__facts">
      <div><dt>安装</dt><dd>{formatCount(skill.installCount)}</dd></div>
      <div><dt>使用</dt><dd>{formatCount(skill.usageCount)}</dd></div>
      <div><dt>评分</dt><dd>{skill.ratingCount > 0 ? `${skill.rating.toFixed(1)} / 5` : '暂无'}</dd></div>
      <div><dt>版本</dt><dd>v{skill.version}</dd></div>
    </dl>
  );
}

function EmptyState({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <div className="otto-skillzone__empty">{children}</div>;
}

export function SkillZonePage({ onBack, accountId, isAdmin }: SkillZonePageProps): React.JSX.Element {
  const [section, setSection] = useState<Section>('market');
  const [marketScope, setMarketScope] = useState<MarketScope>('department');
  const [sort, setSort] = useState<EnterpriseSkillSort>('recommended');
  const [query, setQuery] = useState('');
  const [submittedQuery, setSubmittedQuery] = useState('');
  const [skills, setSkills] = useState<EnterpriseSkillMarketItem[]>([]);
  const [localSkills, setLocalSkills] = useState<LocalSkillShareCandidate[]>([]);
  const [leaderboard, setLeaderboard] = useState<EnterpriseSkillLeaderboard>(EMPTY_LEADERBOARD);
  const [rankingMode, setRankingMode] = useState<'skills' | 'contributors'>('skills');
  const [submitVisibility, setSubmitVisibility] = useState<Record<string, EnterpriseSkillVisibility>>({});
  const [ratingDraft, setRatingDraft] = useState<Record<string, number>>({});
  const [loading, setLoading] = useState(false);
  const [actionId, setActionId] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [revision, setRevision] = useState(0);
  const loadRequest = useRef(0);

  const load = useCallback(async (): Promise<void> => {
    const request = loadRequest.current + 1;
    loadRequest.current = request;
    setLoading(true);
    setError('');
    try {
      if (section === 'ranking') {
        const result = await window.otto.enterpriseSkillLeaderboard();
        if (loadRequest.current === request) setLeaderboard(result);
        return;
      }
      if (section === 'mine') {
        const [local, shared] = await Promise.all([
          window.otto.enterpriseSkillLocalList(),
          window.otto.enterpriseSkillList({ scope: 'mine', sort: 'newest' }),
        ]);
        if (loadRequest.current !== request) return;
        setLocalSkills(local);
        setSkills(shared);
        return;
      }
      if (section === 'review') {
        const result = await window.otto.enterpriseSkillList({ scope: 'review', sort: 'newest' });
        if (loadRequest.current === request) setSkills(result);
        return;
      }
      const result = await window.otto.enterpriseSkillList({
        scope: marketScope,
        query: submittedQuery || undefined,
        sort,
      });
      if (loadRequest.current === request) setSkills(result);
    } catch (loadError) {
      if (loadRequest.current === request) {
        setError(loadError instanceof Error ? loadError.message : String(loadError));
      }
    } finally {
      if (loadRequest.current === request) setLoading(false);
    }
  }, [marketScope, section, sort, submittedQuery]);

  useEffect(() => {
    void revision;
    void load();
  }, [load, revision]);

  const sharedByLocalName = useMemo(() => {
    const result = new Map<string, EnterpriseSkillMarketItem>();
    for (const skill of skills) result.set(skill.name, skill);
    return result;
  }, [skills]);

  const runAction = async (id: string, action: () => Promise<string>): Promise<void> => {
    setActionId(id);
    setError('');
    setNotice('');
    try {
      setNotice(await action());
      setRevision((value) => value + 1);
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : String(actionError));
    } finally {
      setActionId(null);
    }
  };

  const install = (skill: EnterpriseSkillMarketItem): void => {
    void runAction(skill.id, async () => {
      const result = await window.otto.enterpriseSkillInstall(skill.id);
      return `${skill.name} v${result.skill.version} 已安装`;
    });
  };

  const rate = (skill: EnterpriseSkillMarketItem): void => {
    const score = ratingDraft[skill.id] ?? 5;
    void runAction(skill.id, async () => {
      await window.otto.enterpriseSkillRate(skill.id, score);
      return `已提交 ${score} 分评价`;
    });
  };

  const submit = (skill: LocalSkillShareCandidate): void => {
    const visibility = submitVisibility[skill.name] ?? 'department';
    void runAction(`local:${skill.name}`, async () => {
      const result = await window.otto.enterpriseSkillSubmit({
        localSkillName: skill.name,
        visibility,
      });
      return result.outcome === 'exists' ? '相同内容已提交，无需重复投稿' : '已提交审核';
    });
  };

  const review = (
    skill: EnterpriseSkillMarketItem,
    action: 'approve' | 'archive',
    visibility?: EnterpriseSkillVisibility,
  ): void => {
    void runAction(skill.id, async () => {
      await window.otto.enterpriseSkillReview(skill.id, action, visibility);
      return action === 'approve' ? 'Skill 已通过审核并上架' : 'Skill 已拒绝并归档';
    });
  };

  const renderMarket = (): React.JSX.Element => (
    <>
      <form
        className="otto-skillzone__toolbar"
        onSubmit={(event) => {
          event.preventDefault();
          setSubmittedQuery(query.trim());
        }}
      >
        <div className="otto-skillzone__segmented" role="group" aria-label="市场范围">
          <button type="button" className={marketScope === 'department' ? 'is-active' : ''} onClick={() => setMarketScope('department')}>本部门</button>
          <button type="button" className={marketScope === 'company' ? 'is-active' : ''} onClick={() => setMarketScope('company')}>全公司</button>
        </div>
        <label className="otto-skillzone__search">
          <span className="sr-only">搜索 Skill</span>
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索 Skill、作者或部门" />
        </label>
        <select aria-label="排序方式" value={sort} onChange={(event) => setSort(event.target.value as EnterpriseSkillSort)}>
          <option value="recommended">综合推荐</option>
          <option value="rating">评分最高</option>
          <option value="installs">安装最多</option>
          <option value="usage">使用最多</option>
          <option value="newest">最新上架</option>
        </select>
        <button type="submit" className="otto-skillzone__command">搜索</button>
        <button type="button" className="otto-skillzone__icon-btn" title="刷新" aria-label="刷新" onClick={() => setRevision((value) => value + 1)}>
          <IconRegenerate size={16} />
        </button>
      </form>
      {loading ? <EmptyState>正在加载 Skill…</EmptyState> : skills.length === 0 ? <EmptyState>没有符合条件的 Skill</EmptyState> : (
        <div className="otto-skillzone__grid">
          {skills.map((skill) => {
            const installed = skill.installedVersion !== null && skill.installedVersion >= skill.version;
            const canRate = skill.installedVersion !== null && skill.authorAccountId !== accountId;
            return (
              <article className="otto-skillzone__card" key={skill.id}>
                <div className="otto-skillzone__card-head">
                  <div>
                    <h2>{skill.name}</h2>
                    <div className="otto-skillzone__byline">{skill.authorName} · {skill.department || '未设置部门'}</div>
                  </div>
                  <span className="otto-skillzone__scope">{visibilityLabel(skill.visibility)}</span>
                </div>
                <p>{skill.description}</p>
                <SkillFacts skill={skill} />
                <div className="otto-skillzone__card-actions">
                  <button type="button" disabled={installed || actionId === skill.id} onClick={() => install(skill)}>
                    {installed ? <IconCheck size={14} /> : <IconPackage size={14} />}
                    {installed ? '已安装' : skill.installedVersion === null ? '安装' : '更新'}
                  </button>
                  {canRate ? (
                    <div className="otto-skillzone__rating">
                      <select
                        aria-label={`评价 ${skill.name}`}
                        value={ratingDraft[skill.id] ?? 5}
                        onChange={(event) => setRatingDraft((current) => ({ ...current, [skill.id]: Number(event.target.value) }))}
                      >
                        {[5, 4, 3, 2, 1].map((score) => <option value={score} key={score}>{score} 分</option>)}
                      </select>
                      <button type="button" disabled={actionId === skill.id} onClick={() => rate(skill)}>评价</button>
                    </div>
                  ) : null}
                </div>
              </article>
            );
          })}
        </div>
      )}
    </>
  );

  const renderMine = (): React.JSX.Element => (
    <div className="otto-skillzone__mine-layout">
      <section className="otto-skillzone__panel" aria-labelledby="local-skills-heading">
        <div className="otto-skillzone__panel-head"><h2 id="local-skills-heading">本机 Skill</h2><span>{localSkills.length}</span></div>
        {loading ? <EmptyState>正在读取本机 Skill…</EmptyState> : localSkills.length === 0 ? <EmptyState>本机暂无可投稿 Skill</EmptyState> : (
          <div className="otto-skillzone__rows">
            {localSkills.map((skill) => {
              const shared = sharedByLocalName.get(skill.name);
              return (
                <div className="otto-skillzone__local-row" key={skill.name}>
                  <div><strong>{skill.name}</strong><span>{skill.kind === 'auto' ? '自动生成' : '个人创建'}</span><p>{skill.description}</p></div>
                  <div className="otto-skillzone__submit-controls">
                    <select
                      aria-label={`${skill.name} 分享范围`}
                      value={submitVisibility[skill.name] ?? 'department'}
                      disabled={Boolean(shared)}
                      onChange={(event) => setSubmitVisibility((current) => ({
                        ...current,
                        [skill.name]: event.target.value as EnterpriseSkillVisibility,
                      }))}
                    >
                      <option value="department">本部门</option>
                      <option value="company">全公司</option>
                    </select>
                    <button type="button" disabled={Boolean(shared) || actionId === `local:${skill.name}`} onClick={() => submit(skill)}>
                      {shared ? skillStatusLabel(shared.status) : '提交审核'}
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>
      <section className="otto-skillzone__panel" aria-labelledby="shared-skills-heading">
        <div className="otto-skillzone__panel-head"><h2 id="shared-skills-heading">我的投稿</h2><span>{skills.length}</span></div>
        {skills.length === 0 ? <EmptyState>暂无投稿记录</EmptyState> : (
          <div className="otto-skillzone__rows">
            {skills.map((skill) => (
              <div className="otto-skillzone__shared-row" key={skill.id}>
                <div><strong>{skill.name}</strong><span>{visibilityLabel(skill.visibility)}</span></div>
                <span className={`otto-skillzone__status is-${skill.status}`}>{skillStatusLabel(skill.status)}</span>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );

  const renderRanking = (): React.JSX.Element => (
    <>
      <div className="otto-skillzone__toolbar otto-skillzone__toolbar--ranking">
        <div className="otto-skillzone__segmented" role="group" aria-label="排行榜类型">
          <button type="button" className={rankingMode === 'skills' ? 'is-active' : ''} onClick={() => setRankingMode('skills')}>Skill 榜</button>
          <button type="button" className={rankingMode === 'contributors' ? 'is-active' : ''} onClick={() => setRankingMode('contributors')}>贡献榜</button>
        </div>
        <button type="button" className="otto-skillzone__icon-btn" title="刷新" aria-label="刷新排行榜" onClick={() => setRevision((value) => value + 1)}>
          <IconRegenerate size={16} />
        </button>
      </div>
      {loading ? <EmptyState>正在计算排行榜…</EmptyState> : rankingMode === 'skills' ? (
        leaderboard.skills.length === 0 ? <EmptyState>还没有可排名的 Skill</EmptyState> : (
          <ol className="otto-skillzone__leaderboard">
            {leaderboard.skills.map((skill) => (
              <li key={skill.id}>
                <span className="otto-skillzone__rank">{skill.rank}</span>
                <div className="otto-skillzone__rank-main"><strong>{skill.name}</strong><span>{skill.authorName} · {skill.department || '未设置部门'}</span></div>
                <div><strong>{skill.score.toFixed(1)}</strong><span>综合分</span></div>
                <div><strong>{skill.ratingCount ? skill.rating.toFixed(1) : '—'}</strong><span>评分</span></div>
                <div><strong>{formatCount(skill.installCount)}</strong><span>安装</span></div>
                <div><strong>{Math.round(skill.successRate * 100)}%</strong><span>成功率</span></div>
              </li>
            ))}
          </ol>
        )
      ) : leaderboard.contributors.length === 0 ? <EmptyState>还没有可排名的贡献者</EmptyState> : (
        <ol className="otto-skillzone__leaderboard">
          {leaderboard.contributors.map((contributor) => (
            <li key={`${contributor.accountId || contributor.name}:${contributor.rank}`}>
              <span className="otto-skillzone__rank">{contributor.rank}</span>
              <div className="otto-skillzone__rank-main"><strong>{contributor.name}</strong><span>{contributor.skillCount} 个上架 Skill</span></div>
              <div><strong>{contributor.score.toFixed(1)}</strong><span>贡献分</span></div>
              <div><strong>{formatCount(contributor.installCount)}</strong><span>安装</span></div>
              <div><strong>{formatCount(contributor.usageCount)}</strong><span>使用</span></div>
            </li>
          ))}
        </ol>
      )}
    </>
  );

  const renderReview = (): React.JSX.Element => loading ? <EmptyState>正在读取审核队列…</EmptyState> : skills.length === 0 ? (
    <EmptyState>审核队列为空</EmptyState>
  ) : (
    <div className="otto-skillzone__review-list">
      {skills.map((skill) => (
        <article key={skill.id}>
          <div><h2>{skill.name}</h2><span>{skill.authorName} · {skill.department || '未设置部门'}</span><p>{skill.description}</p></div>
          <div className="otto-skillzone__review-actions">
            <button type="button" disabled={actionId === skill.id} onClick={() => review(skill, 'approve', 'department')}>部门上架</button>
            <button type="button" disabled={actionId === skill.id} onClick={() => review(skill, 'approve', 'company')}>公司上架</button>
            <button type="button" className="is-danger" disabled={actionId === skill.id} onClick={() => review(skill, 'archive')}>拒绝</button>
          </div>
        </article>
      ))}
    </div>
  );

  return (
    <section className="otto-skillzone" aria-label="Skill 专区">
      <header className="otto-skillzone__head">
        <div><div className="otto-skillzone__eyebrow">Enterprise Skills</div><h1>Skill 专区</h1></div>
        <button type="button" className="otto-hub__btn" onClick={onBack}><IconChevron size={13} /> 返回对话</button>
      </header>
      <nav className="otto-skillzone__primary-tabs" aria-label="Skill 专区导航">
        <button type="button" className={section === 'market' ? 'is-active' : ''} onClick={() => setSection('market')}>市场</button>
        <button type="button" className={section === 'mine' ? 'is-active' : ''} onClick={() => setSection('mine')}>我的 Skill</button>
        <button type="button" className={section === 'ranking' ? 'is-active' : ''} onClick={() => setSection('ranking')}>排行榜</button>
        {isAdmin ? <button type="button" className={section === 'review' ? 'is-active' : ''} onClick={() => setSection('review')}>审核</button> : null}
      </nav>
      <div className="otto-skillzone__content">
        {error ? <div className="otto-skillzone__message is-error" role="alert">{error}</div> : null}
        {notice ? <div className="otto-skillzone__message is-success" role="status">{notice}</div> : null}
        {section === 'market' ? renderMarket() : null}
        {section === 'mine' ? renderMine() : null}
        {section === 'ranking' ? renderRanking() : null}
        {section === 'review' ? renderReview() : null}
      </div>
    </section>
  );
}
