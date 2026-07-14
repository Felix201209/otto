/**
 * Otto Investor Deck v8 — NOT PLAIN edition
 * Deep Obsidian style + Mesh Gradient + Mega Numbers + Orbs + Kinetic Type + Noise
 */
var execSync = require('child_process').execSync;
var fs = require('fs');
var path = require('path');
var PptxGenJS = require('pptxgenjs');

var OUT = path.resolve('otto-investor-v8.pptx');
var TMP = path.resolve('temp-slides-v8');
var EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
fs.mkdirSync(TMP, { recursive: true });

// Deep obsidian with purple-blue energy
var VARS = ':root{--bg:#050510;--surface:#0a0a18;--ink:#f0f0f8;--accent:#6366f1;--accent2:#a855f7;--hot:#f43f5e;--muted:#7c7caa;--glow:radial-gradient(ellipse at 30% 20%,rgba(99,102,241,0.12),transparent 60%)}'+
 '*{margin:0;padding:0;box-sizing:border-box}body{width:1920px;height:1080px;overflow:hidden;background:var(--bg);font-family:-apple-system,"Segoe UI","PingFang SC",system-ui;position:relative;color:var(--ink)}';

function sp1_MeshGradient() {
  // Spice 1: Multi-layer mesh gradient
  return '<div style="position:absolute;inset:0">'+
    '<div style="position:absolute;width:1000px;height:800px;left:10%;top:-20%;border-radius:50%;background:radial-gradient(ellipse, rgba(99,102,241,0.18), transparent 70%);filter:blur(60px)"></div>'+
    '<div style="position:absolute;width:700px;height:600px;right:-5%;bottom:-10%;border-radius:50%;background:radial-gradient(ellipse, rgba(168,85,247,0.15), transparent 70%);filter:blur(80px)"></div>'+
    '<div style="position:absolute;width:500px;height:900px;left:55%;top:20%;border-radius:50%;background:radial-gradient(ellipse, rgba(59,130,246,0.10), transparent 70%);filter:blur(50px)"></div>'+
    '</div>';
}

function sp2_Noise() {
  return '<div style="position:absolute;inset:0;opacity:0.025;background-image:url(&quot;data:image/svg+xml,%3Csvg viewBox=\'0 0 256 256\' xmlns=\'http://www.w3.org/2000/svg\'%3E%3Cfilter id=\'n\'%3E%3CfeTurbulence type=\'fractalNoise\' baseFrequency=\'0.85\' numOctaves=\'4\' stitchTiles=\'stitch\'/%3E%3C/filter%3E%3Crect width=\'100%25\' height=\'100%25\' filter=\'url(%23n)\'/%3E%3C/svg%3E&quot;);background-size:256px;pointer-events:none;z-index:99"></div>';
}

function sp7_MegaNumber(numStr, labelStr) {
  return '<div style="position:relative;z-index:2;display:flex;flex-direction:column;align-items:center;justify-content:center;height:1080px;text-align:center">'+
    '<div style="font-size:'+(numStr.length>2?'180px':'280px')+';font-weight:900;line-height:0.8;letter-spacing:-0.07em;background:linear-gradient(180deg,var(--accent) 0%,var(--accent2) 40%,var(--ink) 80%);-webkit-background-clip:text;background-clip:text;color:transparent;filter:drop-shadow(0 0 80px rgba(99,102,241,0.2))">'+numStr+'</div>'+
    '<div style="font-size:22px;color:var(--muted);letter-spacing:0.18em;text-transform:uppercase;margin-top:16px">'+labelStr+'</div></div>';
}

