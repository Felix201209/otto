// Wrapper: monkey-patch process.activateUvLoop before Electron's init runs.
// Electron v43.1.0 init code calls process.activateUvLoop() which doesn't exist
// in Node.js v24. This patch defines it as a no-op.
if (typeof process.activateUvLoop !== 'function') {
  process.activateUvLoop = function() {};
  console.log('[otto-patch] monkey-patched process.activateUvLoop');
}

// Now load the real main entry point
require('./dist/main/index.js');
