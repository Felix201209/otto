/**
 * Otto Investor Deck Builder — 8 slides for investors
 * Apple White style · Trust theme · Light palette
 */
var execSync = require('child_process').execSync;
var fs = require('fs');
var path = require('path');
var PptxGenJS = require('pptxgenjs');

var OUT = path.resolve('otto-investor-deck.pptx');
var TMP = path.resolve('temp-slides');
var EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
fs.mkdirSync(TMP, { recursive: true });

var VARS = ':root{--bg:#fff;--surface:#f5f5f7;--ink:#1d1d1f;--accent:#0071e3;--hot:#ff3b30;--muted:#86868b}*{margin:0;padding:0;box-sizing:border-box}body{width:1920px;height:1080px;overflow:hidden;background:var(--bg);font-family:-apple-system,\"Segoe UI\",\"PingFang SC\",system-ui;position:relative;color:var(--ink)}';

function slideHTML(css, body) {
  return '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><style>' + VARS + '\n' + css + '</style></head><body>' + body + '</body></html>';
}

var slides = [
// S1: Cover
['.wrap{display:flex;flex-direction:column;align-items:center;justify-content:center;height:1080px;text-align:center;position:relative;z-index:2}'+
 '.bg-ring{position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);width:900px;height:900px;border-radius:50%;border:1px solid rgba(0,113,227,0.06)}'+
 '.bg-ring:nth-child(2){width:700px;height:700px;border-color:rgba(0,113,227,0.04)}'+
 '.bg-ring:nth-child(3){width:500px;height:500px;border-color:rgba(0,113,227,0.03)}'+
 '.bg-dot{position:absolute;width:4px;height:4px;border-radius:50%;background:var(--accent);opacity:0.12}'+
 'h1{font-size:96px;font-weight:900;color:var(--ink);line-height:1.08;letter-spacing:-0.03em}'+
 '.sub{font-size:28px;color:var(--muted);margin-top:20px;letter-spacing:0.08em}'+
 '.line{width:60px;height:4px;background:var(--accent);margin-top:32px;border-radius:2px}'+
 '.tag{font-size:16px;color:var(--muted);margin-top:40px;letter-spacing:0.2em;text-transform:uppercase;opacity:0.6}',

 '<div class="bg-ring"></div><div class="bg-ring"></div><div class="bg-ring"></div>'+
 '<div class="bg-dot" style="top:15%;left:12%"></div><div class="bg-dot" style="top:78%;left:82%"></div><div class="bg-dot" style="top:22%;left:88%"></div>'+
 '<div class="bg-dot" style="top:72%;left:18%"></div><div class="bg-dot" style="top:40%;left:8%"></div>'+
 '<div class="wrap"><h1>Otto<br>你的 AI 数字同事</h1><div class="sub">值得信赖的企业级 AI 办公引擎</div><div class="line"></div><div class="tag">Investor Deck · 2026</div></div>'],

// S2: The Problem
['.bg{position:absolute;top:0;right:0;width:45%;height:100%;background:linear-gradient(90deg,transparent 0%,var(--surface) 100%)}'+
 '.left-col{position:absolute;top:0;left:0;width:55%;height:100%;display:flex;flex-direction:column;justify-content:center;padding-left:100px;padding-right:60px}'+
 '.overline{font-size:13px;font-weight:600;color:var(--accent);letter-spacing:0.2em;text-transform:uppercase;margin-bottom:20px}'+
 'h2{font-size:52px;font-weight:800;color:var(--ink);line-height:1.12;margin-bottom:28px;letter-spacing:-0.02em}'+
 'p{font-size:22px;color:var(--muted);line-height:1.6;margin-bottom:14px;max-width:600px}'+
 '.right-col{position:absolute;top:0;right:0;width:45%;height:100%;display:flex;flex-direction:column;justify-content:center;padding-right:120px;padding-left:60px}'+
 '.stat{display:flex;align-items:baseline;margin-bottom:36px}'+
 '.stat .num{font-size:56px;font-weight:900;color:var(--accent);line-height:1;margin-right:12px}'+
 '.stat .txt{font-size:20px;color:var(--muted);line-height:1.4}'+
 '.stat .num.small{font-size:44px;color:var(--ink)}',

 '<div class="bg"></div><div class="left-col"><div class="overline">The Problem</div><h2>每个员工每天浪费<br>2.1 小时<br>在重复办公任务上</h2><p>文档起草 · PPT 排版 · 表格公式 · 会议纪要 · 邮件回复 · 数据整理</p><p style="color:var(--muted);font-size:17px">来源：McKinsey Global Institute 2025</p></div>'+
 '<div class="right-col"><div class="stat"><span class="num">2.1h</span><span class="txt">每人每天<br>低价值重复劳动</span></div><div class="stat"><span class="num small">6.2h</span><span class="txt">AI辅佐后<br>恢复到高价值工作</span></div><div class="stat"><span class="num small">3×</span><span class="txt">团队产出<br>提升倍数</span></div></div>'],

// S3: Solution
['.title-bar{position:absolute;top:60px;left:100px;right:100px}'+
 '.overline{font-size:13px;font-weight:600;color:var(--accent);letter-spacing:0.2em;text-transform:uppercase;margin-bottom:12px}'+
 'h2{font-size:48px;font-weight:800;color:var(--ink)}'+
 '.grid{position:absolute;top:190px;left:80px;right:80px;bottom:60px;display:grid;grid-template-columns:repeat(3,1fr);gap:20px}'+
 '.card{background:var(--surface);border-radius:20px;padding:36px;display:flex;flex-direction:column;border:1px solid rgba(0,0,0,0.04)}'+
 '.card .icon{font-size:40px;margin-bottom:20px}'+
 '.card h3{font-size:24px;font-weight:700;color:var(--ink);margin-bottom:12px}'+
 '.card p{font-size:17px;color:var(--muted);line-height:1.5}',

 '<div class="title-bar"><div class="overline">The Solution</div><h2>Otto 把你的工作工具全部 AI 化</h2></div>'+
 '<div class="grid">'+
 '<div class="card"><div class="icon">📄</div><h3>文档 & PPT</h3><p>一句话生成发布会级演示文稿<br>20套视觉系统 · 9种布局<br>HTML→PNG→PPTX 全自动</p></div>'+
 '<div class="card"><div class="icon">📊</div><h3>表格 & 数据</h3><p>自然语言操作 Excel<br>自动分析 · 图表生成<br>公式推导 · 数据清洗</p></div>'+
 '<div class="card"><div class="icon">📅</div><h3>日历 & 任务</h3><p>飞书日历自动调度<br>任务优先级智能分配<br>会议纪要自动生成</p></div>'+
 '<div class="card"><div class="icon">💬</div><h3>飞书双向同步</h3><p>在飞书里@Otto即可办公<br>无需切换工具<br>消息·文档·审批全部打通</p></div>'+
 '<div class="card"><div class="icon">🔒</div><h3>本地优先 · 安全</h3><p>数据不出本地<br>来源完全可追溯<br>增量编辑 · 检查点恢复</p></div>'+
 '<div class="card"><div class="icon">🚀</div><h3>纯 Node.js 引擎</h3><p>零 Python 依赖<br>安装即用 · 跨平台<br>Electron 桌面 + CLI</p></div>'+
 '</div>'],

// S4: Capabilities
['.wrap{position:relative;z-index:2;display:flex;flex-direction:column;align-items:center;justify-content:center;height:1080px;text-align:center}'+
 '.bg{position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);width:700px;height:700px;border-radius:50%;background:radial-gradient(circle,rgba(0,113,227,0.06),transparent 70%)}'+
 '.overline{font-size:13px;font-weight:600;color:var(--accent);letter-spacing:0.2em;text-transform:uppercase;margin-bottom:16px}'+
 'h2{font-size:42px;font-weight:800;color:var(--ink);margin-bottom:40px}'+
 '.stat-row{display:flex;gap:60px;margin-bottom:12px}'+
 '.big-stat{text-align:center}'+
 '.big-stat .num{font-size:80px;font-weight:900;color:var(--accent);line-height:1}'+
 '.big-stat .label{font-size:18px;color:var(--muted);margin-top:8px}'+
 '.note{font-size:16px;color:var(--muted);margin-top:40px;opacity:0.6}',

 '<div class="bg"></div><div class="wrap"><div class="overline">Core Capabilities</div><h2>开箱即用的 AI 办公能力</h2>'+
 '<div class="stat-row">'+
 '<div class="big-stat"><div class="num">8</div><div class="label">内置办公技能</div></div>'+
 '<div class="big-stat"><div class="num">20</div><div class="label">视觉设计系统</div></div>'+
 '<div class="big-stat"><div class="num">9</div><div class="label">布局指令模板</div></div>'+
 '<div class="big-stat"><div class="num">7</div><div class="label">工程检查点</div></div>'+
 '</div><div class="note">copywriting · data-viz · doc-writer · market-research · meeting-notes · pdf-toolkit · ppt-creator · spreadsheet-pro</div></div>'],

// S5: Trust
['.title-bar{position:absolute;top:60px;left:100px;right:100px}'+
 '.overline{font-size:13px;font-weight:600;color:var(--accent);letter-spacing:0.2em;text-transform:uppercase;margin-bottom:12px}'+
 'h2{font-size:48px;font-weight:800;color:var(--ink)}'+
 '.grid{position:absolute;top:180px;left:80px;right:80px;bottom:60px;display:grid;grid-template-columns:repeat(2,1fr) 1.5fr;grid-template-rows:repeat(2,1fr);gap:16px}'+
 '.card{background:var(--surface);border-radius:16px;padding:30px;display:flex;flex-direction:column;justify-content:center;border:1px solid rgba(0,0,0,0.04)}'+
 '.card.big{grid-row:span 2;background:var(--accent);color:#fff;border:none}'+
 '.card h3{font-size:22px;font-weight:700;color:var(--ink);margin-bottom:10px}'+
 '.card p{font-size:16px;color:var(--muted);line-height:1.5}'+
 '.card.big h3{color:#fff;font-size:28px;margin-bottom:20px}'+
 '.card.big p{color:rgba(255,255,255,0.85);font-size:18px}'+
 '.card.big .checklist{display:flex;flex-direction:column;gap:12px;margin-top:16px}'+
 '.card.big .check{display:flex;align-items:center;gap:10px;color:rgba(255,255,255,0.9);font-size:17px}',

 '<div class="title-bar"><div class="overline">Trust & Safety</div><h2>值得信赖的 AI 同事</h2></div>'+
 '<div class="grid">'+
 '<div class="card"><h3>🏠 本地优先</h3><p>数据不出本地机器<br>无需上传云端<br>离线也可工作</p></div>'+
 '<div class="card"><h3>🔍 来源追溯</h3><p>每个数字绑出处<br>每张图片有来源<br>每处引用可验证</p></div>'+
 '<div class="card big"><h3>质量保证体系</h3><div class="checklist">'+
 '<div class="check">✅ 稳定 slideId 增量编辑</div>'+
 '<div class="check">✅ 7 级检查点崩溃恢复</div>'+
 '<div class="check">✅ 三变体标杆验证</div>'+
 '<div class="check">✅ source-map.json 审计</div>'+
 '<div class="check">✅ audit-pptx.cjs 校验</div>'+
 '<div class="check">✅ Needs-Manual 不假完成</div>'+
 '</div></div>'+
 '<div class="card"><h3>🎯 优雅降级</h3><p>缺素材不假填充<br>标出盲区而非编造<br>质量报告透明</p></div>'+
 '<div class="card"><h3>🔄 增量编辑</h3><p>改一页只再生一页<br>不重写整份 deck<br>检查点可恢复</p></div>'+
 '</div>'],

// S6: Architecture
['.left-panel{position:absolute;top:0;left:0;width:50%;height:100%;background:var(--surface);display:flex;flex-direction:column;justify-content:center;padding:0 80px}'+
 '.overline{font-size:13px;font-weight:600;color:var(--accent);letter-spacing:0.2em;text-transform:uppercase;margin-bottom:16px}'+
 'h2{font-size:44px;font-weight:800;color:var(--ink);line-height:1.12;margin-bottom:24px}'+
 'p{font-size:20px;color:var(--muted);line-height:1.6;margin-bottom:12px}'+
 '.right-panel{position:absolute;top:0;right:0;width:50%;height:100%;display:flex;flex-direction:column;justify-content:center;padding-left:60px;padding-right:100px}'+
 '.arch-item{display:flex;align-items:center;gap:16px;padding:18px 0;border-bottom:1px solid rgba(0,0,0,0.05)}'+
 '.arch-item .letter{width:44px;height:44px;border-radius:12px;background:var(--accent);color:#fff;display:flex;align-items:center;justify-content:center;font-size:18px;font-weight:700;flex-shrink:0}'+
 '.arch-item .info h4{font-size:19px;font-weight:700;color:var(--ink);margin-bottom:2px}'+
 '.arch-item .info span{font-size:15px;color:var(--muted)}',

 '<div class="left-panel"><div class="overline">Architecture</div><h2>纯 Node.js<br>零 Python 依赖</h2><p>Electron 桌面应用 + CLI + VSCode 插件，三端统一体验</p><p style="color:var(--muted);font-size:17px">飞书双向同步 · 本地数据 · 即时响应</p></div>'+
 '<div class="right-panel">'+
 '<div class="arch-item"><div class="letter">C</div><div class="info"><h4>CLI 终端</h4><span>开发者原生体验 · 管道友好</span></div></div>'+
 '<div class="arch-item"><div class="letter">D</div><div class="info"><h4>Desktop 桌面</h4><span>Electron 原生窗口 · GUI全功能</span></div></div>'+
 '<div class="arch-item"><div class="letter">F</div><div class="info"><h4>飞书 Bot</h4><span>消息双向同步 · 文档/日历/审批</span></div></div>'+
 '<div class="arch-item"><div class="letter">V</div><div class="info"><h4>VSCode 插件</h4><span>IDE 内嵌 · 代码+文档一站式</span></div></div>'+
 '<div class="arch-item"><div class="letter">S</div><div class="info"><h4>Server 后端</h4><span>RESTful API · 持久存储 · 飞书网关</span></div></div>'+
 '</div>'],

// S7: Big Number
['.wrap{position:relative;z-index:2;display:flex;flex-direction:column;align-items:center;justify-content:center;height:1080px;text-align:center}'+
 '.bg{position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);width:600px;height:600px;border-radius:50%;background:radial-gradient(circle,rgba(0,113,227,0.06),transparent 70%)}'+
 '.big{font-size:200px;font-weight:900;line-height:0.8;letter-spacing:-0.05em;background:linear-gradient(180deg,var(--accent) 0%,var(--ink) 100%);-webkit-background-clip:text;background-clip:text;color:transparent}'+
 '.label{font-size:24px;color:var(--muted);letter-spacing:0.15em;text-transform:uppercase;margin-top:12px}'+
 '.sub-text{font-size:20px;color:var(--muted);margin-top:24px;max-width:600px;line-height:1.6}',

 '<div class="bg"></div><div class="wrap">'+
 '<div class="big">1</div>'+
 '<div class="label">Sentence → Deliverable PPTX</div>'+
 '<div class="sub-text">从一句话到可交付的演示文稿<br>不需要设计师 · 不需要模板 · 不需要 Python</div></div>'],

// S8: Close
['.wrap{display:flex;flex-direction:column;align-items:center;justify-content:center;height:1080px;text-align:center;position:relative;z-index:2}'+
 '.bg{position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);width:800px;height:800px;border-radius:50%;background:radial-gradient(circle,rgba(0,113,227,0.05),transparent 70%)}'+
 'h1{font-size:64px;font-weight:900;color:var(--ink);letter-spacing:-0.02em}'+
 '.sub{font-size:24px;color:var(--muted);margin-top:16px;line-height:1.5}'+
 '.cta{margin-top:40px;padding:18px 52px;background:var(--accent);color:#fff;border-radius:14px;font-size:22px;font-weight:600;letter-spacing:0.04em}'+
 '.footer{position:absolute;bottom:60px;font-size:15px;color:var(--muted);opacity:0.4}',

 '<div class="bg"></div><div class="wrap">'+
 '<h1>让 Otto 成为<br>你团队的第 N+1 个成员</h1>'+
 '<div class="sub">纯 Node.js · 开源 · 值得信赖<br>github.com/Felix201209/otto</div>'+
 '<div class="cta">加入内测 →</div>'+
 '</div><div class="footer">Otto · Your AI Coworker · 2026</div>']
];

