const fs = require('fs');
const path = require('path');

function cleanDirectory(dir) {
  if (!fs.existsSync(dir)) {
    return;
  }

  const items = fs.readdirSync(dir, { withFileTypes: true });

  for (const item of items) {
    const itemPath = path.join(dir, item.name);

    if (item.isDirectory()) {
      cleanDirectory(itemPath);
    } else if (item.isFile()) {
      const ext = path.extname(item.name);
      const basename = path.basename(item.name, ext);

      // Delete .js, .d.ts, .js.map files (but keep .ts source files)
      if (ext === '.js' || ext === '.map' || (ext === '.ts' && basename.endsWith('.d'))) {
        try {
          fs.unlinkSync(itemPath);
          console.log(`Deleted: ${itemPath}`);
        } catch (err) {
          console.error(`Failed to delete ${itemPath}: ${err.message}`);
        }
      }
    }
  }
}

// Clean src directory
const srcDir = path.join(__dirname, '..', 'src');
console.log('Purging build artifacts from src directory...');
cleanDirectory(srcDir);

// Also clean webview/src — the webview has its own tsc/webpack build and
// easily leaks compiled .js/.d.ts into sources if someone runs `tsc` without
// `--noEmit`. These leftovers break typecheck because webview's tsconfig has
// `allowJs: true` and the stale .js files lack JSX pragmas.
const webviewSrcDir = path.join(__dirname, '..', 'webview', 'src');
console.log('Purging build artifacts from webview/src directory...');
cleanDirectory(webviewSrcDir);

console.log('Cleanup task completed.');