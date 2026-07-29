/* ==========================================================================
 * Otto UIUX 预览增强层（ui/enhance.js）
 *
 * 只做两件事：
 *   1) 拦截预览模式下会白屏的入口（右栏「工作日志」tab、左下「查看全部对话」），
 *      换成模拟面板 —— 用户要求「所有按钮和导航都要保持可点击」。
 *   2) 补齐预览层缺失的交互：弹窗 Esc/遮罩关闭、消息过滤 tab、专家列表
 *      展开收起、首次打开三步导览、面包屑悬浮全文。
 *
 * 不修改 ui/main.js。所有注入的 DOM 都挂在 document.body（不进 #root），
 * 避免与 React  reconciliation 冲突；对 #root 内部只加 class、不改结构。
 * 删除本文件即恢复原状。
 * ========================================================================== */
(function () {
  'use strict';

  var LOG = '[otto-uiux]';
  var $ = function (sel, root) { return (root || document).querySelector(sel); };
  var $$ = function (sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); };

  /* ──────────────────────── 工作日志模拟面板 ──────────────────────── */

  var worklogEl = null;
  var worklogSyncTimer = null;

  var WORKLOG_ITEMS = [
    { time: '09:32', tag: 'Otto', title: '完成「优化用户登录流程」', desc: '提取重复验证逻辑到 validateLoginInput，编辑 login.ts，lint 通过。' },
    { time: '10:48', tag: 'Otto', title: '定位数据导出字段映射问题', desc: '在「修复数据导出问题」会话中给出修复建议，等待确认。' },
    { time: '11:20', tag: '手动', title: '新建日程「周会复盘」', desc: '在我的工作页手动添加，15:00–16:00。' },
    { time: '14:05', tag: 'Otto', title: '会议 Agent 整理会议纪要', desc: '提炼 3 条待办并同步到对话任务。' },
  ];

  function buildWorklog() {
    var el = document.createElement('div');
    el.className = 'otto-enhance-worklog';
    el.setAttribute('role', 'region');
    el.setAttribute('aria-label', '工作日志（演示）');

    var stats = [
      { n: '2', label: '今日成果' },
      { n: '6', label: '活跃对话' },
      { n: '9', label: '工具调用' },
    ];
    var html = '<div class="otto-enhance-worklog__head"><strong>工作日志</strong>' +
      '<span class="otto-enhance-worklog__demo">演示数据</span></div>' +
      '<div class="otto-enhance-worklog__stats">' +
      stats.map(function (s) {
        return '<div class="otto-enhance-worklog__stat"><b>' + s.n + '</b><span>' + s.label + '</span></div>';
      }).join('') + '</div><div class="otto-enhance-worklog__timeline">';

    html += WORKLOG_ITEMS.map(function (it) {
      var tagCls = it.tag === 'Otto' ? 'otto-enhance-worklog__tag' : 'otto-enhance-worklog__tag otto-enhance-worklog__tag--manual';
      return '<div class="otto-enhance-worklog__item">' +
        '<span class="otto-enhance-worklog__time">' + it.time + '</span>' +
        '<span class="otto-enhance-worklog__itembody">' +
        '<span class="' + tagCls + '">' + it.tag + '</span>' +
        '<strong>' + it.title + '</strong>' +
        '<small>' + it.desc + '</small>' +
        '</span></div>';
    }).join('');

    html += '</div><div class="otto-enhance-worklog__note">正式环境中，这里展示由服务端按天归纳的工作成果与操作记录。</div>';
    el.innerHTML = html;
    return el;
  }

  function syncWorklogPosition() {
    if (!worklogEl) return;
    var body = $('.otto-right-panel__body');
    var panel = $('.otto-right-panel');
    // 右栏被收起 / 隐藏 / 卸载时，模拟面板一并退场
    if (!body || !panel || panel.classList.contains('otto-right-panel--collapsed') ||
        body.getBoundingClientRect().width < 120) {
      removeWorklog();
      return;
    }
    var r = body.getBoundingClientRect();
    worklogEl.style.top = r.top + 'px';
    worklogEl.style.left = r.left + 'px';
    worklogEl.style.width = r.width + 'px';
    worklogEl.style.height = r.height + 'px';
  }

  function openWorklogMock() {
    if (worklogEl) { syncWorklogPosition(); return; }
    worklogEl = buildWorklog();
    document.body.appendChild(worklogEl);
    syncWorklogPosition();
    worklogSyncTimer = setInterval(syncWorklogPosition, 400);
  }

  function removeWorklog() {
    if (worklogEl) { worklogEl.remove(); worklogEl = null; }
    if (worklogSyncTimer) { clearInterval(worklogSyncTimer); worklogSyncTimer = null; }
  }

  function markWorklogTabActive() {
    $$('.otto-right-panel__tab').forEach(function (t) {
      t.classList.toggle('is-active', t.textContent.trim() === '工作日志');
      if (t.textContent.trim() === '工作日志') t.setAttribute('aria-selected', 'true');
    });
  }

  /* ──────────────────────── 「查看全部对话」模拟浮层 ──────────────────────── */

  var allconvEl = null;

  var ALLCONV_SESSIONS = [
    { group: '今天', title: '优化用户登录流程', preview: '我来帮你优化登录流程的代码…', time: '11:24', src: '飞书' },
    { group: '今天', title: '修复数据导出问题', preview: '已定位到导出时的字段映射问…', time: '10:48', src: '本地' },
    { group: '今天', title: '实现定时任务', preview: '定时任务功能已实现，包含…', time: '09:15', src: '飞书' },
    { group: '昨天', title: '接口性能优化建议', preview: '基于你的接口日志，我发现…', time: '18:30', src: '本地' },
    { group: '昨天', title: '增加登录设备管理', preview: '我来帮你实现设备管理功能…', time: '16:20', src: '飞书' },
    { group: '昨天', title: '前端页面加载慢', preview: '我分析了加载性能，主要问题…', time: '14:05', src: '本地' },
  ];

  function renderAllconvList(keyword) {
    var list = $('.otto-enhance-allconv__list', allconvEl);
    if (!list) return;
    var kw = (keyword || '').trim();
    var groups = [];
    ALLCONV_SESSIONS.forEach(function (s) {
      if (kw && s.title.indexOf(kw) === -1 && s.preview.indexOf(kw) === -1) return;
      var g = groups[groups.length - 1];
      if (!g || g.name !== s.group) { g = { name: s.group, items: [] }; groups.push(g); }
      g.items.push(s);
    });
    if (!groups.length) {
      list.innerHTML = '<div class="otto-enhance-allconv__empty">没有匹配「' + kw + '」的对话</div>';
      return;
    }
    list.innerHTML = groups.map(function (g) {
      var rows = g.items.map(function (s) {
        var srcCls = s.src === '本地' ? 'otto-enhance-allconv__src otto-enhance-allconv__src--local' : 'otto-enhance-allconv__src';
        return '<button class="otto-enhance-allconv__row" type="button">' +
          '<span class="otto-enhance-allconv__rowbody"><strong>' + s.title + '</strong>' +
          '<small>' + s.preview + '</small></span>' +
          '<span class="' + srcCls + '">' + s.src + '</span>' +
          '<span class="otto-enhance-allconv__time">' + s.time + '</span>' +
          '</button>';
      }).join('');
      return '<div class="otto-enhance-allconv__group">' + g.name + '</div>' + rows;
    }).join('');
  }

  function openAllconvMock() {
    if (allconvEl) return;
    allconvEl = document.createElement('div');
    allconvEl.className = 'otto-enhance-allconv';
    allconvEl.innerHTML =
      '<div class="otto-enhance-allconv__panel" role="dialog" aria-label="全部对话（演示）">' +
      '<div class="otto-enhance-allconv__head"><div>' +
      '<span class="otto-enhance-allconv__kicker">CONVERSATIONS</span>' +
      '<h2>全部对话</h2><p>跨来源检索所有对话任务（演示数据）</p></div>' +
      '<button class="otto-enhance-allconv__close" type="button" aria-label="关闭">×</button></div>' +
      '<div class="otto-enhance-allconv__search"><input type="search" placeholder="搜索对话标题或内容…" aria-label="搜索对话" /></div>' +
      '<div class="otto-enhance-allconv__list"></div></div>';
    document.body.appendChild(allconvEl);
    renderAllconvList('');
    var input = $('input', allconvEl);
    input.addEventListener('input', function () { renderAllconvList(input.value); });
    $('.otto-enhance-allconv__close', allconvEl).addEventListener('click', closeAllconvMock);
    allconvEl.addEventListener('click', function (e) {
      if (e.target === allconvEl) closeAllconvMock();
      if (e.target.closest && e.target.closest('.otto-enhance-allconv__row')) closeAllconvMock();
    });
    setTimeout(function () { input.focus(); }, 50);
  }

  function closeAllconvMock() {
    if (allconvEl) { allconvEl.remove(); allconvEl = null; }
  }

  /* ──────────────────────── 崩溃入口拦截（capture 阶段） ────────────────────────
   * bundle 里这两个入口在预览 mock 下会整页白屏（null.map / onViewAll 空实现）。
   * document 的 capture 监听先于 React 挂在 #root 的合成事件触发，
   * stopPropagation 后 React 永远收不到这次点击，白屏不会发生。 */
  document.addEventListener('click', function (e) {
    try {
      // 1) 右栏「工作日志」tab（展开态）
      var tab = e.target.closest ? e.target.closest('.otto-right-panel__tab') : null;
      if (tab) {
        if (tab.textContent.trim() === '工作日志') {
          e.stopPropagation();
          e.preventDefault();
          markWorklogTabActive();
          openWorklogMock();
          return;
        }
        // 点其他 tab：撤掉模拟面板，交给 React 正常渲染
        removeWorklog();
        return;
      }
      // 2) 右栏收起态的 rail 图标（最后一个 railitem = 工作日志）
      var rail = e.target.closest ? e.target.closest('.otto-right-panel__railitem') : null;
      if (rail) {
        var rails = $$('.otto-right-panel__railitem');
        if (rails.length && rail === rails[rails.length - 1] && rail.textContent.trim() === '工') {
          e.stopPropagation();
          e.preventDefault();
          var edge = $('.otto-right-panel__edge');
          if (edge) edge.click(); // 先展开右栏（走 React 正常逻辑）
          setTimeout(function () { markWorklogTabActive(); openWorklogMock(); }, 180);
        }
        return;
      }
      // 3) 左下「查看全部对话」
      var viewall = e.target.closest ? e.target.closest('button.otto-viewall') : null;
      if (viewall && viewall.textContent.indexOf('查看全部对话') !== -1) {
        e.stopPropagation();
        e.preventDefault();
        openAllconvMock();
        return;
      }
      // 4) 企业与好友抽屉里的「打开企业组织树」：内联树已隐藏，导流到导航「企业树」弹窗
      var drawerBtn = e.target.closest ? e.target.closest('.otto-collab-drawer button') : null;
      if (drawerBtn && drawerBtn.textContent.indexOf('打开企业组织树') !== -1) {
        e.stopPropagation();
        e.preventDefault();
        var navItems = $$('.otto-sidebar__nav .otto-sidebar__navitem');
        if (navItems[2]) navItems[2].click();
        return;
      }
    } catch (err) {
      console.warn(LOG, '拦截异常（已放行）', err);
    }
  }, true);

  window.addEventListener('resize', function () {
    syncWorklogPosition();
    if (tourState.active) positionTourStep();
  });

  /* ──────────────────────── 预览弹窗：Esc / 点遮罩关闭 ──────────────────────── */

  function closePreviewOverlay() {
    var overlay = $('.otto-preview-overlay');
    if (!overlay) return false;
    var btn = $('.otto-preview-panel > header button', overlay);
    if (btn) { btn.click(); return true; }
    return false;
  }

  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape') return;
    if (allconvEl) { closeAllconvMock(); e.stopPropagation(); return; }
    if (tourState.active) { finishTour(); return; }
    closePreviewOverlay();
  });

  document.addEventListener('click', function (e) {
    if (e.target && e.target.classList && e.target.classList.contains('otto-preview-overlay')) {
      closePreviewOverlay();
    }
  });

  /* ──────────────────────── 我的消息：过滤 tab 接活 ──────────────────────── */

  var inboxMode = '全部';

  function applyInboxFilter() {
    var overlay = $('.otto-preview-overlay');
    if (!overlay) return;
    var filters = $('.otto-preview-filters', overlay);
    if (!filters) return;
    $$('button', filters).forEach(function (b) {
      var label = b.textContent.replace(/\d+/g, '').trim();
      b.classList.toggle('is-active', label.indexOf(inboxMode) === 0);
    });
    $$('.otto-preview-message-card', overlay).forEach(function (card) {
      var unread = !!$('.otto-preview-unread', card);
      var show = inboxMode === '全部' || (inboxMode === '未读' && unread) || (inboxMode === '已处理' && !unread);
      card.style.display = show ? '' : 'none';
    });
  }

  document.addEventListener('click', function (e) {
    var btn = e.target.closest ? e.target.closest('.otto-preview-filters button') : null;
    if (!btn) return;
    inboxMode = btn.textContent.replace(/\d+/g, '').trim();
    applyInboxFilter();
  });

  /* ──────────────────────── 企业专家列表：默认收起前 4 位 ──────────────────────── */

  var expertsCollapsed = true;

  function applyExpertsCollapse() {
    $$('.otto-profile-list').forEach(function (list) {
      list.classList.toggle('otto-enhance-collapsed', expertsCollapsed);
    });
  }

  document.addEventListener('click', function (e) {
    var head = e.target.closest ? e.target.closest('.otto-right-panel__head') : null;
    if (!head) return;
    var next = head.nextElementSibling;
    if (next && next.classList.contains('otto-profile-list')) {
      expertsCollapsed = !expertsCollapsed;
      applyExpertsCollapse();
    }
  });

  /* ──────────────────────── 顶栏面包屑：悬浮看全文 ──────────────────────── */

  function applyBreadcrumbTitle() {
    var span = $('.otto-main__topbar > span:not([class])');
    if (span && !span.title) span.title = span.textContent.trim();
  }

  /* ──────────────────────── 首次打开三步导览 ──────────────────────── */

  var TOUR_KEY = 'otto.uiux.tour.v1.done';
  var tourState = { active: false, step: 0, el: null };

  var TOUR_STEPS = [
    {
      selector: '.otto-sidebar',
      title: '左侧：导航与工作区',
      body: '顶部是「新建对话」，下面五个主入口：工作台是日常对话主页；「我的消息」「企业树」会打开弹窗（带 ↗ 角标）；横线下方是历史对话，点一下就能切回去。',
    },
    {
      selector: '.otto-main',
      title: '中间：与 Otto 对话',
      body: '在这里描述工作、追问结果。顶部是会话标题和快捷操作；输入框可以选模型、贴附件，Otto 执行工具的过程会实时显示在消息流里。',
    },
    {
      selector: '.otto-right-panel',
      title: '右侧：专家与工具台',
      body: '企业专家、常用命令、文档和工作日志都收在这里。点「企业专家」标题可以展开全部专家；整块面板可以用左缘按钮收起。',
    },
  ];

  function startTour() {
    if (tourState.active) return;
    var el = document.createElement('div');
    el.className = 'otto-tour';
    el.innerHTML =
      '<div class="otto-tour__mask"></div>' +
      '<div class="otto-tour__spot"></div>' +
      '<div class="otto-tour__card">' +
      '<span class="otto-tour__step"></span>' +
      '<h3></h3><p></p>' +
      '<div class="otto-tour__actions">' +
      '<button class="otto-tour__skip" type="button">跳过</button>' +
      '<button class="otto-tour__next" type="button">下一步</button>' +
      '</div></div>';
    document.body.appendChild(el);
    tourState.el = el;
    tourState.active = true;
    tourState.step = 0;
    $('.otto-tour__skip', el).addEventListener('click', finishTour);
    $('.otto-tour__next', el).addEventListener('click', function () {
      if (tourState.step >= TOUR_STEPS.length - 1) { finishTour(); return; }
      tourState.step += 1;
      positionTourStep();
    });
    positionTourStep();
  }

  function positionTourStep() {
    if (!tourState.active || !tourState.el) return;
    var conf = TOUR_STEPS[tourState.step];
    var target = $(conf.selector);
    if (!target) { finishTour(); return; }
    var r = target.getBoundingClientRect();
    var pad = 6;
    var spot = $('.otto-tour__spot', tourState.el);
    spot.style.top = (r.top - pad) + 'px';
    spot.style.left = (r.left - pad) + 'px';
    spot.style.width = (r.width + pad * 2) + 'px';
    spot.style.height = (r.height + pad * 2) + 'px';

    var card = $('.otto-tour__card', tourState.el);
    $('.otto-tour__step', card).textContent = '导览 ' + (tourState.step + 1) + ' / ' + TOUR_STEPS.length;
    $('h3', card).textContent = conf.title;
    $('p', card).textContent = conf.body;
    $('.otto-tour__next', card).textContent = tourState.step === TOUR_STEPS.length - 1 ? '开始体验' : '下一步';

    // 卡片摆放：左栏步骤放右侧、右栏步骤放左侧、中间步骤放区域底部居中
    var cw = 300, ch = 190, gap = 18, x, y;
    if (conf.selector === '.otto-sidebar') {
      x = r.right + gap; y = r.top + 90;
    } else if (conf.selector === '.otto-right-panel') {
      x = r.left - cw - gap; y = r.top + 90;
    } else {
      x = r.left + (r.width - cw) / 2; y = r.bottom - ch - 60;
    }
    x = Math.max(12, Math.min(x, window.innerWidth - cw - 12));
    y = Math.max(12, Math.min(y, window.innerHeight - ch - 12));
    card.style.left = x + 'px';
    card.style.top = y + 'px';
  }

  function finishTour() {
    if (tourState.el) { tourState.el.remove(); tourState.el = null; }
    tourState.active = false;
    try { localStorage.setItem(TOUR_KEY, '1'); } catch (err) { /* 私密模式忽略 */ }
  }

  /* ──────────────────────── 启动与重渲染守护 ──────────────────────── */

  // React 重渲染会抹掉我们加在 #root 内的 class（折叠态、过滤态），
  // 用 MutationObserver 去抖后幂等重放。注入在 body 的 DOM 不受影响。
  var reapplyTimer = null;
  function scheduleReapply() {
    if (reapplyTimer) clearTimeout(reapplyTimer);
    reapplyTimer = setTimeout(function () {
      reapplyTimer = null;
      try {
        applyExpertsCollapse();
        applyInboxFilter();
        applyBreadcrumbTitle();
        syncWorklogPosition();
      } catch (err) {
        console.warn(LOG, '重放增强异常', err);
      }
    }, 120);
  }

  function boot() {
    var root = document.getElementById('root');
    if (!root || !$('.otto-sidebar')) return false;
    try {
      applyExpertsCollapse();
      applyBreadcrumbTitle();
      var observer = new MutationObserver(scheduleReapply);
      observer.observe(root, { childList: true, subtree: true });
      // 首次访问引导（localStorage 记住，不再打扰）
      var toured = null;
      try { toured = localStorage.getItem(TOUR_KEY); } catch (err) { /* ignore */ }
      if (!toured) setTimeout(startTour, 900);
      // 供验收时手动重播：控制台执行 ottoUiux.replayTour()
      window.ottoUiux = {
        replayTour: function () {
          try { localStorage.removeItem(TOUR_KEY); } catch (err) { /* ignore */ }
          startTour();
        },
      };
      console.log(LOG, '增强层已加载');
    } catch (err) {
      console.warn(LOG, '启动异常', err);
    }
    return true;
  }

  var bootTimer = setInterval(function () {
    if (boot()) clearInterval(bootTimer);
  }, 200);
  setTimeout(function () { clearInterval(bootTimer); }, 15000);
})();