// Render
console.log('🎬 Otto Investor Deck Builder');
console.log('   Style: Apple White · Audience: Investors\n');

for (var i = 0; i < slides.length; i++) {
  var id = 'S' + (i + 1);
  var html = slideHTML(slides[i][0], slides[i][1]);
  var htmlPath = path.join(TMP, id + '.html');
  var pngPath = path.join(TMP, id + '.png');
  fs.writeFileSync(htmlPath, html);
  try {
    execSync('"' + EDGE + '" --headless --disable-gpu --window-size=1920,1080 --screenshot="' + pngPath + '" "file://' + htmlPath.replace(/\\/g, '/') + '"', {timeout:15000,stdio:'pipe'});
    var kb = fs.existsSync(pngPath) ? (fs.statSync(pngPath).size/1024).toFixed(0) : 0;
    console.log('  ✅ ' + id + '.png (' + kb + ' KB)');
  } catch(e) {
    console.log('  ⚠️ ' + id + ' failed: ' + e.message.substring(0,50));
  }
}

console.log('\n📦 Assembling PPTX...');
var pptx = new PptxGenJS();
pptx.layout = 'LAYOUT_WIDE';
pptx.author = 'Otto';
pptx.company = 'Otto';
pptx.subject = 'Otto Investor Deck - Your AI Coworker';

var titles = [
  'Otto：你的 AI 数字同事',
  '每个员工每天浪费 2.1 小时',
  '把你的工作工具全部 AI 化',
  '开箱即用的 8 大办公技能',
  '值得信赖的质量保证体系',
  '纯 Node.js · 零 Python · 全平台',
  '一句话 → 可交付 PPTX',
  '让 Otto 成为你团队的第 N+1 个成员'
];

for (var i = 0; i < slides.length; i++) {
  var id = 'S' + (i + 1);
  var pngPath = path.join(TMP, id + '.png');
  var s = pptx.addSlide();
  if (fs.existsSync(pngPath)) {
    s.addImage({path: pngPath, x:0, y:0, w:13.333, h:7.5});
  }
  s.addNotes(titles[i]);
}

pptx.writeFile({fileName: OUT}).then(function() {
  var stat = fs.statSync(OUT);
  console.log('\n✅ PPTX ready: ' + OUT + ' (' + (stat.size/1024).toFixed(0) + ' KB, ' + slides.length + ' slides)');
  console.log('   Style: Apple White · Light · Professional');
  console.log('   Pipeline: A (full-slide CSS→PNG)');
  fs.rmSync(TMP, {recursive: true, force: true});
});
