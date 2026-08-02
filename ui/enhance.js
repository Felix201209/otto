/* ==========================================================================
 * Otto UIUX 预览增强层（ui/enhance.js）
 *
 * 只做三件事：
 *   1) 拦截预览模式下会白屏的入口（右栏「工作日志」tab、左下「查看全部对话」），
 *      换成模拟面板 —— 用户要求「所有按钮和导航都要保持可点击」。
 *   2) 补齐预览层缺失的交互：弹窗 Esc/遮罩关闭、消息过滤 tab、专家列表
 *      展开收起、首次打开三步导览、面包屑悬浮全文。
 *   3) 按评审后的信息架构重排主导航，并提供可交互的「组织架构」主视图。
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
  var escapeHtml = function (value) {
    return String(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  };

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
    var html = '<div class="otto-enhance-worklog__head">' +
      '<button class="otto-enhance-worklog__back" type="button">‹ 返回</button>' +
      '<strong>工作日志</strong>' +
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
    $('.otto-enhance-worklog__back', worklogEl).addEventListener('click', function () {
      removeWorklog();
      unmarkWorklogTab();
    });
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

  function unmarkWorklogTab() {
    $$('.otto-right-panel__tab').forEach(function (t) {
      if (t.textContent.trim() === '工作日志') {
        t.classList.remove('is-active');
        t.removeAttribute('aria-selected');
      }
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

  /* ──────────────────────── 主导航与组织架构主视图 ──────────────────────── */

  var organizationEl = null;
  var activeNavigationKind = 'workbench';
  var organizationExpanded = {
    park: false,
    facilities: false,
    tenant: true,
  };

  var ORGANIZATION_DEPARTMENTS = [
    {
      id: 'park',
      name: '园区运营部',
      summary: '园区运营、企业服务与客户支持',
      members: [
        { id: 'felix', initial: 'F', name: 'Felix', role: '园区管理员', online: true },
        { id: 'lina', initial: '李', name: '李娜', role: '客服专员', online: true },
      ],
    },
    {
      id: 'facilities',
      name: '工程保障部',
      summary: '设备运维、现场维修与工程调度',
      members: [
        { id: 'wang', initial: '王', name: '王工', role: '维修工作人员', online: true },
        { id: 'chen', initial: '陈', name: '陈晓', role: '工程调度', online: false },
      ],
    },
    {
      id: 'tenant',
      name: '入驻企业',
      summary: '企业协作、日常事务与园区沟通',
      current: true,
      members: [
        { id: 'local-user', initial: '本', name: '本地测试用户', role: '员工', self: true, online: true },
        { id: 'colleague', initial: '周', name: '周敏', role: '运营经理', online: true },
      ],
    },
  ];

  function organizationMemberHtml(member) {
    var presence = member.online
      ? '<span class="otto-org-page__presence"><i></i>在线</span>'
      : '<span class="otto-org-page__presence is-offline"><i></i>离线</span>';
    if (member.self) {
      return '<div class="otto-org-page__member is-self" aria-label="' +
        escapeHtml(member.name) + '（我）">' +
        '<span class="otto-org-page__avatar">' + escapeHtml(member.initial) + '</span>' +
        '<span class="otto-org-page__membercopy"><strong>' + escapeHtml(member.name) +
        '<b>我</b></strong><small>' + escapeHtml(member.role) + '</small></span>' +
        presence + '</div>';
    }
    return '<button type="button" class="otto-org-page__member" data-org-member="' +
      escapeHtml(member.id) + '" aria-label="与 ' + escapeHtml(member.name) + ' 聊天">' +
      '<span class="otto-org-page__avatar">' + escapeHtml(member.initial) + '</span>' +
      '<span class="otto-org-page__membercopy"><strong>' + escapeHtml(member.name) +
      '</strong><small>' + escapeHtml(member.role) + '</small></span>' +
      presence +
      '<span class="otto-org-page__chatmark" aria-hidden="true">›</span>' +
      '</button>';
  }

  function organizationDepartmentHtml(department) {
    return '<article class="otto-org-page__department' +
      (department.current ? ' is-current' : '') +
      '" data-department="' + department.id + '">' +
      '<button class="otto-org-page__department-toggle" type="button" data-org-department="' +
      department.id + '" aria-expanded="' + String(organizationExpanded[department.id]) + '">' +
      '<span class="otto-org-page__department-icon" aria-hidden="true">⌂</span>' +
      '<span class="otto-org-page__department-copy"><strong>' + department.name + '</strong>' +
      '<small>' + department.summary + '</small></span>' +
      (department.current ? '<span class="otto-org-page__current">我的部门</span>' : '') +
      '<span class="otto-org-page__count">' + department.members.length + ' 人</span>' +
      '<span class="otto-org-page__chevron" aria-hidden="true"></span>' +
      '</button>' +
      '<div class="otto-org-page__members">' +
      department.members.map(organizationMemberHtml).join('') +
      '</div></article>';
  }

  var directChatPanels = {};
  var directChatMessages = {};
  var directChatStack = 80;

  function findOrganizationMember(memberId) {
    for (var departmentIndex = 0; departmentIndex < ORGANIZATION_DEPARTMENTS.length; departmentIndex += 1) {
      var department = ORGANIZATION_DEPARTMENTS[departmentIndex];
      for (var memberIndex = 0; memberIndex < department.members.length; memberIndex += 1) {
        var member = department.members[memberIndex];
        if (member.id === memberId) return { member: member, department: department };
      }
    }
    return null;
  }

  function currentDirectMessageTime() {
    return new Date().toLocaleTimeString('zh-CN', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
  }

  function renderDirectMessage(panel, member, message) {
    var messages = $('.otto-direct-chat__messages', panel);
    if (!messages) return;
    var empty = $('.otto-direct-chat__empty', messages);
    if (empty) empty.remove();

    var article = document.createElement('article');
    article.className = 'otto-direct-chat__message ' + (message.mine ? 'is-me' : 'is-peer');
    var meta = document.createElement('div');
    meta.className = 'otto-direct-chat__message-meta';
    var speaker = document.createElement('span');
    speaker.textContent = message.mine ? '我' : member.name;
    var time = document.createElement('time');
    time.textContent = message.time;
    meta.appendChild(speaker);
    meta.appendChild(time);

    var bubble = document.createElement('div');
    bubble.className = 'otto-direct-chat__bubble';
    bubble.textContent = message.content;
    article.appendChild(meta);
    article.appendChild(bubble);
    messages.appendChild(article);
    messages.scrollTop = messages.scrollHeight;
  }

  function appendDirectMessage(panel, member, content) {
    var message = {
      mine: true,
      content: content,
      time: currentDirectMessageTime(),
    };
    if (!directChatMessages[member.id]) directChatMessages[member.id] = [];
    directChatMessages[member.id].push(message);
    renderDirectMessage(panel, member, message);
  }

  function buildDirectChat(memberRecord, panelIndex) {
    var member = memberRecord.member;
    var department = memberRecord.department;
    var panel = document.createElement('div');
    panel.className = 'otto-direct-chat otto-enhance-direct-chat';
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', '与 ' + member.name + ' 聊天');
    panel.setAttribute('data-chat-member', member.id);
    panel.style.zIndex = String(++directChatStack);
    var sidebar = $('.otto-sidebar');
    var sidebarRight = sidebar ? sidebar.getBoundingClientRect().right : 230;
    var cascade = (panelIndex % 6) * 18;
    panel.style.left = Math.min(sidebarRight + 22 + cascade, Math.max(12, window.innerWidth - 560)) + 'px';
    panel.style.top = (48 + cascade) + 'px';
    panel.innerHTML =
      '<header class="otto-direct-chat__header">' +
      '<div class="otto-direct-chat__identity">' +
      '<div class="otto-direct-chat__avatar" aria-hidden="true">' + escapeHtml(member.initial) + '</div>' +
      '<div class="otto-direct-chat__titleblock"><strong>' + escapeHtml(member.name) + '</strong>' +
      '<span>' + escapeHtml(department.name + ' · ' + member.role) + '</span></div></div>' +
      '<div class="otto-direct-chat__header-actions">' +
      '<span class="otto-direct-chat__presence is-online">在线</span>' +
      '<button type="button" class="otto-direct-chat__icon" data-chat-action="minimize" aria-label="最小化聊天" title="最小化聊天">−</button>' +
      '<button type="button" class="otto-direct-chat__icon" data-chat-action="maximize" aria-label="最大化聊天" title="最大化聊天">□</button>' +
      '<button type="button" class="otto-direct-chat__icon" data-chat-action="close" aria-label="关闭聊天" title="关闭聊天">×</button>' +
      '</div></header>' +
      '<div class="otto-direct-chat__actionbar" aria-label="Otto 协作操作">' +
      '<button type="button" class="otto-direct-chat__otto" data-chat-collab="own" disabled>问 Otto</button>' +
      '<button type="button" class="otto-direct-chat__otto" data-chat-collab="peer" disabled>问对方 Otto</button>' +
      '</div>' +
      '<div class="otto-direct-chat__messages" aria-live="polite">' +
      '<div class="otto-direct-chat__empty"><strong>还没有消息，开始聊聊吧。</strong>' +
      '<span>可直接发送文字、图片、Word、PDF；需要整理上下文时可使用 Otto 协作。</span></div>' +
      '</div>' +
      '<form class="otto-direct-chat__composer">' +
      '<input class="otto-direct-chat__fileinput" type="file" multiple aria-label="选择聊天附件" />' +
      '<textarea maxlength="4000" rows="3" placeholder="输入消息，或拖入 Word、PDF、图片" aria-label="消息内容"></textarea>' +
      '<div class="otto-direct-chat__composer-footer">' +
      '<div class="otto-direct-chat__composer-tools">' +
      '<button type="button" class="otto-direct-chat__attach" aria-label="添加文件或图片" title="添加图片、Word、PDF 或其它常用文件">' +
      '<span class="otto-direct-chat__attach-icon" aria-hidden="true">+</span><span>文件</span></button>' +
      '<span class="otto-direct-chat__hint">Enter 发送 · Shift+Enter 换行</span>' +
      '</div><button type="submit" disabled>发送</button></div></form>';

    var storedMessages = directChatMessages[member.id] || [];
    storedMessages.forEach(function (message) {
      renderDirectMessage(panel, member, message);
    });

    var textarea = $('.otto-direct-chat__composer textarea', panel);
    var form = $('.otto-direct-chat__composer', panel);
    var submit = $('.otto-direct-chat__composer-footer > button', panel);
    var fileInput = $('.otto-direct-chat__fileinput', panel);
    var attach = $('.otto-direct-chat__attach', panel);
    var hint = $('.otto-direct-chat__hint', panel);
    var sourceAttachIcon = $('#root button[aria-label="添加文件或图片"] svg');
    var attachIcon = $('.otto-direct-chat__attach-icon', panel);
    if (sourceAttachIcon && attachIcon) attachIcon.replaceWith(sourceAttachIcon.cloneNode(true));

    function syncDirectChatComposer() {
      var hasContent = !!textarea.value.trim();
      var hasFiles = !!(fileInput.files && fileInput.files.length);
      submit.disabled = !hasContent && !hasFiles;
      $$('[data-chat-collab]', panel).forEach(function (button) {
        button.disabled = !hasContent;
      });
      if (!hasFiles) {
        hint.textContent = hasContent
          ? textarea.value.trim().length + '/4000'
          : 'Enter 发送 · Shift+Enter 换行';
      }
    }

    function sendDirectChat(prefix) {
      var content = textarea.value.trim();
      var files = fileInput.files ? Array.prototype.slice.call(fileInput.files) : [];
      if (!content && !files.length) return;
      var fileSummary = files.length
        ? (content ? '\n' : '') + '[附件] ' + files.map(function (file) { return file.name; }).join('、')
        : '';
      appendDirectMessage(panel, member, (prefix || '') + content + fileSummary);
      textarea.value = '';
      fileInput.value = '';
      syncDirectChatComposer();
      textarea.focus();
    }

    panel.addEventListener('pointerdown', function () {
      panel.style.zIndex = String(++directChatStack);
    });
    panel.addEventListener('click', function (event) {
      var action = event.target.closest ? event.target.closest('[data-chat-action]') : null;
      if (action) {
        var actionName = action.getAttribute('data-chat-action');
        if (actionName === 'close') {
          panel.remove();
          delete directChatPanels[member.id];
          return;
        }
        if (actionName === 'minimize') {
          panel.classList.remove('is-maximized');
          panel.classList.toggle('is-minimized');
          var minimized = panel.classList.contains('is-minimized');
          action.textContent = minimized ? '+' : '−';
          action.setAttribute('aria-label', minimized ? '展开聊天' : '最小化聊天');
          action.setAttribute('title', minimized ? '展开聊天' : '最小化聊天');
          return;
        }
        if (actionName === 'maximize') {
          panel.classList.remove('is-minimized');
          panel.classList.toggle('is-maximized');
          var maximized = panel.classList.contains('is-maximized');
          action.textContent = maximized ? '❐' : '□';
          action.setAttribute('aria-label', maximized ? '还原聊天' : '最大化聊天');
          action.setAttribute('title', maximized ? '还原聊天' : '最大化聊天');
          return;
        }
      }
      var collaboration = event.target.closest ? event.target.closest('[data-chat-collab]') : null;
      if (!collaboration || collaboration.disabled) return;
      var prefix = collaboration.getAttribute('data-chat-collab') === 'peer'
        ? '问对方 Otto：'
        : '问 Otto：';
      sendDirectChat(prefix);
    });
    textarea.addEventListener('input', syncDirectChatComposer);
    textarea.addEventListener('keydown', function (event) {
      if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
        event.preventDefault();
        form.requestSubmit();
      }
    });
    form.addEventListener('submit', function (event) {
      event.preventDefault();
      sendDirectChat('');
    });
    attach.addEventListener('click', function () { fileInput.click(); });
    fileInput.addEventListener('change', function () {
      var files = fileInput.files ? Array.prototype.slice.call(fileInput.files) : [];
      hint.textContent = files.length
        ? '已选 ' + files.length + ' 个文件'
        : 'Enter 发送 · Shift+Enter 换行';
      syncDirectChatComposer();
    });
    return panel;
  }

  function openDirectChat(memberId) {
    var memberRecord = findOrganizationMember(memberId);
    if (!memberRecord) return;
    var existing = directChatPanels[memberId];
    if (existing && existing.isConnected) {
      existing.classList.remove('is-minimized');
      existing.style.zIndex = String(++directChatStack);
      var existingTextarea = $('.otto-direct-chat__composer textarea', existing);
      if (existingTextarea) existingTextarea.focus();
      return;
    }
    var panel = buildDirectChat(memberRecord, Object.keys(directChatPanels).length);
    directChatPanels[memberId] = panel;
    document.body.appendChild(panel);
    var textarea = $('.otto-direct-chat__composer textarea', panel);
    if (textarea) textarea.focus();
  }

  function buildOrganizationPage() {
    var el = document.createElement('section');
    el.className = 'otto-enhance-orgpage';
    el.setAttribute('role', 'region');
    el.setAttribute('aria-label', '组织架构');
    el.innerHTML =
      '<header class="otto-org-page__header">' +
      '<button class="otto-org-page__back" type="button" data-org-back>‹ 返回</button>' +
      '<div class="otto-org-page__heading"><span>组织管理</span>' +
      '<h1>组织架构</h1><p>北控宏创科技园 · 6 位成员 · 3 个一级部门</p></div>' +
      '<div class="otto-org-page__viewmode" role="group" aria-label="架构展开方式">' +
      '<button type="button" data-org-mode="default" aria-pressed="true">默认视图</button>' +
      '<button type="button" data-org-mode="all" aria-pressed="false">全部展开</button>' +
      '</div></header>' +
      '<div class="otto-org-page__body">' +
      '<div class="otto-org-page__sectionhead"><div><strong>组织全貌</strong>' +
      '<span>一级部门全部可见，默认展开你所在的部门</span></div>' +
      '<span class="otto-org-page__legend"><i></i>当前在线 5</span></div>' +
      '<div class="otto-org-page__canvas">' +
      '<div class="otto-org-page__root"><span>O</span><div>' +
      '<strong>北控宏创科技园</strong><small>企业组织 · 3 个一级部门</small>' +
      '</div></div>' +
      '<div class="otto-org-page__departments">' +
      ORGANIZATION_DEPARTMENTS.map(organizationDepartmentHtml).join('') +
      '</div></div></div>';
    return el;
  }

  function organizationMode() {
    var values = Object.keys(organizationExpanded).map(function (key) {
      return organizationExpanded[key];
    });
    if (values.every(Boolean)) return 'all';
    if (!organizationExpanded.park && !organizationExpanded.facilities &&
        organizationExpanded.tenant) return 'default';
    return 'custom';
  }

  function applyOrganizationState() {
    if (!organizationEl) return;
    $$('.otto-org-page__department', organizationEl).forEach(function (department) {
      var id = department.getAttribute('data-department');
      var expanded = !!organizationExpanded[id];
      department.classList.toggle('is-expanded', expanded);
      var toggle = $('.otto-org-page__department-toggle', department);
      var members = $('.otto-org-page__members', department);
      if (toggle) toggle.setAttribute('aria-expanded', String(expanded));
      if (members) members.hidden = !expanded;
    });
    var mode = organizationMode();
    $$('[data-org-mode]', organizationEl).forEach(function (button) {
      button.setAttribute('aria-pressed', String(button.getAttribute('data-org-mode') === mode));
    });
  }

  function syncOrganizationPosition() {
    if (!organizationEl) return;
    var sidebar = $('.otto-sidebar');
    if (!sidebar) return;
    organizationEl.style.left = sidebar.getBoundingClientRect().right + 'px';
  }

  function setActiveNavigation(kind) {
    activeNavigationKind = kind;
    $$('.otto-sidebar__navitem').forEach(function (button) {
      var active = button.getAttribute('data-uiux-nav') === kind;
      button.classList.toggle('is-active', active);
      if (active) button.setAttribute('aria-current', 'page');
      else button.removeAttribute('aria-current');
    });
  }

  function setOrganizationNavActive(active) {
    if (active) {
      setActiveNavigation('organization');
      return;
    }
    var organizationButton = $('[data-uiux-nav="organization"]');
    if (organizationButton) {
      organizationButton.classList.remove('is-active');
      organizationButton.removeAttribute('aria-current');
    }
  }

  function openOrganizationPage() {
    closePreviewOverlay();
    closeAllconvMock();
    removeWorklog();
    if (!organizationEl) {
      organizationEl = buildOrganizationPage();
      document.body.appendChild(organizationEl);
      organizationEl.addEventListener('click', function (event) {
        if (event.target.closest && event.target.closest('[data-org-back]')) {
          closeOrganizationPage();
          setTimeout(syncNavigationState, 80);
          return;
        }
        var memberButton = event.target.closest
          ? event.target.closest('[data-org-member]') : null;
        if (memberButton) {
          openDirectChat(memberButton.getAttribute('data-org-member'));
          return;
        }
        var departmentToggle = event.target.closest
          ? event.target.closest('[data-org-department]') : null;
        if (departmentToggle) {
          var departmentId = departmentToggle.getAttribute('data-org-department');
          organizationExpanded[departmentId] = !organizationExpanded[departmentId];
          applyOrganizationState();
          return;
        }
        var modeButton = event.target.closest ? event.target.closest('[data-org-mode]') : null;
        if (!modeButton) return;
        var mode = modeButton.getAttribute('data-org-mode');
        if (mode === 'all') {
          Object.keys(organizationExpanded).forEach(function (key) {
            organizationExpanded[key] = true;
          });
        } else {
          organizationExpanded.park = false;
          organizationExpanded.facilities = false;
          organizationExpanded.tenant = true;
        }
        applyOrganizationState();
      });
    }
    applyOrganizationState();
    syncOrganizationPosition();
    setOrganizationNavActive(true);
  }

  function closeOrganizationPage() {
    if (organizationEl) {
      organizationEl.remove();
      organizationEl = null;
    }
    setOrganizationNavActive(false);
  }

  function setNavLabel(button, label) {
    if (!button) return;
    var span = $('span', button);
    if (span && span.textContent !== label) span.textContent = label;
  }

  var PREVIEW_CONVERSATIONS = [
    { id: 'meeting-notes', title: '整理周会纪要', time: '今天', state: 'loading' },
    { id: 'monthly-report', title: '导出企业月报', time: '昨天', state: 'error' },
    { id: 'login-flow', title: '优化登录流程', time: '3 天前', state: '' },
  ];

  function selectConversationRow(row) {
    $$('.otto-session').forEach(function (session) {
      session.classList.remove('otto-session--active');
      session.removeAttribute('aria-current');
    });
    row.classList.add('otto-session--active');
    row.setAttribute('aria-current', 'true');
    var title = $('.otto-session__title', row);
    var mainTitle = $('.otto-main__title');
    if (title && mainTitle) mainTitle.textContent = title.textContent;
    setActiveNavigation('workbench');
  }

  function buildPreviewConversationRow(conversation) {
    var row = document.createElement('button');
    row.type = 'button';
    row.className = 'otto-session otto-uiux-session' +
      (conversation.state ? ' is-' + conversation.state : '');
    row.setAttribute('data-uiux-session', conversation.id);
    row.setAttribute('aria-label', conversation.title + '，' + conversation.time +
      (conversation.state === 'loading' ? '，进行中' : conversation.state === 'error' ? '，失败' : ''));
    var status = conversation.state === 'loading'
      ? '<span class="otto-session__status otto-session__status--loading" aria-label="进行中"></span>'
      : conversation.state === 'error'
        ? '<span class="otto-session__status otto-session__status--error" aria-label="任务失败">!</span>'
        : '';
    row.innerHTML =
      '<span class="otto-session__top">' +
      '<span class="otto-session__title">' + escapeHtml(conversation.title) + '</span>' +
      (conversation.state === 'loading' ? status : '') +
      '<span class="otto-session__time">' + escapeHtml(conversation.time) + '</span>' +
      (conversation.state === 'error' ? status : '') +
      '</span>';
    row.addEventListener('click', function () {
      selectConversationRow(row);
    });
    return row;
  }

  function applyConversationLayout() {
    var conversations = $('.otto-conversations');
    if (!conversations) return;
    conversations.setAttribute('aria-label', '会话');
    var toggle = $('.otto-conversations__toggle', conversations);
    if (!toggle) return;

    var realCount = Number(toggle.getAttribute('data-uiux-real-count'));
    if (!realCount) {
      var countMatch = (toggle.getAttribute('aria-label') || toggle.textContent).match(/\d+/);
      realCount = countMatch ? Number(countMatch[0]) : 0;
      toggle.setAttribute('data-uiux-real-count', String(realCount));
    }
    var totalCount = realCount + PREVIEW_CONVERSATIONS.length;
    var label = $('span', toggle);
    if (label && label.getAttribute('data-uiux-count') !== String(totalCount)) {
      label.className = 'otto-conversations__title';
      label.setAttribute('data-uiux-count', String(totalCount));
      label.innerHTML = '<strong>会话</strong><small>(' + totalCount + ')</small>';
    }
    toggle.setAttribute('aria-label', '会话 (' + totalCount + ')');

    var sessions = $('.otto-sessions', conversations);
    if (!sessions) return;
    $$('.otto-session:not(.otto-uiux-session)', sessions).forEach(function (session) {
      var group = session.parentElement ? $('.otto-group__label', session.parentElement) : null;
      var relativeTime = group ? group.textContent.trim() : '今天';
      var time = $('.otto-session__time', session);
      if (time && time.textContent !== relativeTime) time.textContent = relativeTime;
      session.setAttribute('data-uiux-conversation', 'true');
    });
    PREVIEW_CONVERSATIONS.forEach(function (conversation) {
      if (!$('[data-uiux-session="' + conversation.id + '"]', sessions)) {
        sessions.appendChild(buildPreviewConversationRow(conversation));
      }
    });
  }

  function applyNavigationLayout() {
    var nav = $('.otto-sidebar__nav');
    if (!nav) return;
    var buttons = $$('.otto-sidebar__navitem', nav);
    if (buttons.length < 5) return;

    var workbench = buttons[0];
    var messages = buttons[1];
    var organization = buttons[2];
    var work = buttons[3];
    var settings = buttons[4];
    var items = [
      [workbench, 'workbench', '工作台'],
      [organization, 'organization', '组织架构'],
      [messages, 'messages', '我的消息'],
      [work, 'work', '我的工作'],
      [settings, 'settings', '设置'],
    ];
    items.forEach(function (item, index) {
      item[0].setAttribute('data-uiux-nav', item[1]);
      item[0].style.order = String(index + 1);
      setNavLabel(item[0], item[2]);
    });
    organization.setAttribute('title', '打开组织架构');
    settings.setAttribute('title', '设置');

    var conversations = $('.otto-conversations');
    if (conversations && !$('.otto-conversations__viewall', conversations)) {
      var source = $$('.otto-sidebar__footer .otto-viewall').find(function (button) {
        return button.textContent.indexOf('查看全部对话') !== -1;
      });
      var viewAll = document.createElement('button');
      viewAll.type = 'button';
      viewAll.className = 'otto-conversations__viewall';
      viewAll.setAttribute('aria-label', '查看全部对话');
      viewAll.innerHTML = source
        ? source.innerHTML
        : '<span>查看全部对话</span>';
      viewAll.addEventListener('click', openAllconvMock);
      conversations.appendChild(viewAll);
    }

    var hub = $('.otto-sidebar__footer .otto-viewall--hub');
    if (hub) {
      hub.setAttribute('aria-label', '设置');
      hub.setAttribute('title', '设置');
    }
  }

  function syncNavigationState() {
    var hub = $('.otto-sidebar__footer .otto-viewall--hub');
    if (organizationEl) {
      setOrganizationNavActive(true);
      return;
    }
    if (hub && hub.classList.contains('is-active')) {
      setActiveNavigation('settings');
      return;
    }
    if (activeNavigationKind === 'settings' || activeNavigationKind === 'organization') {
      activeNavigationKind = 'workbench';
    }
    if (activeNavigationKind === 'messages' && !$('.otto-preview-overlay')) {
      activeNavigationKind = 'workbench';
    }
    setActiveNavigation(activeNavigationKind);
  }

  /* ──────────────────────── 崩溃入口拦截（capture 阶段） ────────────────────────
   * bundle 里这两个入口在预览 mock 下会整页白屏（null.map / onViewAll 空实现）。
   * document 的 capture 监听先于 React 挂在 #root 的合成事件触发，
   * stopPropagation 后 React 永远收不到这次点击，白屏不会发生。 */
  document.addEventListener('click', function (e) {
    try {
      // 0) 评审后的一级导航：组织架构进入主视图；设置统一进入设置中心。
      var navItem = e.target.closest ? e.target.closest('.otto-sidebar__navitem') : null;
      if (navItem) {
        var navKind = navItem.getAttribute('data-uiux-nav');
        if (navKind === 'organization') {
          e.stopPropagation();
          e.preventDefault();
          openOrganizationPage();
          return;
        }
        if (organizationEl) closeOrganizationPage();
        if (navKind === 'settings') {
          e.stopPropagation();
          e.preventDefault();
          setActiveNavigation('settings');
          var settingsHub = $('.otto-sidebar__footer .otto-viewall--hub');
          if (settingsHub) settingsHub.click();
          setTimeout(syncNavigationState, 80);
          return;
        }
        if (navKind) {
          activeNavigationKind = navKind;
          setTimeout(syncNavigationState, 80);
        }
      }
      // 0.5) 左下角用户卡 → 账号菜单（设置/宠物/退出登录 统一收口到左下角）
      var accountCard = e.target.closest ? e.target.closest('.otto-sidebar-account') : null;
      if (accountCard) {
        if (e.target.closest && e.target.closest('.otto-sidebar-account__logout')) return;
        e.stopPropagation();
        e.preventDefault();
        if (accountMenuEl) closeAccountMenu(); else openAccountMenu();
        return;
      }
      // 0.6) 空会话推荐问题：填入输入框（不发送）并标记选中态
      var promptChip = e.target.closest ? e.target.closest('.otto-prompt-chip') : null;
      if (promptChip) {
        e.stopPropagation();
        e.preventDefault();
        selectPromptChip(promptChip);
        return;
      }
      if (e.target.closest && e.target.closest('.otto-send')) clearPromptSelection();
      var conversationRow = e.target.closest ? e.target.closest('.otto-session') : null;
      if (conversationRow && !conversationRow.classList.contains('otto-uiux-session')) {
        $$('.otto-uiux-session').forEach(function (session) {
          session.classList.remove('otto-session--active');
          session.removeAttribute('aria-current');
        });
        clearPromptSelection();
        activeNavigationKind = 'workbench';
        setTimeout(syncNavigationState, 80);
      }
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
      // 3) 「对话任务」内的「查看全部对话」（兼容原底部入口）
      var viewall = e.target.closest ? e.target.closest('button.otto-viewall') : null;
      if (viewall && viewall.textContent.indexOf('查看全部对话') !== -1) {
        e.stopPropagation();
        e.preventDefault();
        openAllconvMock();
        return;
      }
      // 4) 企业与好友抽屉里的「打开企业组织树」：导流到一级「组织架构」主视图
      var drawerBtn = e.target.closest ? e.target.closest('.otto-collab-drawer button') : null;
      if (drawerBtn && drawerBtn.textContent.indexOf('打开企业组织树') !== -1) {
        e.stopPropagation();
        e.preventDefault();
        openOrganizationPage();
        return;
      }
    } catch (err) {
      console.warn(LOG, '拦截异常（已放行）', err);
    }
  }, true);

  window.addEventListener('resize', function () {
    syncWorklogPosition();
    syncOrganizationPosition();
    syncProjectBar();
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
    if (accountMenuEl) { closeAccountMenu(); e.stopPropagation(); return; }
    if (worklogEl) { removeWorklog(); unmarkWorklogTab(); e.stopPropagation(); return; }
    if (organizationEl) { closeOrganizationPage(); setTimeout(syncNavigationState, 80); e.stopPropagation(); return; }
    if (parkEl) { closeParkServices(); e.stopPropagation(); return; }
    if (allconvEl) { closeAllconvMock(); e.stopPropagation(); return; }
    if (tourState.active) { finishTour(); return; }
    closePreviewOverlay();
  });

  // ⌘, / Ctrl+, 打开设置（对齐桌面端快捷键习惯；已打开时不重复触发）
  document.addEventListener('keydown', function (e) {
    if (!(e.metaKey || e.ctrlKey) || e.key !== ',') return;
    if (!$('.otto-sidebar')) return;
    e.preventDefault();
    if ($('.otto-hubfloat-overlay')) return;
    var hub = $('.otto-sidebar__footer .otto-viewall--hub');
    if (hub) hub.click();
  });

  document.addEventListener('click', function (e) {
    if (e.target && e.target.classList && e.target.classList.contains('otto-preview-overlay')) {
      closePreviewOverlay();
    }
  });

  /* ──────────────────────── 我的消息：过滤 tab 接活 ──────────────────────── */

  var inboxMode = '全部';
  var selectedInboxMessageId = 'colleague-message';
  var INBOX_MESSAGES = [
    {
      id: 'colleague-message',
      kind: 'colleague',
      icon: '人',
      iconClass: 'is-blue',
      title: 'Felix · 园区管理员',
      meta: '同事消息 · 刚刚',
      preview: '会议室预约已经确认，下午 14:00 在中会议室见。',
      targetId: 'felix',
      unread: true,
      handled: false,
    },
    {
      id: 'park-announcement',
      kind: 'announcement',
      icon: '公',
      iconClass: 'is-green',
      title: '北控宏创科技园',
      meta: '园区公告 · 10 分钟前',
      preview: '本周五 14:00–18:00 进行例行停水检修，请提前安排用水。',
      targetId: 'park-water-0729',
      unread: true,
      handled: false,
    },
    {
      id: 'park-survey',
      kind: 'survey',
      icon: '评',
      iconClass: 'is-green',
      title: '第三季度园区服务满意度调查',
      meta: '满意度调查 · 今天 09:30',
      preview: '请对客服响应、物业维修、园区网络和会议室服务进行实名评价。',
      targetId: 'park-survey-q3',
      unread: true,
      handled: false,
    },
    {
      id: 'service-update',
      kind: 'service',
      icon: '修',
      iconClass: 'is-purple',
      title: '物业报修 · 处理进度',
      meta: '服务通知 · 昨天',
      preview: '会议室灯具报修已由客服部受理，并转交维修工作人员处理。',
      targetId: 'HC20260728001',
      unread: true,
      handled: false,
    },
  ];

  function inboxMessage(messageId) {
    return INBOX_MESSAGES.find(function (message) {
      return message.id === messageId;
    }) || null;
  }

  function inboxActionLabel(message) {
    if (message.kind === 'colleague') return '打开聊天';
    if (message.kind === 'announcement') return '查看园区通知';
    if (message.kind === 'survey') return message.handled ? '查看已提交问卷' : '填写调查问卷';
    return '查看处理进度';
  }

  function inboxCardHtml(message) {
    return '<button type="button" class="otto-preview-message-card' +
      (message.id === selectedInboxMessageId ? ' is-selected' : '') +
      '" data-uiux-message-id="' + escapeHtml(message.id) + '">' +
      '<span class="otto-preview-message-icon ' + message.iconClass + '">' +
      escapeHtml(message.icon) + '</span>' +
      '<span class="otto-preview-message-copy"><strong>' + escapeHtml(message.title) +
      '</strong><small>' + escapeHtml(message.meta) + '</small><span>' +
      escapeHtml(message.preview) + '</span></span>' +
      (message.unread ? '<span class="otto-preview-unread" aria-label="未读"></span>' : '') +
      '</button>';
  }

  function inboxStateKey() {
    return INBOX_MESSAGES.map(function (message) {
      return [message.id, message.unread, message.handled].join(':');
    }).join('|');
  }

  function renderInboxDetail() {
    var overlay = $('.otto-preview-overlay');
    if (!overlay) return;
    var detail = $('.otto-preview-message-detail', overlay);
    var message = inboxMessage(selectedInboxMessageId) || INBOX_MESSAGES[0];
    if (!detail || !message) return;
    detail.innerHTML =
      '<small>' + escapeHtml(message.meta) + '</small>' +
      '<h3>' + escapeHtml(message.title) + '</h3>' +
      '<p>' + escapeHtml(message.preview) + '</p>' +
      '<div class="otto-uiux-inbox-actions">' +
      '<button type="button" data-inbox-open="' + escapeHtml(message.id) + '">' +
      escapeHtml(inboxActionLabel(message)) + '</button>' +
      (message.unread
        ? '<button type="button" class="is-secondary" data-inbox-read="' +
          escapeHtml(message.id) + '">标记为已读</button>'
        : '<span>已读</span>') + '</div>';
  }

  function upgradeInboxMessages() {
    var overlay = $('.otto-preview-overlay');
    if (!overlay) return;
    var list = $('.otto-preview-message-list', overlay);
    var filters = $('.otto-preview-filters', overlay);
    if (!list || !filters) return;
    if (!inboxMessage(selectedInboxMessageId)) selectedInboxMessageId = INBOX_MESSAGES[0].id;
    var stateKey = inboxStateKey() + ':' + selectedInboxMessageId;
    if (list.getAttribute('data-uiux-inbox-state') !== stateKey) {
      list.innerHTML = INBOX_MESSAGES.map(inboxCardHtml).join('');
      list.setAttribute('data-uiux-inbox-state', stateKey);
    }
    var filterButtons = $$('button', filters);
    var unreadCount = INBOX_MESSAGES.filter(function (message) { return message.unread; }).length;
    var handledCount = INBOX_MESSAGES.filter(function (message) { return message.handled; }).length;
    if (filterButtons[0]) filterButtons[0].innerHTML = '全部 <b>' + INBOX_MESSAGES.length + '</b>';
    if (filterButtons[1]) filterButtons[1].innerHTML = '未读 <b>' + unreadCount + '</b>';
    if (filterButtons[2]) filterButtons[2].innerHTML = '已处理 <b>' + handledCount + '</b>';
    renderInboxDetail();
  }

  function openInboxMessage(messageId) {
    var message = inboxMessage(messageId);
    if (!message) return;
    message.unread = false;
    message.handled = true;
    selectedInboxMessageId = message.id;
    if (message.kind === 'announcement') {
      var announcement = parkPublication(message.targetId);
      if (announcement) announcement.unread = false;
      openParkServices('announcement', message.targetId);
      return;
    }
    if (message.kind === 'survey') {
      openParkServices('survey', message.targetId);
      return;
    }
    if (message.kind === 'service') {
      openParkServices('application-detail', message.targetId);
      return;
    }
    closePreviewOverlay();
    openOrganizationPage();
    openDirectChat(message.targetId);
  }

  document.addEventListener('click', function (event) {
    var card = event.target.closest ? event.target.closest('[data-uiux-message-id]') : null;
    if (card) {
      event.preventDefault();
      event.stopPropagation();
      selectedInboxMessageId = card.getAttribute('data-uiux-message-id');
      upgradeInboxMessages();
      applyInboxFilter();
      return;
    }
    var openButton = event.target.closest ? event.target.closest('[data-inbox-open]') : null;
    if (openButton) {
      event.preventDefault();
      event.stopPropagation();
      openInboxMessage(openButton.getAttribute('data-inbox-open'));
      return;
    }
    var readButton = event.target.closest ? event.target.closest('[data-inbox-read]') : null;
    if (!readButton) return;
    event.preventDefault();
    event.stopPropagation();
    var message = inboxMessage(readButton.getAttribute('data-inbox-read'));
    if (message) {
      message.unread = false;
      message.handled = true;
    }
    upgradeInboxMessages();
    applyInboxFilter();
  }, true);

  function applyInboxFilter() {
    var overlay = $('.otto-preview-overlay');
    if (!overlay) return;
    upgradeInboxMessages();
    var filters = $('.otto-preview-filters', overlay);
    if (!filters) return;
    $$('button', filters).forEach(function (b) {
      var label = b.textContent.replace(/\d+/g, '').trim();
      b.classList.toggle('is-active', label.indexOf(inboxMode) === 0);
    });
    $$('.otto-preview-message-card', overlay).forEach(function (card) {
      var message = inboxMessage(card.getAttribute('data-uiux-message-id'));
      var show = inboxMode === '全部' ||
        (inboxMode === '未读' && message && message.unread) ||
        (inboxMode === '已处理' && message && message.handled);
      card.style.display = show ? '' : 'none';
    });
  }

  document.addEventListener('click', function (e) {
    var btn = e.target.closest ? e.target.closest('.otto-preview-filters button') : null;
    if (!btn) return;
    inboxMode = btn.textContent.replace(/\d+/g, '').trim();
    applyInboxFilter();
  });

  /* ──────────────────────── 园区服务：恢复专家栏原生入口 ──────────────────────── */

  var parkEntryOpen = true;
  var parkEl = null;
  var parkWindowMode = 'normal';
  var parkRoute = { name: 'home', id: null };
  var parkApplicationSequence = 2;

  var PARK_SERVICES = [
    { id: 'announcement', icon: '公', name: '园区公告', desc: '培训通知与全园区推送' },
    { id: 'satisfaction', icon: '评', name: '满意度调查', desc: '实名问卷与改进反馈' },
    { id: 'renovation', icon: '装', name: '装修管理', desc: '提交装修申请至客服部' },
    { id: 'parking', icon: '停', name: '停车办理', desc: '停车位申请、续办与退办' },
    { id: 'network-phone', icon: '网', name: '网络与电话', desc: '宽带、固话开通与调试' },
    { id: 'meeting-room', icon: '会', name: '会议室预约', desc: '按人数、日期和时段预约' },
    { id: 'electric-card', icon: '电', name: '电卡服务', desc: '按充电度数办理电卡服务' },
    { id: 'repair', icon: '修', name: '物业报修', desc: '客服受理、转交与上门维修' },
    { id: 'vehicle-visit', icon: '访', name: '车辆与访客', desc: '访客日期与车辆预约登记' },
  ];

  var PARK_SERVICE_FIELDS = {
    renovation: [
      { key: 'area', label: '装修区域', placeholder: '例如：A 座 1203 室' },
      { key: 'startDate', label: '计划开工日期', type: 'date' },
      { key: 'description', label: '施工内容', placeholder: '请简要说明施工范围', type: 'textarea' },
    ],
    parking: [
      { key: 'applicationType', label: '申请内容', options: ['地下固定停车位', '地上临时停车位', '停车位续办', '退停车位'] },
      { key: 'quantity', label: '申请数量', type: 'number', placeholder: '请输入数量' },
      { key: 'plate', label: '车辆牌照', placeholder: '例如：京 A·12345' },
    ],
    'network-phone': [
      { key: 'businessType', label: '业务类型', options: ['企业专线', '办公宽带', '固话开通', '故障调试'] },
      { key: 'quantity', label: '工位或号码数量', type: 'number', placeholder: '请输入数量' },
      { key: 'expectedDate', label: '期望开通日期', type: 'date' },
    ],
    'meeting-room': [
      { key: 'roomName', label: '会议室名称', options: ['中会议室（30 人）', '大会议室（50 人）', '报告厅（80 人）'] },
      { key: 'meetingDate', label: '使用日期', type: 'date' },
      { key: 'startTime', label: '开始时间', type: 'time' },
      { key: 'endTime', label: '结束时间', type: 'time' },
      { key: 'attendees', label: '参会人数', type: 'number', placeholder: '请输入人数' },
      { key: 'meetingContent', label: '会议内容', type: 'textarea', placeholder: '请简要填写会议主题' },
    ],
    'electric-card': [
      { key: 'cardNumber', label: '电卡编号', placeholder: '请输入电卡编号' },
      { key: 'chargingKwh', label: '充电度数', type: 'number', placeholder: '1.2 元/度' },
    ],
    repair: [
      { key: 'category', label: '报修类别', options: ['灯具维修', '配电维修', '暖通维修', '网络、电话故障维修', '其他'] },
      { key: 'issue', label: '故障描述', type: 'textarea', placeholder: '请说明现场问题' },
      { key: 'urgency', label: '紧急程度', options: ['普通', '紧急', '影响办公'] },
    ],
    'vehicle-visit': [
      { key: 'visitDate', label: '来访日期', type: 'date' },
      { key: 'visitTime', label: '具体来访时间', type: 'time' },
      { key: 'reason', label: '拜访企业及事由', type: 'textarea', placeholder: '请填写拜访对象和事由' },
      { key: 'vehicleCount', label: '来访车辆数量', type: 'number', placeholder: '无车辆可填写 0' },
      { key: 'plate', label: '车牌号', placeholder: '多辆车请用顿号分隔' },
    ],
  };

  var PARK_PUBLICATIONS = [
    {
      id: 'park-water-0729',
      kind: 'announcement',
      title: '本周五园区停水检修通知',
      body: '本周五 14:00–18:00 将进行例行停水检修，请各企业提前安排用水。恢复供水后如有异常，请通过物业报修提交工单。',
      time: '10 分钟前',
      unread: true,
    },
    {
      id: 'park-survey-q3',
      kind: 'satisfaction',
      title: '第三季度园区服务满意度调查',
      body: '请对本季度客服响应、物业维修、园区网络和会议室服务进行实名评价。',
      time: '今天 09:30',
      unread: true,
      submitted: false,
    },
  ];

  var PARK_APPLICATIONS = [
    {
      id: 'HC20260728001',
      serviceId: 'repair',
      title: '会议室灯具报修',
      status: '已转交',
      updated: '昨天 16:20',
      description: '中会议室靠窗侧灯具无法点亮，已影响下午会议使用。',
      history: [
        { time: '昨天 14:06', title: '申请已提交', detail: '本地测试用户提交物业报修。' },
        { time: '昨天 14:18', title: '客服部已受理', detail: '已确认故障位置和可上门时段。' },
        { time: '昨天 16:20', title: '已转交维修人员', detail: '王工将在今天 10:00 前往现场处理。' },
      ],
    },
  ];

  function parkService(serviceId) {
    return PARK_SERVICES.find(function (service) { return service.id === serviceId; }) || null;
  }

  function parkPublication(publicationId) {
    return PARK_PUBLICATIONS.find(function (publication) {
      return publication.id === publicationId;
    }) || null;
  }

  function parkApplication(applicationId) {
    return PARK_APPLICATIONS.find(function (application) {
      return application.id === applicationId;
    }) || null;
  }

  function setInboxMessageRead(messageId, handled) {
    var message = INBOX_MESSAGES.find(function (candidate) {
      return candidate.id === messageId;
    });
    if (!message) return;
    message.unread = false;
    if (handled) message.handled = true;
  }

  function parkHeaderCopy() {
    if (parkRoute.name === 'announcement') {
      return { title: '园区公告', subtitle: '查看园区发布的最新通知和历史公告。' };
    }
    if (parkRoute.name === 'survey') {
      return { title: '满意度调查', subtitle: '实名填写园区问卷，提交后不能修改。' };
    }
    if (parkRoute.name === 'application') {
      var service = parkService(parkRoute.id);
      return {
        title: service ? service.name : '园区服务申请',
        subtitle: service && service.id === 'repair'
          ? '提交报修、查看进度，并确认最终维修结果。'
          : '提交申请后，可在这里查看受理进度和办理结果。',
      };
    }
    if (parkRoute.name === 'application-detail') {
      return { title: '服务处理进度', subtitle: '查看申请内容与完整办理记录。' };
    }
    return { title: '北控宏创园区服务', subtitle: '选择需要办理的园区服务。' };
  }

  function parkServiceCardHtml(service) {
    return '<button type="button" class="otto-enhance-park__service" data-park-service="' +
      escapeHtml(service.id) + '">' +
      '<span class="otto-enhance-park__service-icon" aria-hidden="true">' +
      escapeHtml(service.icon) + '</span>' +
      '<span><strong>' + escapeHtml(service.name) + '</strong><small>' +
      escapeHtml(service.desc) + '</small></span></button>';
  }

  function parkPendingHtml() {
    var survey = parkPublication('park-survey-q3');
    var announcement = parkPublication('park-water-0729');
    var application = PARK_APPLICATIONS[0];
    return '<section class="otto-enhance-park__activity-section">' +
      '<header><strong>待处理消息</strong><span>' +
      String([survey && !survey.submitted, announcement && announcement.unread].filter(Boolean).length) +
      ' 项</span></header>' +
      '<button type="button" data-park-publication="park-survey-q3"><span>满意度调查</span>' +
      '<strong>' + escapeHtml(survey.title) + '</strong><small>' +
      (survey.submitted ? '已提交' : '待填写 · 点击进入') + '</small></button>' +
      '<button type="button" data-park-publication="park-water-0729"><span>园区公告</span>' +
      '<strong>' + escapeHtml(announcement.title) + '</strong><small>' +
      (announcement.unread ? '未读 · 点击查看' : '已查看') + '</small></button>' +
      '<button type="button" data-park-application="' + escapeHtml(application.id) + '">' +
      '<span>物业报修</span><strong>' + escapeHtml(application.title) + '</strong><small>' +
      escapeHtml(application.status + ' · ' + application.updated) + '</small></button></section>';
  }

  function parkApplicationsHtml() {
    return '<section class="otto-enhance-park__activity-section">' +
      '<header><strong>我的申请</strong><span>' + PARK_APPLICATIONS.length + ' 条</span></header>' +
      PARK_APPLICATIONS.map(function (application) {
        var service = parkService(application.serviceId);
        return '<button type="button" data-park-application="' + escapeHtml(application.id) + '">' +
          '<span>' + escapeHtml(service ? service.name : '园区服务') + '</span>' +
          '<strong>' + escapeHtml(application.id + ' · ' + application.title) + '</strong>' +
          '<small>' + escapeHtml(application.status + ' · ' + application.updated) + '</small></button>';
      }).join('') + '</section>';
  }

  function renderParkHome() {
    return '<div class="otto-enhance-park__home">' +
      '<section class="otto-enhance-park__services" aria-label="园区服务列表">' +
      '<header><div><strong>园区服务</strong><span>9 项服务统一入口</span></div>' +
      '<small>北控宏创科技园</small></header>' +
      '<div class="otto-enhance-park__grid">' +
      PARK_SERVICES.map(parkServiceCardHtml).join('') + '</div></section>' +
      '<aside class="otto-enhance-park__activity" aria-label="园区待办与历史">' +
      parkPendingHtml() + parkApplicationsHtml() + '</aside></div>';
  }

  function renderParkAnnouncement() {
    var announcements = PARK_PUBLICATIONS.filter(function (publication) {
      return publication.kind === 'announcement';
    });
    var selected = parkPublication(parkRoute.id) || announcements[0];
    if (selected) {
      selected.unread = false;
      setInboxMessageRead('park-announcement', true);
    }
    return '<div class="otto-enhance-park__content">' +
      '<button type="button" class="otto-enhance-park__back" data-park-home>← 返回服务列表</button>' +
      '<div class="otto-enhance-park__publication-layout">' +
      '<nav aria-label="公告列表">' + announcements.map(function (publication) {
        return '<button type="button" data-park-publication="' + escapeHtml(publication.id) + '"' +
          (publication.id === selected.id ? ' class="is-active"' : '') + '>' +
          '<strong>' + escapeHtml(publication.title) + '</strong><small>' +
          escapeHtml(publication.time) + '</small></button>';
      }).join('') + '</nav>' +
      '<article class="otto-enhance-park__publication-detail"><span>已查看</span>' +
      '<h3>' + escapeHtml(selected.title) + '</h3><p>' + escapeHtml(selected.body) + '</p>' +
      '<small>北控宏创科技园 · ' + escapeHtml(selected.time) + '</small></article></div></div>';
  }

  function parkCommonFieldsHtml() {
    return '<label>公司名称<input name="company" required value="北控宏创科技园"></label>' +
      '<label>房间号<input name="roomNumber" required value="A 座 1203 室"></label>' +
      '<label>联系人<input name="contact" required value="本地测试用户"></label>' +
      '<label>联系电话<input name="phone" required value="13800000000"></label>';
  }

  function parkFieldHtml(field) {
    var placeholder = field.placeholder ? ' placeholder="' + escapeHtml(field.placeholder) + '"' : '';
    if (field.options) {
      return '<label>' + escapeHtml(field.label) + '<select name="' + escapeHtml(field.key) +
        '" required><option value="">请选择</option>' + field.options.map(function (option) {
          return '<option>' + escapeHtml(option) + '</option>';
        }).join('') + '</select></label>';
    }
    if (field.type === 'textarea') {
      return '<label class="is-wide">' + escapeHtml(field.label) + '<textarea name="' +
        escapeHtml(field.key) + '" rows="3" required' + placeholder + '></textarea></label>';
    }
    return '<label>' + escapeHtml(field.label) + '<input name="' + escapeHtml(field.key) +
      '" type="' + escapeHtml(field.type || 'text') + '" required' + placeholder +
      (field.type === 'number' ? ' min="0"' : '') + '></label>';
  }

  function renderParkApplicationForm(serviceId) {
    var service = parkService(serviceId);
    var fields = PARK_SERVICE_FIELDS[serviceId] || [];
    return '<div class="otto-enhance-park__content">' +
      '<button type="button" class="otto-enhance-park__back" data-park-home>← 返回服务列表</button>' +
      '<section class="otto-enhance-park__form-shell">' +
      '<div class="otto-enhance-park__form-guide"><strong>' + escapeHtml(service.name) + '</strong>' +
      '<span>' + escapeHtml(service.desc) + '；提交后由对应园区岗位受理。</span></div>' +
      '<form class="otto-enhance-park__form" data-park-form="' + escapeHtml(service.id) + '">' +
      '<div class="otto-enhance-park__form-grid">' + parkCommonFieldsHtml() +
      fields.map(parkFieldHtml).join('') + '</div>' +
      '<div class="otto-enhance-park__form-error" role="alert"></div>' +
      '<button type="submit" class="otto-enhance-park__primary">提交' +
      escapeHtml(service.name) + '申请</button></form></section></div>';
  }

  function renderParkSurvey() {
    var survey = parkPublication(parkRoute.id) || parkPublication('park-survey-q3');
    if (!survey) return '';
    var disabled = survey.submitted ? ' disabled' : '';
    return '<div class="otto-enhance-park__content">' +
      '<button type="button" class="otto-enhance-park__back" data-park-home>← 返回服务列表</button>' +
      '<form class="otto-enhance-park__survey" data-park-survey="' + escapeHtml(survey.id) + '">' +
      '<div class="otto-enhance-park__survey-status">' +
      (survey.submitted ? '已实名提交' : '待填写') + '</div>' +
      '<h3>' + escapeHtml(survey.title) + '</h3><p>' + escapeHtml(survey.body) + '</p>' +
      '<div class="otto-enhance-park__form-grid">' +
      '<label>公司名称<input required value="北控宏创科技园"' + disabled + '></label>' +
      '<label>园区地址<input required value="科技大厦 A 座"' + disabled + '></label>' +
      '<label>房间号<input required value="1203 室"' + disabled + '></label>' +
      '<label>提交人<input required value="本地测试用户"' + disabled + '></label>' +
      '<label>联系电话<input required value="13800000000"' + disabled + '></label>' +
      '<label>总体满意度<select required' + disabled + '>' +
      '<option>5 分 · 非常满意</option><option>4 分 · 满意</option><option>3 分 · 一般</option>' +
      '<option>2 分 · 待改进</option><option>1 分 · 不满意</option></select></label>' +
      '<label class="is-wide">重点关注<input required placeholder="例如：网络响应、会议室环境"' +
      (survey.submitted ? ' value="客服响应与维修时效"' : '') + disabled + '></label>' +
      '<label class="is-wide">改进建议<textarea required rows="4" placeholder="请填写具体建议"' +
      disabled + '>' + (survey.submitted ? '希望继续缩短紧急报修的响应时间。' : '') +
      '</textarea></label></div>' +
      '<button type="submit" class="otto-enhance-park__primary"' + disabled + '>' +
      (survey.submitted ? '已实名提交，不能修改' : '提交问卷') + '</button></form></div>';
  }

  function renderParkApplicationDetail(applicationId) {
    var application = parkApplication(applicationId);
    if (!application) return '';
    if (applicationId === 'HC20260728001') setInboxMessageRead('service-update', true);
    return '<div class="otto-enhance-park__content">' +
      '<button type="button" class="otto-enhance-park__back" data-park-home>← 返回服务列表</button>' +
      '<article class="otto-enhance-park__application-detail">' +
      '<header><div><span>申请编号</span><strong>' + escapeHtml(application.id) + '</strong></div>' +
      '<em>' + escapeHtml(application.status) + '</em></header>' +
      '<div class="otto-enhance-park__application-summary"><div><span>服务类型</span><strong>' +
      escapeHtml((parkService(application.serviceId) || {}).name || '园区服务') + '</strong></div>' +
      '<div><span>最近更新</span><strong>' + escapeHtml(application.updated) + '</strong></div>' +
      '<div class="is-wide"><span>申请内容</span><strong>' +
      escapeHtml(application.description) + '</strong></div></div>' +
      '<section class="otto-enhance-park__timeline"><header><strong>处理记录</strong><span>' +
      application.history.length + ' 条</span></header><ol>' +
      application.history.map(function (item) {
        return '<li><i></i><div><time>' + escapeHtml(item.time) + '</time><strong>' +
          escapeHtml(item.title) + '</strong><p>' + escapeHtml(item.detail) + '</p></div></li>';
      }).join('') + '</ol></section></article></div>';
  }

  function renderPark() {
    if (!parkEl) return;
    var copy = parkHeaderCopy();
    $('.otto-enhance-park__title', parkEl).textContent = copy.title;
    $('.otto-enhance-park__subtitle', parkEl).textContent = copy.subtitle;
    var body = $('.otto-enhance-park__body', parkEl);
    if (parkRoute.name === 'announcement') body.innerHTML = renderParkAnnouncement();
    else if (parkRoute.name === 'survey') body.innerHTML = renderParkSurvey();
    else if (parkRoute.name === 'application') body.innerHTML = renderParkApplicationForm(parkRoute.id);
    else if (parkRoute.name === 'application-detail') body.innerHTML = renderParkApplicationDetail(parkRoute.id);
    else body.innerHTML = renderParkHome();
    parkEl.classList.toggle('is-minimized', parkWindowMode === 'minimized');
    parkEl.classList.toggle('is-maximized', parkWindowMode === 'maximized');
    var minimizeButton = $('[data-park-window="minimize"]', parkEl);
    var maximizeButton = $('[data-park-window="maximize"]', parkEl);
    if (minimizeButton) {
      var minimized = parkWindowMode === 'minimized';
      minimizeButton.textContent = minimized ? '+' : '−';
      minimizeButton.setAttribute('aria-label', minimized
        ? '还原园区服务窗口'
        : '最小化园区服务窗口');
      minimizeButton.setAttribute('title', minimized ? '还原' : '最小化');
    }
    if (maximizeButton) {
      var maximized = parkWindowMode === 'maximized';
      maximizeButton.textContent = maximized ? '❐' : '□';
      maximizeButton.setAttribute('aria-label', maximized
        ? '还原园区服务窗口'
        : '最大化园区服务窗口');
      maximizeButton.setAttribute('title', maximized ? '还原' : '最大化');
    }
    upgradeInboxMessages();
    setTimeout(attachParkFormHandlers, 0);
  }

  function buildParkWindow() {
    var el = document.createElement('div');
    el.className = 'otto-enhance-park';
    el.innerHTML =
      '<section class="otto-enhance-park__dialog" role="dialog" aria-modal="true" ' +
      'aria-label="北控宏创园区服务">' +
      '<header class="otto-enhance-park__header"><span class="otto-enhance-park__brandicon" aria-hidden="true">园</span>' +
      '<div><h2 class="otto-enhance-park__title"></h2><p class="otto-enhance-park__subtitle"></p></div>' +
      '<nav aria-label="园区服务窗口操作">' +
      '<button type="button" data-park-window="minimize" aria-label="最小化园区服务窗口" title="最小化">−</button>' +
      '<button type="button" data-park-window="maximize" aria-label="最大化园区服务窗口" title="最大化">□</button>' +
      '<button type="button" data-park-window="close" aria-label="关闭园区服务窗口" title="关闭">×</button>' +
      '</nav></header><main class="otto-enhance-park__body"></main></section>';
    el.addEventListener('click', function (event) {
      if (event.target === el && parkWindowMode !== 'minimized') {
        closeParkServices();
        return;
      }
      var windowAction = event.target.closest ? event.target.closest('[data-park-window]') : null;
      if (windowAction) {
        var action = windowAction.getAttribute('data-park-window');
        if (action === 'close') closeParkServices();
        if (action === 'minimize') {
          parkWindowMode = parkWindowMode === 'minimized' ? 'normal' : 'minimized';
          renderPark();
        }
        if (action === 'maximize') {
          parkWindowMode = parkWindowMode === 'maximized' ? 'normal' : 'maximized';
          renderPark();
        }
        return;
      }
      var home = event.target.closest ? event.target.closest('[data-park-home]') : null;
      if (home) {
        parkRoute = { name: 'home', id: null };
        renderPark();
        return;
      }
      var serviceButton = event.target.closest ? event.target.closest('[data-park-service]') : null;
      if (serviceButton) {
        var serviceId = serviceButton.getAttribute('data-park-service');
        if (serviceId === 'announcement') parkRoute = { name: 'announcement', id: 'park-water-0729' };
        else if (serviceId === 'satisfaction') parkRoute = { name: 'survey', id: 'park-survey-q3' };
        else parkRoute = { name: 'application', id: serviceId };
        renderPark();
        return;
      }
      var publicationButton = event.target.closest
        ? event.target.closest('[data-park-publication]') : null;
      if (publicationButton) {
        var publicationId = publicationButton.getAttribute('data-park-publication');
        var publication = parkPublication(publicationId);
        parkRoute = {
          name: publication && publication.kind === 'satisfaction' ? 'survey' : 'announcement',
          id: publicationId,
        };
        renderPark();
        return;
      }
      var applicationButton = event.target.closest
        ? event.target.closest('[data-park-application]') : null;
      if (applicationButton) {
        parkRoute = {
          name: 'application-detail',
          id: applicationButton.getAttribute('data-park-application'),
        };
        renderPark();
      }
    });
    return el;
  }

  function attachParkFormHandlers() {
    if (!parkEl) return;
    var applicationForm = $('[data-park-form]', parkEl);
    if (applicationForm && !applicationForm.getAttribute('data-handler-ready')) {
      applicationForm.setAttribute('data-handler-ready', 'true');
      applicationForm.addEventListener('submit', function (event) {
        event.preventDefault();
        var formData = new FormData(applicationForm);
        var serviceId = applicationForm.getAttribute('data-park-form');
        var error = $('.otto-enhance-park__form-error', applicationForm);
        if (serviceId === 'meeting-room' &&
            String(formData.get('startTime')) >= String(formData.get('endTime'))) {
          error.textContent = '结束时间必须晚于开始时间。';
          return;
        }
        parkApplicationSequence += 1;
        var now = new Date();
        var applicationId = now.toISOString().slice(0, 10).replace(/-/g, '') +
          String(parkApplicationSequence).padStart(3, '0');
        var service = parkService(serviceId);
        var detail = String(formData.get('issue') || formData.get('meetingContent') ||
          formData.get('description') || formData.get('reason') || service.desc);
        var application = {
          id: applicationId,
          serviceId: serviceId,
          title: service.name + '申请',
          status: serviceId === 'repair' ? '待接单' : '待派单',
          updated: '刚刚',
          description: detail,
          history: [{
            time: currentDirectMessageTime(),
            title: '申请已提交',
            detail: '本地测试用户提交' + service.name + '申请，等待园区岗位受理。',
          }],
        };
        PARK_APPLICATIONS.unshift(application);
        parkRoute = { name: 'application-detail', id: application.id };
        renderPark();
      });
    }
    var surveyForm = $('[data-park-survey]', parkEl);
    if (surveyForm && !surveyForm.getAttribute('data-handler-ready')) {
      surveyForm.setAttribute('data-handler-ready', 'true');
      surveyForm.addEventListener('submit', function (event) {
        event.preventDefault();
        var survey = parkPublication(surveyForm.getAttribute('data-park-survey'));
        if (!survey || survey.submitted) return;
        survey.submitted = true;
        survey.unread = false;
        setInboxMessageRead('park-survey', true);
        renderPark();
      });
    }
  }

  function openParkServices(routeName, routeId) {
    closePreviewOverlay();
    if (!parkEl) {
      parkEl = buildParkWindow();
      document.body.appendChild(parkEl);
    }
    parkWindowMode = 'normal';
    parkRoute = { name: routeName || 'home', id: routeId || null };
    renderPark();
    attachParkFormHandlers();
    setTimeout(attachParkFormHandlers, 0);
  }

  function closeParkServices() {
    if (!parkEl) return;
    parkEl.remove();
    parkEl = null;
    parkWindowMode = 'normal';
  }

  function applyParkServiceEntry() {
    var body = $('.otto-right-panel__body');
    if (!body || $('.otto-uiux-park-entry', body)) return;
    var developmentHead = $$('.otto-right-panel__grouphead', body).find(function (button) {
      return button.textContent.indexOf('开发 AI 智能体') !== -1;
    });
    if (!developmentHead) return;

    var entry = document.createElement('section');
    entry.className = 'otto-uiux-park-entry';
    entry.setAttribute('aria-label', '园区服务入口');
    entry.innerHTML =
      '<button type="button" class="otto-right-panel__grouphead otto-uiux-park-entry__toggle" aria-expanded="true">' +
      '<span>园区服务</span><span class="otto-uiux-park-entry__chevron" aria-hidden="true">⌄</span></button>' +
      '<div class="otto-expert-list otto-uiux-park-entry__list">' +
      '<button type="button" class="otto-expert-card otto-uiux-park-entry__card" ' +
      'title="装修管理 · 满意度调查 · 园区公告 · 停车位办理 · 网络与电话 · 会议室预约 · 电卡充电 · 物业报修 · 车辆与访客">' +
      '<span class="otto-expert-card__icon otto-expert-card__icon--dev" aria-hidden="true"></span>' +
      '<span class="otto-expert-card__body"><span class="otto-expert-card__name">北控宏创园区服务</span>' +
      '<span class="otto-expert-card__desc">装修 · 公告 · 停车 · 网络 · 会议 · 报修</span></span></button></div>';
    entry.classList.toggle('is-collapsed', !parkEntryOpen);
    $('.otto-uiux-park-entry__toggle', entry)
      .setAttribute('aria-expanded', String(parkEntryOpen));

    var parent = developmentHead.parentElement;
    if (!parent) return;
    var separator = developmentHead.previousElementSibling;
    if (separator && separator.getAttribute('role') === 'separator') {
      parent.insertBefore(entry, separator);
    } else {
      parent.insertBefore(entry, developmentHead);
    }

    var iconHost = $('.otto-expert-card__icon', entry);
    var sourceIcon = $('[data-uiux-nav="organization"] svg');
    if (iconHost && sourceIcon) iconHost.appendChild(sourceIcon.cloneNode(true));

    $('.otto-uiux-park-entry__toggle', entry).addEventListener('click', function () {
      parkEntryOpen = !parkEntryOpen;
      entry.classList.toggle('is-collapsed', !parkEntryOpen);
      $('.otto-uiux-park-entry__toggle', entry).setAttribute('aria-expanded', String(parkEntryOpen));
    });
    $('.otto-uiux-park-entry__card', entry).addEventListener('click', function () {
      openParkServices('home');
    });
  }

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

  function applyTerminology() {
    $$('[aria-label="设置与诊断中心"]').forEach(function (element) {
      element.setAttribute('aria-label', '设置');
    });
  }

  /* ──────────────────────── 首次打开三步导览 ──────────────────────── */

  var TOUR_KEY = 'otto.uiux.tour.v1.done';
  var tourState = { active: false, step: 0, el: null };

  var TOUR_STEPS = [
    {
      selector: '.otto-sidebar',
      title: '左侧：导航与工作区',
      body: '五个主入口依次是工作台、组织架构、我的消息、我的工作和设置。组织架构会直接展示组织全貌；历史会话和“查看全部”统一收在会话区。',
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

  /* ──────────────────────── 选择项目条（空态首页，输入卡下方；mock） ──────────────────────── */

  var PROJECT_KEY = 'otto.uiux.project.v1';
  var projectBarEl = null;
  var projectMenuEl = null;
  var currentProject = null;
  var PROJECTS = [
    { name: '园区服务本地演示', meta: '当前' },
    { name: '数据导出工具', meta: '最近协作' },
    { name: '官网前端改版', meta: '上周' },
  ];
  try {
    currentProject = JSON.parse(localStorage.getItem(PROJECT_KEY) || 'null');
  } catch (err) { /* ignore */ }

  var FOLDER_SVG = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">' +
    '<path d="M2 4.5A1.5 1.5 0 0 1 3.5 3h2.6a1.5 1.5 0 0 1 1.06.44l.98.98c.28.28.66.44 1.06.44h3.3A1.5 1.5 0 0 1 14 6.36v5.14a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 11.5v-7Z" ' +
    'stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/></svg>';

  function projectBarLabel() {
    return currentProject || '选择项目';
  }

  function closeProjectMenu() {
    if (projectMenuEl) { projectMenuEl.remove(); projectMenuEl = null; }
  }

  function toggleProjectMenu() {
    if (projectMenuEl) { closeProjectMenu(); return; }
    projectMenuEl = document.createElement('div');
    projectMenuEl.className = 'otto-uiux-projectbar__menu';
    // 不强制选择：提供「不关联项目」用于清除已选
    var clearItem = '<button type="button" data-project=""' +
      (!currentProject ? ' class="is-active"' : '') + '>' +
      FOLDER_SVG + '<span>不关联项目</span><small>可随时选择</small></button>';
    projectMenuEl.innerHTML = clearItem + PROJECTS.map(function (proj) {
      return '<button type="button" data-project="' + escapeHtml(proj.name) + '"' +
        (proj.name === currentProject ? ' class="is-active"' : '') + '>' +
        FOLDER_SVG + '<span>' + escapeHtml(proj.name) + '</span><small>' +
        escapeHtml(proj.meta) + '</small></button>';
    }).join('');
    projectMenuEl.addEventListener('click', function (event) {
      var btn = event.target.closest ? event.target.closest('[data-project]') : null;
      if (!btn) return;
      currentProject = btn.getAttribute('data-project') || null;
      try {
        if (currentProject) localStorage.setItem(PROJECT_KEY, JSON.stringify(currentProject));
        else localStorage.removeItem(PROJECT_KEY);
      } catch (err) { /* ignore */ }
      var label = $('.otto-uiux-projectbar__label', projectBarEl);
      if (label) label.textContent = projectBarLabel();
      closeProjectMenu();
    });
    projectBarEl.appendChild(projectMenuEl);
  }

  function buildProjectBar() {
    projectBarEl = document.createElement('div');
    projectBarEl.className = 'otto-uiux-projectbar';
    projectBarEl.innerHTML =
      '<button type="button" class="otto-uiux-projectbar__btn" aria-label="选择项目">' +
      FOLDER_SVG + '<span class="otto-uiux-projectbar__label">' + escapeHtml(projectBarLabel()) +
      '</span><span class="otto-uiux-projectbar__chev">▾</span></button>';
    $('.otto-uiux-projectbar__btn', projectBarEl).addEventListener('click', function (event) {
      event.stopPropagation();
      toggleProjectMenu();
    });
    document.body.appendChild(projectBarEl);
    // 点别处收起菜单
    document.addEventListener('click', function (event) {
      if (projectMenuEl && projectBarEl && !projectBarEl.contains(event.target)) closeProjectMenu();
    });
  }

  function syncProjectBar() {
    var empty = $('.otto-empty');
    var composer = $('.otto-composer');
    var show = !!(empty && composer);
    if (show && !projectBarEl) buildProjectBar();
    if (!projectBarEl) return;
    if (!show) {
      projectBarEl.style.display = 'none';
      closeProjectMenu();
      document.body.classList.remove('otto-uiux-has-projectbar');
      return;
    }
    var r = composer.getBoundingClientRect();
    projectBarEl.style.display = '';
    projectBarEl.style.top = (r.bottom - 12) + 'px';
    projectBarEl.style.left = (r.left + 14) + 'px';
    projectBarEl.style.width = (r.width - 28) + 'px';
    document.body.classList.add('otto-uiux-has-projectbar');
  }

  /* ──────────────────────── 头像账号菜单：设置入口收口到左下角 ────────────────────────
   * 用户卡整卡可点，弹出菜单：用量剩余（mock 展开）、
   * 设置（复用设置中心，CSS 全页化）、退出登录（转触发原有退出钮，逻辑不动）。 */
  var accountMenuEl = null;
  var accountBackdropEl = null;

  var ACCOUNT_ICONS = {
    usage: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M2.7 10.5a5.3 5.3 0 1 1 10.6 0"/><path d="M8 10.2l2.4-3"/></svg>',
    settings: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><circle cx="8" cy="8" r="2.1"/><path d="M8 2v1.7M8 12.3V14M2 8h1.7M12.3 8H14M3.8 3.8l1.2 1.2M11 11l1.2 1.2M12.2 3.8L11 5M5 11l-1.2 1.2"/></svg>',
    logout: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M6.2 2.8H4a1.2 1.2 0 0 0-1.2 1.2v8a1.2 1.2 0 0 0 1.2 1.2h2.2"/><path d="M10.4 5.2L13.2 8l-2.8 2.8M13 8H6.4"/></svg>',
  };

  function closeAccountMenu() {
    if (accountMenuEl) { accountMenuEl.remove(); accountMenuEl = null; }
    if (accountBackdropEl) { accountBackdropEl.remove(); accountBackdropEl = null; }
  }

  function onAccountMenuClick(e) {
    var item = e.target && e.target.closest ? e.target.closest('[data-am]') : null;
    if (!item || !accountMenuEl) return;
    var kind = item.getAttribute('data-am');
    if (kind === 'usage') {
      var panel = $('.otto-uiux-account-menu__usage', accountMenuEl);
      if (!panel) return;
      var open = panel.hasAttribute('hidden');
      if (open) panel.removeAttribute('hidden'); else panel.setAttribute('hidden', '');
      item.classList.toggle('is-open', open);
      return;
    }
    if (kind === 'settings') {
      closeAccountMenu();
      var hub = $('.otto-sidebar__footer .otto-viewall--hub');
      if (hub) hub.click();
      setTimeout(syncNavigationState, 80);
      return;
    }
    if (kind === 'logout') {
      closeAccountMenu();
      var logout = $('.otto-sidebar-account__logout');
      if (logout) logout.click();
    }
  }

  function openAccountMenu() {
    closeAccountMenu();
    var card = $('.otto-sidebar-account');
    if (!card) return;
    var rect = card.getBoundingClientRect();
    var avatarEl = $('.otto-sidebar-account__avatar', card);
    var nameEl = $('.otto-sidebar-account__copy strong', card);
    var orgEl = $('.otto-sidebar-account__copy small', card);
    var avatarText = avatarEl ? avatarEl.textContent.trim() : '用';
    var nameText = nameEl ? nameEl.textContent.trim() : '本地用户';
    var orgText = orgEl ? orgEl.textContent.trim() : '';

    accountBackdropEl = document.createElement('div');
    accountBackdropEl.className = 'otto-uiux-account-backdrop';
    accountBackdropEl.addEventListener('click', closeAccountMenu);
    document.body.appendChild(accountBackdropEl);

    accountMenuEl = document.createElement('div');
    accountMenuEl.className = 'otto-uiux-account-menu';
    accountMenuEl.setAttribute('role', 'menu');
    accountMenuEl.setAttribute('aria-label', '账号与设置');
    accountMenuEl.innerHTML =
      '<div class="otto-uiux-account-menu__head">' +
        '<span class="otto-uiux-account-menu__avatar"></span>' +
        '<span class="otto-uiux-account-menu__who">' +
          '<strong></strong>' +
          (orgText ? '<small></small>' : '') +
        '</span>' +
      '</div>' +
      '<div class="otto-uiux-account-menu__sep"></div>' +
      '<button type="button" class="otto-uiux-account-menu__item" data-am="usage">' +
        ACCOUNT_ICONS.usage +
        '<span class="otto-uiux-account-menu__label">用量剩余</span>' +
        '<span class="otto-uiux-account-menu__chev">›</span>' +
      '</button>' +
      '<div class="otto-uiux-account-menu__usage" hidden>' +
        '<div class="otto-uiux-account-menu__usage-row">' +
          '<span>对话消息</span><em>本月已用 128 条</em>' +
          '<div class="otto-uiux-account-menu__usage-bar"><i style="width:34%"></i></div>' +
        '</div>' +
        '<div class="otto-uiux-account-menu__usage-row">' +
          '<span>深度任务</span><em>3 / 10 次</em>' +
          '<div class="otto-uiux-account-menu__usage-bar"><i style="width:30%"></i></div>' +
        '</div>' +
        '<div class="otto-uiux-account-menu__usage-row">' +
          '<span>模型 Tokens</span><em>剩余 58%</em>' +
          '<div class="otto-uiux-account-menu__usage-bar"><i style="width:58%"></i></div>' +
        '</div>' +
        '<p class="otto-uiux-account-menu__usage-note">预览环境模拟数据，正式版读取真实用量。</p>' +
      '</div>' +
      '<button type="button" class="otto-uiux-account-menu__item" data-am="settings">' +
        ACCOUNT_ICONS.settings +
        '<span class="otto-uiux-account-menu__label">设置</span>' +
        '<span class="otto-uiux-account-menu__hint">⌘,</span>' +
      '</button>' +
      '<button type="button" class="otto-uiux-account-menu__item" data-am="logout">' +
        ACCOUNT_ICONS.logout +
        '<span class="otto-uiux-account-menu__label">退出登录</span>' +
      '</button>';
    $('.otto-uiux-account-menu__avatar', accountMenuEl).textContent = avatarText;
    $('.otto-uiux-account-menu__who strong', accountMenuEl).textContent = nameText;
    var orgSmall = $('.otto-uiux-account-menu__who small', accountMenuEl);
    if (orgSmall) orgSmall.textContent = orgText;

    document.body.appendChild(accountMenuEl);
    accountMenuEl.addEventListener('click', onAccountMenuClick);

    // 定位在用户卡正上方；窗口过矮时向上收，避免顶出屏幕
    var menuH = accountMenuEl.offsetHeight;
    var bottom = window.innerHeight - rect.top + 8;
    if (window.innerHeight - bottom - menuH < 8) bottom = window.innerHeight - menuH - 8;
    accountMenuEl.style.left = Math.max(8, rect.left - 4) + 'px';
    accountMenuEl.style.bottom = Math.max(8, bottom) + 'px';
  }

  /* ──────────────────────── 空态推荐问题：填入输入框（不自动发送）+ 浅灰选中态 ────────────────────────
   * React 原有点击会直接发送；capture 拦截后改为填入 textarea（native setter + input 事件，
   * 让 React 受控组件同步）。选中互斥；发送 / 切换会话后清除。 */
  function clearPromptSelection() {
    $$('.otto-prompt-chip.is-selected').forEach(function (chip) {
      chip.classList.remove('is-selected');
      chip.setAttribute('aria-pressed', 'false');
    });
  }

  function selectPromptChip(chip) {
    clearPromptSelection();
    chip.classList.add('is-selected');
    chip.setAttribute('aria-pressed', 'true');
    var textarea = $('.otto-composer__textarea');
    if (!textarea) return;
    var setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
    setter.call(textarea, chip.textContent.trim());
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    textarea.focus();
  }

  function applyPromptChips() {
    $$('.otto-prompt-chip').forEach(function (chip) {
      if (!chip.hasAttribute('aria-pressed')) chip.setAttribute('aria-pressed', 'false');
    });
  }

  // 键盘 Enter 发送后同样清掉选中态（capture 阶段记录，不影响 React 发送流程）
  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Enter' || e.shiftKey || e.isComposing) return;
    if (e.target && e.target.classList && e.target.classList.contains('otto-composer__textarea')) {
      clearPromptSelection();
    }
  }, true);

  /* ──────────────────────── 企业专家卡图标：统一为 inline SVG ────────────────────────
   * 原 PNG 刺绣图（GeneratedIcon）与文字首字占位统一替换为 24 视窗 outline SVG，
   * 图形复用 icons.tsx 既有设计（Agent/Search/File/Copy/CalendarCheck），缺位补语义图形。 */
  var PROFILE_ICON_SVGS = [
    ['企业工作', '<rect x="4" y="8" width="16" height="11" rx="3"/><path d="M12 4.5V8"/><circle cx="12" cy="4" r="1.1"/><path d="M9.2 13h.01M14.8 13h.01"/><path d="M2.5 12.5v3M21.5 12.5v3"/>'],
    ['PPT', '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M12 16v3M9 21h6"/><path d="m9.5 12 2-2 2 2 2.5-3"/>'],
    ['会议', '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M8 3v4M16 3v4M3 10h18"/><path d="m9 15.5 2 2 4-4"/>'],
    ['Word', '<path d="M14 3v5h5"/><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z"/><path d="M8 12h8M8 16h5"/>'],
    ['Excel', '<rect x="4" y="4" width="16" height="16" rx="2"/><path d="M4 10h16M4 15h16M10 4v16"/>'],
    ['PDF', '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>'],
    ['数据可视化', '<path d="M4 20V4"/><path d="M4 20h16"/><path d="M9 16v-5M13 16V8M17 16v-3"/>'],
    ['市场竞品', '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4.5 4.5"/>'],
    ['品牌营销', '<path d="M4 20l1-4L16.5 4.5a2.1 2.1 0 0 1 3 3L8 19l-4 1Z"/>'],
  ];

  function applyProfileIcons() {
    $$('.otto-profile-card').forEach(function (card) {
      if (card.getAttribute('data-uiux-icon') === '1') return;
      var text = card.textContent || '';
      var paths = null;
      for (var i = 0; i < PROFILE_ICON_SVGS.length; i++) {
        if (text.indexOf(PROFILE_ICON_SVGS[i][0]) !== -1) { paths = PROFILE_ICON_SVGS[i][1]; break; }
      }
      if (!paths) return;
      card.setAttribute('data-uiux-icon', '1');
      var holder = document.createElement('span');
      holder.className = 'otto-uiux-profile-icon';
      holder.setAttribute('aria-hidden', 'true');
      holder.innerHTML =
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" ' +
        'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + paths + '</svg>';
      var legacy = $('.otto-profile-card__mark', card) || $('img.otto-generated-icon', card);
      if (legacy) {
        legacy.style.display = 'none';
        legacy.setAttribute('aria-hidden', 'true');
        legacy.parentNode.insertBefore(holder, legacy);
      } else {
        card.insertBefore(holder, card.firstChild);
      }
    });
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
        applyNavigationLayout();
        applyConversationLayout();
        syncNavigationState();
        applyParkServiceEntry();
        applyExpertsCollapse();
        applyInboxFilter();
        applyTerminology();
        syncWorklogPosition();
        syncOrganizationPosition();
        syncProjectBar();
        applyPromptChips();
        applyProfileIcons();
      } catch (err) {
        console.warn(LOG, '重放增强异常', err);
      }
    }, 120);
  }

  function boot() {
    var root = document.getElementById('root');
    if (!root || !$('.otto-sidebar')) return false;
    try {
      applyNavigationLayout();
      applyConversationLayout();
      syncNavigationState();
      applyParkServiceEntry();
      applyExpertsCollapse();
      applyTerminology();
      syncProjectBar();
      applyPromptChips();
      applyProfileIcons();
      // 悬浮宠物已下线：清掉旧版本遗留的本地状态
      try {
        localStorage.removeItem('otto.uiux.pet.pos.v1');
        localStorage.removeItem('otto.uiux.pet.hidden.v1');
      } catch (err) { /* ignore */ }
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
