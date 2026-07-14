/**
 * Otto PPT Render Pipeline — Node.js version
 *
 * Automates the HTML→PNG→PptxGenJS assembly pipeline.
 * AI calls this script instead of hand-writing PptxGenJS boilerplate.
 *
 * Usage: node scripts/render-pptx.js --deck deck.html --out output.pptx
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const PptxGenJS = require('pptxgenjs');

// ─── Config ───
const SLIDE_W = 13.333; // inches (LAYOUT_WIDE)
const SLIDE_H = 7.5;
const VIEWPORT_W = 1920;
const VIEWPORT_H = 1080;
const SCALE = SLIDE_W / (VIEWPORT_W / 72); // convert px to inches for PPT

// ─── Find Chrome ───
function findChrome() {
  const candidates = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    process.env.CHROME_PATH,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    // Linux
    '/usr/bin/google-chrome',
    '/usr/bin/chromium-browser',
    '/opt/google/chrome/chrome',
  ];

  for (const c of candidates) {
    if (c && fs.existsSync(c)) return c;
  }

  // Try to find via command
  try {
    const which = os.platform() === 'win32' ? 'where chrome' : 'which google-chrome';
    const result = execSync(which, { encoding: 'utf8', timeout: 3000 }).trim();
    if (result && fs.existsSync(result.split('\n')[0])) return result.split('\n')[0];
  } catch {}

  // Fallback: try Edge on Windows
  try {
    const edgePath = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
    if (fs.existsSync(edgePath)) return edgePath;
  } catch {}

  return null;
}

// ─── Parse deck.html into slides ───
function parseDeckHtml(deckPath) {
  const html = fs.readFileSync(deckPath, 'utf8');

  // Extract all <section class="slide"> blocks
  const slideRegex = /<section\s+class="([^"]*)"[^>]*data-slide="([^"]*)"[^>]*>([\s\S]*?)<\/section>/gi;
  const slides = [];
  let match;

  while ((match = slideRegex.exec(html)) !== null) {
    slides.push({
      classes: match[1],
      slideId: match[2],
      content: match[3],
    });
  }

  // Also try without data-slide attribute
  if (slides.length === 0) {
    const altRegex = /<section\s+class="([^"]*slide[^"]*)"[^>]*>([\s\S]*?)<\/section>/gi;
    let altMatch;
    let idx = 1;
    while ((altMatch = altRegex.exec(html)) !== null) {
      slides.push({
        classes: altMatch[1],
        slideId: `S${idx}`,
        content: altMatch[2],
      });
      idx++;
    }
  }

  return { html, slides };
}

// ─── Screenshot slides ───
async function screenshotSlides(deckPath, slides, outputDir) {
  const chrome = findChrome();
  if (!chrome) {
    console.error('❌ Chrome/Chromium not found. Set CHROME_PATH env variable.');
    return null;
  }

  const pngDir = path.join(outputDir, 'slides');
  fs.mkdirSync(pngDir, { recursive: true });

  // Write per-slide HTML files for headless screenshot
  for (const slide of slides) {
    const slideHtml = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><style>
/* Extract global styles from deck.html */
body { margin: 0; padding: 0; width: ${VIEWPORT_W}px; height: ${VIEWPORT_H}px; }
.slide { position: relative; width: ${VIEWPORT_W}px; height: ${VIEWPORT_H}px; overflow: hidden; isolation: isolate; }
${extractStyles(deckPath)}
</style></head><body>
<section class="${slide.classes}" data-slide="${slide.slideId}">${slide.content}</section>
<script>
document.fonts.ready.then(() => {
  document.body.setAttribute('data-fonts-ready', 'true');
});
</script>
</body></html>`;

    const slidePath = path.join(pngDir, `${slide.slideId}.html`);
    fs.writeFileSync(slidePath, slideHtml);

    const pngPath = path.join(pngDir, `${slide.slideId}.png`);

    try {
      execSync(
        `"${chrome}" --headless --disable-gpu --window-size=${VIEWPORT_W},${VIEWPORT_H} --screenshot="${pngPath}" --virtual-time-budget=5000 "file://${slidePath.replace(/\\/g, '/')}"`,
        { timeout: 15000, stdio: 'pipe' }
      );

      if (fs.existsSync(pngPath)) {
        console.log(`  ✅ ${slide.slideId}.png (${(fs.statSync(pngPath).size / 1024).toFixed(0)} KB)`);
      } else {
        console.log(`  ⚠️ ${slide.slideId}.png not created — using CSS-only fallback`);
      }
    } catch (e) {
      console.log(`  ⚠️ ${slide.slideId} screenshot failed: ${e.message?.substring(0, 80)}`);
    }
  }

  return pngDir;
}

// ─── Extract global <style> from deck.html ───
function extractStyles(deckPath) {
  const html = fs.readFileSync(deckPath, 'utf8');
  const styleMatch = html.match(/<style[^>]*>([\s\S]*?)<\/style>/gi);
  if (styleMatch) {
    return styleMatch.map(s => s.replace(/<\/?style[^>]*>/gi, '')).join('\n');
  }
  return '';
}

// ─── Assemble PPTX ───
function assemblePptx(slides, pngDir, outputPath, options = {}) {
  const pptx = new PptxGenJS();
  pptx.layout = 'LAYOUT_WIDE';
  pptx.author = options.author || 'Otto';
  pptx.company = options.company || 'Otto';

  for (const slide of slides) {
    const s = pptx.addSlide();
    const pngPath = path.join(pngDir, `${slide.slideId}.png`);

    if (fs.existsSync(pngPath)) {
      s.addImage({ path: pngPath, x: 0, y: 0, w: SLIDE_W, h: SLIDE_H, sizing: { type: 'cover', w: SLIDE_W, h: SLIDE_H } });
    }

    // Add slide notes if present in storyboard
    if (slide.notes) {
      s.addNotes(slide.notes);
    }
  }

  return pptx.writeFile({ fileName: outputPath });
}

// ─── CLI ───
async function main() {
  const args = process.argv.slice(2);
  const deckPath = args[args.indexOf('--deck') + 1] || args[args.indexOf('-d') + 1];
  const outputPath = args[args.indexOf('--out') + 1] || args[args.indexOf('-o') + 1] || path.join(os.homedir(), 'Desktop', 'otto-output.pptx');

  if (!deckPath) {
    console.log('Usage: node scripts/render-pptx.js --deck deck.html [--out output.pptx]');
    process.exit(1);
  }

  const absDeck = path.resolve(deckPath);
  if (!fs.existsSync(absDeck)) {
    console.error(`❌ Deck not found: ${absDeck}`);
    process.exit(1);
  }

  console.log('🎬 Otto PPT Render Pipeline');
  console.log(`   Deck: ${absDeck}`);
  console.log(`   Output: ${outputPath}`);

  // Parse
  const { html, slides } = parseDeckHtml(absDeck);
  console.log(`\n📊 Found ${slides.length} slides`);

  // Screenshot
  console.log('\n📸 Rendering slides...');
  const outputDir = path.dirname(outputPath);
  const pngDir = await screenshotSlides(absDeck, slides, outputDir);

  // Assemble
  console.log('\n📦 Assembling PPTX...');
  await assemblePptx(slides, pngDir || path.join(outputDir, 'slides'), outputPath);

  // Verify
  const stat = fs.statSync(outputPath);
  const kb = (stat.size / 1024).toFixed(0);
  if (stat.size > 1024) {
    console.log(`\n✅ PPTX ready: ${outputPath} (${kb} KB, ${slides.length} slides)`);
    console.log(`   Open: start "" "${outputPath}"`);
  } else {
    console.error(`\n❌ PPTX too small (${kb} KB) — rendering may have failed`);
    process.exit(1);
  }
}

main().catch(e => {
  console.error('❌ Pipeline error:', e.message);
  process.exit(1);
});
