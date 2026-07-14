/**
 * Quick PPT Demo Builder — generates 8 slides about Otto v7
 * Each slide is its own HTML → screenshot → PPTX
 */
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const PptxGenJS = require('pptxgenjs');

const OUT = path.resolve('otto-v7-demo.pptx');
const TMP = path.resolve('temp-slides');
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
fs.mkdirSync(TMP, { recursive: true });

const VARS = `
:root{--bg:#000;--surface:#0a0a0a;--ink:#f5f5f7;--accent:#2997ff;--hot:#ff375f;--muted:#86868b}
*{margin:0;padding:0;box-sizing:border-box}
body{width:1920px;height:1080px;overflow:hidden;background:var(--bg);font-family:'Segoe UI',system-ui;position:relative}
`.trim();

function slideHTML(content) {
  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><style>${VARS}${content[0]}</style></head><body>${content[1]}</body></html>`;
}

const slides = [
// S1: Cover
[`
.glow{position:absolute;inset:0;background:radial-gradient(ellipse at 30% 20%,rgba(41,151,255,0.15),transparent 60%)}
.wrap{position:relative;z-index:2;display:flex;flex-direction:column;align-items:center;justify-content:center;height:1080px;text-align:center}
h1{font-size:100px;font-weight:900;color:var(--ink);line-height:1;letter-spacing:-0.03em}
.sub{font-size:26px;color:var(--muted);margin-top:18px;letter-spacing:0.12em}
.line{width:70px;height:4px;background:var(--accent);margin-top:28px;border-radius:2px}
`, `<div class="glow"></div><div class="wrap"><h1>Otto v7<br>PPT 视觉引擎</h1><div class="sub">CSS BACKGROUND · EDITABLE TEXT · 20 VISUAL SYSTEMS</div><div class="line"></div></div>`],

// S2: Dual Pipeline
[`
.glow{position:absolute;inset:0;background:radial-gradient(ellipse at 30% 20%,rgba(41,151,255,0.12),transparent 60%)}
.title{position:absolute;top:50px;left:80px;font-size:48px;font-weight:800;color:var(--ink)}
.split{position:absolute;top:0;left:50%;width:1px;height:1080px;background:rgba(255,255,255,0.08)}
.col{position:absolute;top:140px;width:800px}
.left{left:60px}.right{right:60px}
.label{font-size:12px;font-weight:600;color:var(--accent);letter-spacing:0.2em;text-transform:uppercase;margin-bottom:12px}
h3{font-size:38px;font-weight:700;color:var(--ink);margin-bottom:16px;line-height:1.2}
p{font-size:20px;color:var(--muted);line-height:1.6;margin-bottom:8px}
.grn{font-size:17px;color:#4ade80;margin-top:16px}
`, `<div class="glow"></div><div class="title">两条渲染管道</div><div class="split"></div>
<div class="col left"><div class="label">Pipeline A · 视觉优先</div><h3>全幅 CSS 渲染</h3><p>backdrop-filter · clip-path<br>radial-glow · 玻璃质感<br>渐变网格 · 扫描线</p><p class="grn">封面 / 高潮页 / 宣言页</p></div>
<div class="col right"><div class="label">Pipeline B · 可编辑优先</div><h3>CSS 背景 + 原生文本框</h3><p>背景走 PNG 保留视觉品质<br>文字用 PptxGenJS addText()</p><p class="grn">✅ PowerPoint 里可选中、编辑、翻译</p></div>`],

// S3: 20 Visual Systems
[`
.glow{position:absolute;inset:0;background:radial-gradient(ellipse at 30% 20%,rgba(41,151,255,0.1),transparent 60%)}
.title{position:absolute;top:50px;left:80px;font-size:48px;font-weight:800;color:var(--ink)}
.grid{position:absolute;top:140px;left:60px;right:60px;display:grid;grid-template-columns:repeat(5,1fr);gap:8px}
.chip{background:var(--surface);border:1px solid rgba(255,255,255,0.04);border-radius:10px;padding:12px 14px;font-size:14px;color:var(--muted);display:flex;align-items:center;gap:8px}
.dot{width:7px;height:7px;border-radius:50%;flex-shrink:0}
`, `<div class="glow"></div><div class="title">20 套视觉系统 · CSS Token 直接可用</div>
<div class="grid">
<div class="chip"><span class="dot" style="background:#5e6ad2"></span>Linear Dark</div>
<div class="chip"><span class="dot" style="background:#2997ff"></span>Apple Obsidian</div>
<div class="chip"><span class="dot" style="background:#fff"></span>Vercel Midnight</div>
<div class="chip"><span class="dot" style="background:#00f0ff"></span>Cyberpunk 2077</div>
<div class="chip"><span class="dot" style="background:#635bff"></span>Stripe Dark</div>
<div class="chip"><span class="dot" style="background:#e50914"></span>Netflix Dark</div>
<div class="chip"><span class="dot" style="background:#58a6ff"></span>GitHub Dark</div>
<div class="chip"><span class="dot" style="background:#0071e3"></span>Apple White</div>
<div class="chip"><span class="dot" style="background:#d97706"></span>Anthropic</div>
<div class="chip"><span class="dot" style="background:#635bff"></span>Stripe Light</div>
<div class="chip"><span class="dot" style="background:#d4a574"></span>NYT Magazine</div>
<div class="chip"><span class="dot" style="background:#2383e2"></span>Notion Light</div>
<div class="chip"><span class="dot" style="background:#0d99ff"></span>Figma Light</div>
<div class="chip"><span class="dot" style="background:linear-gradient(135deg,#6366f1,#d946ef)"></span>Gradient Galaxy</div>
<div class="chip"><span class="dot" style="background:conic-gradient(#635bff,#00d4ff,#50e3c2,#635bff)"></span>Stripe Sessions</div>
<div class="chip"><span class="dot" style="background:#ff3366"></span>Pop Art</div>
<div class="chip"><span class="dot" style="background:#c41e3a"></span>新东方未来</div>
<div class="chip"><span class="dot" style="background:#8b4513"></span>Zen Minimal</div>
<div class="chip"><span class="dot" style="background:#b8860b"></span>国风传承</div>
<div class="chip"><span class="dot" style="background:#4ade80"></span>Organic Forest</div>
</div>`],

// S4: 9 Layouts
[`
.glow{position:absolute;inset:0;background:radial-gradient(ellipse at 30% 20%,rgba(41,151,255,0.1),transparent 60%)}
.title{position:absolute;top:50px;left:80px;font-size:48px;font-weight:800;color:var(--ink)}
.grid{position:absolute;top:140px;left:60px;right:60px;display:grid;grid-template-columns:repeat(3,1fr);gap:14px}
.card{background:var(--surface);border:1px solid rgba(255,255,255,0.05);border-radius:14px;padding:24px 28px}
.n{font-size:20px;font-weight:700;color:var(--ink);margin-bottom:6px}
.d{font-size:14px;color:var(--muted);line-height:1.4}
`, `<div class="glow"></div><div class="title">9 种 Slidev 布局指令</div>
<div class="grid">
<div class="card"><div class="n">cover</div><div class="d">封面 · 居中大标题</div></div>
<div class="card"><div class="n">statement</div><div class="d">宣言 · 一句话占画面</div></div>
<div class="card"><div class="n">two-cols</div><div class="d">双栏 · 左右分屏</div></div>
<div class="card"><div class="n">image-right</div><div class="d">图文 · 图右文左</div></div>
<div class="card"><div class="n">center</div><div class="d">焦点 · 巨型数字</div></div>
<div class="card"><div class="n">bento</div><div class="d">便当 · 4×3 网格</div></div>
<div class="card"><div class="n">timeline</div><div class="d">时间线 · 阶段推进</div></div>
<div class="card"><div class="n">quote</div><div class="d">引用 · 大号引用块</div></div>
<div class="card"><div class="n">end</div><div class="d">结尾 · CTA</div></div>
</div>`],

// S5: Hybrid
[`
body{background:linear-gradient(135deg,#000 0%,#0a0a1a 50%,#000814 100%)}
.glow{position:absolute;top:-150px;right:-150px;width:700px;height:700px;background:radial-gradient(circle,rgba(41,151,255,0.2),transparent 70%);border-radius:50%}
.title{position:absolute;top:50px;left:80px;font-size:48px;font-weight:800;color:var(--ink)}
.boxes{position:absolute;top:160px;left:60px;right:60px;display:flex;gap:30px}
.box{flex:1;background:var(--surface);border:1px solid rgba(255,255,255,0.08);border-radius:18px;padding:36px}
.box.special{background:rgba(41,151,255,0.04);border-color:rgba(41,151,255,0.15)}
.emoji{font-size:44px;margin-bottom:16px}
h3{font-size:24px;font-weight:700;color:var(--ink);margin-bottom:14px}
p{font-size:17px;color:var(--muted);line-height:1.6}
`, `<div class="glow"></div><div class="title">混合渲染：独有能力</div>
<div class="boxes">
<div class="box"><div class="emoji">🎨</div><h3>CSS 视觉背景</h3><p>backdrop-filter blur<br>clip-path 裁切<br>radial-glow 光晕<br>gradient 渐变网格</p></div>
<div class="box special"><div class="emoji">✏️</div><h3>PptxGenJS 原生文字</h3><p>addText() 文本框<br>PowerPoint 可选择<br>可编辑 · 可翻译<br>不是冻结 PNG</p></div>
<div class="box"><div class="emoji">🚀</div><h3>打开即用</h3><p>真实 .pptx 文件<br>双渲染管道<br>node render-pptx.cjs<br>一键生成</p></div>
</div>`],

// S6: Version Compare
[`
.glow{position:absolute;inset:0;background:radial-gradient(ellipse at 30% 20%,rgba(41,151,255,0.1),transparent 60%)}
.title{position:absolute;top:50px;left:80px;font-size:46px;font-weight:800;color:var(--ink)}
table{position:absolute;top:150px;left:80px;right:80px;border-collapse:collapse}
td,th{padding:12px 20px;text-align:left;font-size:17px;border-bottom:1px solid rgba(255,255,255,0.05)}
th{font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:0.1em}
td{color:var(--ink)}
.v{color:var(--accent);font-weight:700;font-size:15px}
.y{color:#4ade80}.n{color:var(--muted)}
`, `<div class="glow"></div><div class="title">版本演进</div>
<table><tr><th></th><th>v5</th><th>v6</th><th>v7</th></tr>
<tr><td class="v">Slidev Layouts</td><td class="y">9 种</td><td class="y">9 种</td><td class="y">9 种</td></tr>
<tr><td class="v">CSS Token 系统</td><td class="y">20 套</td><td class="y">20 套</td><td class="y">20 套</td></tr>
<tr><td class="v">工程 slideId</td><td class="n">—</td><td class="y">✅</td><td class="y">✅</td></tr>
<tr><td class="v">增量编辑</td><td class="n">—</td><td class="y">✅</td><td class="y">✅</td></tr>
<tr><td class="v">真实渲染脚本</td><td class="n">—</td><td class="n">—</td><td class="y">✅</td></tr>
<tr><td class="v">质量审核脚本</td><td class="n">—</td><td class="n">—</td><td class="y">✅</td></tr>
<tr><td class="v">混合渲染</td><td class="n">—</td><td class="n">—</td><td class="y">✅</td></tr>
</table>`],

// S7: Big Number
[`
.glow{position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);width:600px;height:600px;background:radial-gradient(circle,rgba(41,151,255,0.25),transparent 70%);border-radius:50%}
.wrap{position:relative;z-index:2;display:flex;flex-direction:column;align-items:center;justify-content:center;height:1080px;text-align:center}
.big{font-size:320px;font-weight:900;line-height:0.8;letter-spacing:-0.06em;background:linear-gradient(180deg,var(--accent) 0%, var(--ink) 100%);-webkit-background-clip:text;background-clip:text;color:transparent}
.label{font-size:22px;color:var(--muted);letter-spacing:0.15em;text-transform:uppercase;margin-top:14px}
`, `<div class="glow"></div><div class="wrap"><div class="big">20</div><div class="label">Visual Systems · Ready to Use</div></div>`],

// S8: End
[`
.glow{position:absolute;inset:0;background:radial-gradient(ellipse at 50% 40%,rgba(41,151,255,0.12),transparent 60%)}
.wrap{position:relative;z-index:2;display:flex;flex-direction:column;align-items:center;justify-content:center;height:1080px;text-align:center}
h1{font-size:64px;font-weight:900;color:var(--ink);letter-spacing:-0.02em}
.cta{margin-top:36px;padding:14px 44px;border:2px solid rgba(255,255,255,0.22);border-radius:999px;font-size:20px;color:var(--ink)}
.ft{position:absolute;bottom:50px;font-size:15px;color:var(--muted);opacity:0.4}
`, `<div class="glow"></div><div class="wrap"><h1>Let's Make It Real</h1><div class="cta">node scripts/render-pptx.cjs</div></div><div class="ft">Otto v7 · Pure Node.js · Zero Python</div>`],
];

// Generate per-slide HTML + screenshot
console.log('🎬 Otto v7 Demo Builder');
console.log(`   Output: ${OUT}\n`);

for (let i = 0; i < slides.length; i++) {
  const id = `S${i + 1}`;
  const [styles, body] = slides[i];
  const html = slideHTML([styles, body]);
  const htmlPath = path.join(TMP, `${id}.html`);
  const pngPath = path.join(TMP, `${id}.png`);
  fs.writeFileSync(htmlPath, html);

  try {
    execSync(`"${EDGE}" --headless --disable-gpu --window-size=1920,1080 --screenshot="${pngPath}" "file://${htmlPath.replace(/\\/g, '/')}"`, {
      timeout: 15000,
      stdio: 'pipe'
    });
    const kb = fs.existsSync(pngPath) ? (fs.statSync(pngPath).size / 1024).toFixed(0) : 0;
    console.log(`  ✅ ${id}.png (${kb} KB)`);
  } catch (e) {
    console.log(`  ⚠️ ${id} screenshot failed: ${e.message?.substring(0, 60)}`);
  }
}

// Assemble PPTX
console.log('\n📦 Assembling PPTX...');
const pptx = new PptxGenJS();
pptx.layout = 'LAYOUT_WIDE';
pptx.author = 'Otto';

for (let i = 0; i < slides.length; i++) {
  const id = `S${i + 1}`;
  const pngPath = path.join(TMP, `${id}.png`);
  const s = pptx.addSlide();
  if (fs.existsSync(pngPath)) {
    s.addImage({ path: pngPath, x: 0, y: 0, w: 13.333, h: 7.5 });
  }
}

pptx.writeFile({ fileName: OUT }).then(function() {
  const stat = fs.statSync(OUT);
  console.log(`\n✅ PPTX ready: ${OUT} (${(stat.size/1024).toFixed(0)} KB, ${slides.length} slides)`);
  // Cleanup
  fs.rmSync(TMP, { recursive: true, force: true });
  console.log('   Temp files cleaned.');
});