function sp9_Orbs() {
  return '<svg viewBox="0 0 1920 1080" style="position:absolute;inset:0" xmlns="http://www.w3.org/2000/svg">'+
    '<defs><radialGradient id="o1"><stop offset="0%" stop-color="var(--accent)" stop-opacity="0.18"/><stop offset="100%" stop-color="transparent"/></radialGradient>'+
    '<radialGradient id="o2"><stop offset="0%" stop-color="var(--accent2)" stop-opacity="0.14"/><stop offset="100%" stop-color="transparent"/></radialGradient>'+
    '<filter id="ob"><feGaussianBlur stdDeviation="90"/></filter></defs>'+
    '<circle cx="400" cy="300" r="450" fill="url(#o1)" filter="url(#ob)"/>'+
    '<circle cx="1500" cy="650" r="380" fill="url(#o2)" filter="url(#ob)"/>'+
    '<circle cx="900" cy="500" r="280" fill="url(#o1)" filter="url(#ob)" opacity="0.6"/>'+
    '</svg>';
}

function coverSlide(html) {
  return '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><style>'+VARS+'\n'+html[0]+'</style></head><body>'+html[1]+'</body></html>';
}

var slides = [
// S1: COVER — Kinetic + Mesh + Noise
[`
.wrap{position:relative;z-index:3;display:flex;flex-direction:column;align-items:center;justify-content:center;height:1080px;text-align:center}
h1{font-size:104px;font-weight:900;line-height:1.02;letter-spacing:-0.04em;color:var(--ink)}
h1 span{background:linear-gradient(135deg,var(--accent),var(--accent2));-webkit-background-clip:text;background-clip:text;color:transparent}
.sub{font-size:26px;color:var(--muted);margin-top:20px;letter-spacing:0.10em}
.line{width:80px;height:3px;background:linear-gradient(90deg,var(--accent),var(--accent2));margin-top:32px;border-radius:2px}
.badge{position:absolute;bottom:80px;font-size:14px;color:var(--muted);letter-spacing:0.25em;text-transform:uppercase;opacity:0.4}
`,
 sp1_MeshGradient() + sp9_Orbs() + sp2_Noise() +
 '<div class="wrap"><h1>Otto<br><span>Your AI Coworker</span></h1><div class="sub">值得信赖的企业级 AI 办公引擎</div><div class="line"></div></div>'+
 '<div class="badge">Investor Deck · 2026</div>'],

// S2: PROBLEM — Mega Number + Mesh
[`
.col{position:absolute;top:0;width:50%;height:100%}
.left{left:0;display:flex;flex-direction:column;justify-content:center;padding:0 80px 0 100px}
.right{right:0;display:flex;flex-direction:column;align-items:center;justify-content:center}
.overline{font-size:12px;font-weight:600;color:var(--accent);letter-spacing:0.25em;text-transform:uppercase;margin-bottom:20px}
h2{font-size:48px;font-weight:800;line-height:1.14;letter-spacing:-0.02em;margin-bottom:28px}
p{font-size:21px;color:var(--muted);line-height:1.7;margin-bottom:10px;max-width:550px}
.big-num{font-size:220px;font-weight:900;line-height:0.8;letter-spacing:-0.06em;background:linear-gradient(180deg,var(--accent) 0%,var(--accent2) 50%,rgba(168,85,247,0.3) 100%);-webkit-background-clip:text;background-clip:text;color:transparent;filter:drop-shadow(0 0 60px rgba(99,102,241,0.25))}
.big-label{font-size:20px;color:var(--muted);letter-spacing:0.12em;text-transform:uppercase;margin-top:8px}
`,
 sp1_MeshGradient() + sp2_Noise() +
 '<div class="col left"><div class="overline">The Problem</div><h2>每个知识工作者<br>每天浪费 2.1 小时<br>在重复办公任务上</h2><p>文档起草 · PPT 排版 · 表格公式<br>会议纪要 · 邮件回复 · 数据整理</p><p style="font-size:16px;opacity:0.5;margin-top:20px">来源: McKinsey Global Institute 2025</p></div>'+
 '<div class="col right"><div class="big-num">2.1h</div><div class="big-label">每日低价值重复劳动</div></div>'],

// S3: SOLUTION — Spice 3 (Glass panels) + Mesh
[`
.title{position:absolute;top:55px;left:100px;right:100px}
.overline{font-size:12px;font-weight:600;color:var(--accent);letter-spacing:0.25em;text-transform:uppercase;margin-bottom:10px}
h2{font-size:44px;font-weight:800;letter-spacing:-0.02em}
.grid{position:absolute;top:170px;left:80px;right:80px;bottom:60px;display:grid;grid-template-columns:repeat(3,1fr);gap:18px}
.card{background:rgba(255,255,255,0.03);backdrop-filter:blur(40px);-webkit-backdrop-filter:blur(40px);border:1px solid rgba(255,255,255,0.06);border-radius:22px;padding:32px;display:flex;flex-direction:column;transition:none}
.card .icon{font-size:38px;margin-bottom:16px}
.card h3{font-size:21px;font-weight:700;color:var(--ink);margin-bottom:10px}
.card p{font-size:15px;color:var(--muted);line-height:1.5;opacity:0.85}
`,
 sp1_MeshGradient() + sp2_Noise() +
 '<div class="title"><div class="overline">The Solution</div><h2>把你的工作工具全部 AI 化</h2></div>'+
 '<div class="grid">'+
 '<div class="card"><div class="icon">📄</div><h3>文档 & PPT</h3><p>一句话 → 发布会级演示文稿<br>20 套视觉系统 · 9 种布局<br>HTML→PNG→PPTX 全自动</p></div>'+
 '<div class="card"><div class="icon">📊</div><h3>表格 & 数据</h3><p>自然语言操作 Excel<br>自动分析 · 图表生成<br>公式推导 · 数据清洗</p></div>'+
 '<div class="card"><div class="icon">💬</div><h3>飞书双向同步</h3><p>在飞书里 @Otto 即可办公<br>消息 · 日历 · 文档<br>审批 · 任务全打通</p></div>'+
 '<div class="card"><div class="icon">🔒</div><h3>本地优先 · 安全</h3><p>数据不出本地机器<br>来源完全可追溯<br>增量编辑 · 检查点恢复</p></div>'+
 '<div class="card"><div class="icon">🚀</div><h3>纯 Node.js 引擎</h3><p>零 Python 依赖<br>安装即用 · 跨平台<br>Electron 桌面 + CLI</p></div>'+
 '<div class="card"><div class="icon">🎨</div><h3>CSS 视觉引擎</h3><p>Mesh Gradient · Glass · Noise<br>Kinetic Type · 3D Perspective<br>10 道视觉香料</p></div>'+
 '</div>'],

// S4: CAPABILITIES — Mega Numbers + Orbs
[`
.wrap{position:relative;z-index:2;display:flex;flex-direction:column;align-items:center;justify-content:center;height:1080px;text-align:center}
.overline{font-size:12px;font-weight:600;color:var(--accent);letter-spacing:0.25em;text-transform:uppercase;margin-bottom:14px}
h2{font-size:40px;font-weight:800;letter-spacing:-0.02em;margin-bottom:50px}
.row{display:flex;gap:80px}
.stat{text-align:center}
.stat .num{font-size:96px;font-weight:900;line-height:1;letter-spacing:-0.04em;background:linear-gradient(135deg,var(--accent),var(--accent2));-webkit-background-clip:text;background-clip:text;color:transparent;filter:drop-shadow(0 0 40px rgba(99,102,241,0.3))}
.stat .label{font-size:16px;color:var(--muted);margin-top:8px;letter-spacing:0.08em}
.skills-row{display:flex;gap:16px;margin-top:50px}
.skill-chip{background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.06);border-radius:10px;padding:10px 18px;font-size:14px;color:var(--muted);white-space:nowrap}
`,
 sp9_Orbs() + sp1_MeshGradient() + sp2_Noise() +
 '<div class="wrap"><div class="overline">Core Capabilities</div><h2>开箱即用的 AI 办公能力</h2>'+
 '<div class="row">'+
 '<div class="stat"><div class="num">8</div><div class="label">内置技能</div></div>'+
 '<div class="stat"><div class="num">20</div><div class="label">视觉系统</div></div>'+
 '<div class="stat"><div class="num">9</div><div class="label">布局模板</div></div>'+
 '<div class="stat"><div class="num">10</div><div class="label">CSS 香料</div></div>'+
 '</div>'+
 '<div class="skills-row">'+
 '<div class="skill-chip">copywriting</div><div class="skill-chip">data-viz</div><div class="skill-chip">doc-writer</div>'+
 '<div class="skill-chip">market-research</div><div class="skill-chip">meeting-notes</div><div class="skill-chip">pdf-toolkit</div>'+
 '<div class="skill-chip">ppt-creator</div><div class="skill-chip">spreadsheet-pro</div>'+
 '</div></div>'],

// S5: TRUST — Glass + Mesh + Noise (dark bento)
[`
.title{position:absolute;top:55px;left:100px;right:100px}
.overline{font-size:12px;font-weight:600;color:var(--accent);letter-spacing:0.25em;text-transform:uppercase;margin-bottom:10px}
h2{font-size:44px;font-weight:800}
.grid{position:absolute;top:170px;left:80px;right:80px;bottom:60px;display:grid;grid-template-columns:1fr 1fr 1.3fr;grid-template-rows:1fr 1fr;gap:16px}
.card{background:rgba(255,255,255,0.03);backdrop-filter:blur(30px);border:1px solid rgba(255,255,255,0.06);border-radius:20px;padding:28px;display:flex;flex-direction:column;justify-content:center}
.card.big{grid-row:span 2;background:linear-gradient(135deg,rgba(99,102,241,0.12),rgba(168,85,247,0.08))}
.card h3{font-size:20px;font-weight:700;color:var(--ink);margin-bottom:8px;display:flex;align-items:center;gap:10px}
.card h3 .dot{width:8px;height:8px;border-radius:50%;background:var(--accent);flex-shrink:0}
.card p{font-size:15px;color:var(--muted);line-height:1.5}
.card.big p{font-size:16px;margin-bottom:8px}
.card.big .check{display:flex;align-items:center;gap:10px;margin-bottom:8px;color:rgba(255,255,255,0.8);font-size:15px}
.card.big .check .ok{color:#22c55e;font-weight:700}
`,
 sp1_MeshGradient() + sp2_Noise() +
 '<div class="title"><div class="overline">Trust & Safety</div><h2>值得信赖的 AI 同事</h2></div>'+
 '<div class="grid">'+
 '<div class="card"><h3><span class="dot"></span>本地优先</h3><p>数据不出本地机器<br>无需上传云端<br>离线也可工作</p></div>'+
 '<div class="card"><h3><span class="dot"></span>来源追溯</h3><p>每个数字绑出处<br>每张图片有来源<br>每处引用可验证</p></div>'+
 '<div class="card big"><h3><span class="dot" style="background:var(--accent2)"></span>质量保证</h3>'+
 '<div class="check"><span class="ok">✓</span>稳定 slideId 增量编辑</div>'+
 '<div class="check"><span class="ok">✓</span>7 级检查点崩溃恢复</div>'+
 '<div class="check"><span class="ok">✓</span>三变体标杆验证</div>'+
 '<div class="check"><span class="ok">✓</span>source-map.json 审计</div>'+
 '<div class="check"><span class="ok">✓</span>audit-pptx.cjs 校验</div>'+
 '<div class="check"><span class="ok">✓</span>Needs-Manual 不假完成</div>'+
 '</div>'+
 '<div class="card"><h3><span class="dot"></span>优雅降级</h3><p>缺素材不假填充<br>标出盲区而非编造<br>质量报告透明</p></div>'+
 '<div class="card"><h3><span class="dot"></span>增量编辑</h3><p>改一页只再生一页<br>不重写整份 deck<br>检查点可恢复</p></div>'+
 '</div>'],

// S6: ARCHITECTURE — Spice 10 (Grid Burst) + Spice 5 (3D)
[`
.left{position:absolute;top:0;left:0;width:50%;height:100%;background:rgba(10,10,24,0.8);display:flex;flex-direction:column;justify-content:center;padding:0 80px}
.overline{font-size:12px;font-weight:600;color:var(--accent);letter-spacing:0.25em;text-transform:uppercase;margin-bottom:16px}
h2{font-size:42px;font-weight:800;line-height:1.12;margin-bottom:20px}
p{font-size:19px;color:var(--muted);line-height:1.6}
.right{position:absolute;top:0;right:0;width:50%;height:100%;display:flex;flex-direction:column;justify-content:center;gap:20px;padding-left:60px;padding-right:100px}
.item{display:flex;align-items:center;gap:18px;padding:18px 0;border-bottom:1px solid rgba(255,255,255,0.04)}
.item .letter{width:46px;height:46px;border-radius:14px;background:linear-gradient(135deg,var(--accent),var(--accent2));display:flex;align-items:center;justify-content:center;font-size:18px;font-weight:700;flex-shrink:0}
.item .info h4{font-size:18px;font-weight:700;color:var(--ink)}
.item .info span{font-size:14px;color:var(--muted)}
`,
 // Grid burst background
 '<div style="position:absolute;inset:0;background-image:linear-gradient(rgba(99,102,241,0.04) 1px,transparent 1px),linear-gradient(90deg,rgba(99,102,241,0.04) 1px,transparent 1px);background-size:60px 60px;mask-image:radial-gradient(ellipse at 70% 50%,black 30%,transparent 70%);-webkit-mask-image:radial-gradient(ellipse at 70% 50%,black 30%,transparent 70%)"></div>'+
 sp1_MeshGradient() + sp2_Noise() +
 '<div class="left"><div class="overline">Architecture</div><h2>五端统一<br>纯 Node.js 引擎</h2><p>Electron 桌面 + CLI + VSCode 插件<br>飞书 Bot · Server API 后端<br>三端统一体验，零 Python 依赖</p></div>'+
 '<div class="right">'+
 '<div class="item"><div class="letter">C</div><div class="info"><h4>CLI 终端</h4><span>开发者原生 · 管道友好</span></div></div>'+
 '<div class="item"><div class="letter">D</div><div class="info"><h4>Desktop 桌面</h4><span>Electron 原生 · GUI 全功能</span></div></div>'+
 '<div class="item"><div class="letter">F</div><div class="info"><h4>飞书 Bot</h4><span>消息同步 · 日历 · 审批</span></div></div>'+
 '<div class="item"><div class="letter">V</div><div class="info"><h4>VSCode 插件</h4><span>IDE 内嵌 · 代码+文档</span></div></div>'+
 '<div class="item"><div class="letter">S</div><div class="info"><h4>Server 后端</h4><span>REST API · 飞书网关</span></div></div>'+
 '</div>'],

// S7: MEGA NUMBER — with Orbs + Mesh
[`
.wrap{position:relative;z-index:2;display:flex;flex-direction:column;align-items:center;justify-content:center;height:1080px;text-align:center}
`,
 sp9_Orbs() + sp1_MeshGradient() + sp2_Noise() +
 sp7_MegaNumber('1', 'Sentence → Deliverable PPTX')+
 '<div style="position:relative;z-index:2;font-size:20px;color:var(--muted);margin-top:10px;max-width:600px;line-height:1.6">从一句话到可交付的演示文稿<br>不需要设计师 · 不需要模板 · 不需要 Python</div>'],

// S8: CLOSE — Kinetic + Mesh + Orbs
[`
.wrap{position:relative;z-index:3;display:flex;flex-direction:column;align-items:center;justify-content:center;height:1080px;text-align:center}
h1{font-size:64px;font-weight:900;line-height:1.08;letter-spacing:-0.03em}
h1 span{background:linear-gradient(135deg,var(--accent),var(--accent2));-webkit-background-clip:text;background-clip:text;color:transparent}
.sub{font-size:22px;color:var(--muted);margin-top:18px;line-height:1.6}
.cta{margin-top:44px;padding:20px 56px;background:linear-gradient(135deg,var(--accent),var(--accent2));border-radius:16px;font-size:22px;font-weight:600;color:#fff;letter-spacing:0.04em;box-shadow:0 20px 60px -20px rgba(99,102,241,0.4)}
.footer{position:absolute;bottom:55px;font-size:14px;color:var(--muted);opacity:0.3}
`,
 sp9_Orbs() + sp1_MeshGradient() + sp2_Noise() +
 '<div class="wrap">'+
 '<h1>让 <span>Otto</span> 成为<br>你团队的第 N+1 个成员</h1>'+
 '<div class="sub">纯 Node.js · 开源 · 值得信赖<br>github.com/Felix201209/otto</div>'+
 '<div class="cta">加入内测 →</div>'+
 '</div><div class="footer">Otto · Your AI Coworker · 2026</div>']
];

