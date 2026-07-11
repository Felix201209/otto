/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useState } from 'react';
import { IconChevron } from './icons.js';

type Section = 'market' | 'ranking';
type MarketScope = 'department' | 'company';
type RankingScope = 'personal' | 'skill';

export function SkillZonePage({ onBack }: { onBack: () => void }): React.JSX.Element {
  const [section, setSection] = useState<Section>('market');
  const [marketScope, setMarketScope] = useState<MarketScope>('department');
  const [rankingScope, setRankingScope] = useState<RankingScope>('personal');
  const [content, setContent] = useState('正在读取真实 Skill 数据…');

  useEffect(() => {
    let cancelled = false;
    const load = async (): Promise<void> => {
      try {
        let text: string;
        if (section === 'market') {
          const result = marketScope === 'department'
            ? await window.otto.skillShareList()
            : await window.otto.skillMarketplace();
          text = result.text;
        } else {
          const result = await window.otto.skillLeaderboard();
          text = rankingScope === 'personal' ? result.starBoard : result.leaderboard;
        }
        if (!cancelled) setContent(text || '暂无数据。');
      } catch (error) {
        if (!cancelled) {
          setContent(`Skill 数据读取失败：${error instanceof Error ? error.message : String(error)}`);
        }
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [section, marketScope, rankingScope]);

  return (
    <section className="otto-skillzone" aria-label="Skill 专区">
      <header className="otto-skillzone__head">
        <div>
          <div className="otto-skillzone__eyebrow">企业能力沉淀</div>
          <h1>Skill 专区</h1>
          <p>部门经验在市场流动，个人贡献和 Skill 质量分别进入排行榜。</p>
        </div>
        <button type="button" className="otto-hub__btn" onClick={onBack}>
          <IconChevron size={13} /> 返回对话
        </button>
      </header>

      <div className="otto-skillzone__primary-tabs" role="tablist">
        <button type="button" className={section === 'market' ? 'is-active' : ''} onClick={() => setSection('market')}>Skill 市场</button>
        <button type="button" className={section === 'ranking' ? 'is-active' : ''} onClick={() => setSection('ranking')}>排行榜</button>
      </div>
      <div className="otto-skillzone__scope-tabs">
        {section === 'market' ? (
          <>
            <button type="button" className={marketScope === 'department' ? 'is-active' : ''} onClick={() => setMarketScope('department')}>部门市场</button>
            <button type="button" className={marketScope === 'company' ? 'is-active' : ''} onClick={() => setMarketScope('company')}>公司市场</button>
          </>
        ) : (
          <>
            <button type="button" className={rankingScope === 'personal' ? 'is-active' : ''} onClick={() => setRankingScope('personal')}>个人榜</button>
            <button type="button" className={rankingScope === 'skill' ? 'is-active' : ''} onClick={() => setRankingScope('skill')}>Skill 榜</button>
          </>
        )}
      </div>

      <div className="otto-skillzone__content">
        <pre>{content}</pre>
      </div>
      <div className="otto-skillzone__truthnote">
        当前只展示已写入企业 Skill 共享记录的真实数据；没有记录时明确显示为空，不生成示例排名。
      </div>
    </section>
  );
}
