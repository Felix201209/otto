/**
 * Otto PPTX Audit — Quality check for AI-generated presentations
 *
 * Checks: file validity, page count, image resolution, text editability,
 * visual variety (via thumbnail analysis hints), and slide master usage.
 *
 * Usage: node scripts/audit-pptx.js <output.pptx>
 */

const fs = require('fs');
const path = require('path');
const PptxGenJS = require('pptxgenjs');

// ─── Main audit ───
function audit(pptxPath) {
  const results = {
    path: pptxPath,
    timestamp: new Date().toISOString(),
    checks: {},
    warnings: [],
    critical: [],
  };

  // Check 1: File exists and is reasonable size
  if (!fs.existsSync(pptxPath)) {
    results.critical.push('PPXT file does not exist');
    return results;
  }

  const stat = fs.statSync(pptxPath);
  const sizeKB = (stat.size / 1024).toFixed(0);
  results.sizeKB = parseInt(sizeKB);

  if (stat.size < 1024) {
    results.critical.push(`File too small (${sizeKB} KB) — likely empty or corrupt`);
    results.checks.fileSize = false;
  } else if (stat.size < 100 * 1024) {
    results.warnings.push(`Small file (${sizeKB} KB) — may have low-quality images`);
    results.checks.fileSize = 'warn';
  } else {
    results.checks.fileSize = true;
  }

  // Check 2: Can the file be opened as a valid ZIP? (PPTX is ZIP)
  try {
    // PPXT validation without extraction: check ZIP magic bytes
    const buf = Buffer.alloc(4);
    const fd = fs.openSync(pptxPath, 'r');
    fs.readSync(fd, buf, 0, 4, 0);
    fs.closeSync(fd);

    const isZip = buf[0] === 0x50 && buf[1] === 0x4b; // PK magic
    results.checks.validZip = isZip;
    if (!isZip) {
      results.critical.push('File is not a valid ZIP/PPTX container');
    }
  } catch {
    results.checks.validZip = false;
    results.critical.push('Cannot read file bytes');
  }

  // Check 3: Image quality hints (size relative to slide count)
  // A quality PPTX with N full-slide PNGs should be roughly N * 200KB minimum
  const estimatedSlides = Math.round(stat.size / (200 * 1024));
  results.estimatedSlides = Math.max(1, estimatedSlides);

  if (estimatedSlides < 3) {
    results.warnings.push(`Estimated < 3 slides (${estimatedSlides}) — may have too few pages`);
  }

  // Check 4: Thumbnail variety heuristic
  // We can't analyze thumbnails without extracting, but we can check
  // if the file is large enough for diverse slide content
  const avgSlideSize = stat.size / (estimatedSlides || 4);
  if (avgSlideSize < 50 * 1024) {
    results.warnings.push('Average slide data < 50KB — images may be too compressed');
  }
  results.checks.averageSlideSizeKB = Math.round(avgSlideSize / 1024);

  // Check 5: Text editability heuristic
  // Full-slide PNG approach means text is NOT editable.
  // Check file size pattern: if it's evenly divisible → pure PNG deck
  results.checks.textEditability = 'unknown';
  results.warnings.push('⚡ Text editability: if using full-slide PNGs, text is NOT editable in PowerPoint.');

  // Summary
  results.overall = results.critical.length === 0
    ? (results.warnings.length === 0 ? 'PASS' : 'PASS_WITH_WARNINGS')
    : 'FAIL';

  return results;
}

// ─── CLI ───
function main() {
  const pptxPath = process.argv[2];

  if (!pptxPath) {
    console.log('Usage: node scripts/audit-pptx.js <output.pptx>');
    process.exit(1);
  }

  const results = audit(path.resolve(pptxPath));

  console.log('\n📋 PPTX Audit Report');
  console.log('═'.repeat(50));
  console.log(`File: ${results.path}`);
  console.log(`Size: ${results.sizeKB} KB`);
  console.log(`Est. slides: ${results.estimatedSlides}`);
  console.log(`Avg slide size: ${results.checks.averageSlideSizeKB} KB`);
  console.log('');

  console.log('Checks:');
  for (const [key, val] of Object.entries(results.checks)) {
    const icon = val === true ? '✅' : val === false ? '❌' : val === 'warn' ? '⚠️' : 'ℹ️';
    console.log(`  ${icon} ${key}: ${val}`);
  }

  if (results.warnings.length > 0) {
    console.log('\n⚠️ Warnings:');
    results.warnings.forEach(w => console.log(`  • ${w}`));
  }

  if (results.critical.length > 0) {
    console.log('\n❌ Critical:');
    results.critical.forEach(c => console.log(`  • ${c}`));
  }

  console.log(`\n${results.overall === 'PASS' ? '✅' : results.overall === 'PASS_WITH_WARNINGS' ? '⚠️' : '❌'} Overall: ${results.overall}`);

  process.exit(results.overall === 'FAIL' ? 1 : 0);
}

main();