// Render
console.log('🎬 Otto Investor Deck v8 — NOT PLAIN');
console.log('   Style: Deep Obsidian + Mesh Gradient + Orbs + Glass + Noise\n');

for (var i = 0; i < slides.length; i++) {
  var id = 'S' + (i + 1);
  var html = coverSlide(slides[i]);
  var htmlPath = path.join(TMP, id + '.html');
  var pngPath = path.join(TMP, id + '.png');
  fs.writeFileSync(htmlPath, html);
  try {
    execSync('"' + EDGE + '" --headless --disable-gpu --window-size=1920,1080 --screenshot="' + pngPath + '" "file://' + htmlPath.replace(/\\/g, '/') + '"', {timeout:15000,stdio:'pipe'});
    var kb = fs.existsSync(pngPath) ? (fs.statSync(pngPath).size/1024).toFixed(0) : 0;
    console.log('  ✅ ' + id + '.png (' + kb + ' KB) · S' + (i+1));
  } catch(e) {
    console.log('  ⚠️ ' + id + ' failed');
  }
}

console.log('\n📦 Assembling...');
var pptx = new PptxGenJS();
pptx.layout = 'LAYOUT_WIDE';
pptx.author = 'Otto';
pptx.company = 'Otto';
var titles = [
  'Otto：你的 AI 数字同事',
  '每个知识工作者每天浪费 2.1h',
  '把你的工作工具全部 AI 化',
  '开箱即用的 8 大办公技能',
  '值得信赖的质量保证体系',
  '五端统一 · 纯 Node.js 引擎',
  '一句话 → 可交付 PPTX',
  '让 Otto 成为你团队的第 N+1 个成员'
];
for (var i = 0; i < slides.length; i++) {
  var s = pptx.addSlide();
  var pngPath = path.join(TMP, 'S' + (i+1) + '.png');
  if (fs.existsSync(pngPath)) { s.addImage({path:pngPath, x:0, y:0, w:13.333, h:7.5}); }
  s.addNotes(titles[i]);
}

pptx.writeFile({fileName: OUT}).then(function() {
  var stat = fs.statSync(OUT);
  console.log('\n✅ ' + OUT + ' (' + (stat.size/1024).toFixed(0) + ' KB, ' + slides.length + ' slides)');
  console.log('   Spices used: Mesh Gradient·Orbs·Noise·Glass·Mega Numbers·Grid Burst·Kinetic Type');
  fs.rmSync(TMP, {recursive: true, force: true});
});
