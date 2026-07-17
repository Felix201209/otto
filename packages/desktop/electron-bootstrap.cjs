// Otto Desktop bootstrap for Electron v43.1.0 on Node.js v24
//
// Workaround: Electron v43.1.0's browser_init crashes on Node.js v24
// because process.activateUvLoop is missing. This causes require('electron')
// to return the npm package's binary path instead of the Electron API.
//
// Fix: Use ELECTRON_RUN_AS_NODE to bypass Electron's auto-init, then
// manually bootstrap the Electron main process.

// Monkey-patch activateUvLoop BEFORE anything else
if (typeof process.activateUvLoop !== 'function') {
  process.activateUvLoop = function() {};
}

// Now load Electron's browser_init which will set up the electron module cache
try {
  require('electron/js2c/browser_init');
} catch(e) {
  console.error('Failed to load browser_init:', e.message);
}

// Verify the electron module is now available
var Module = require('module');
if (Module._cache['electron']) {
  // Electron module is set up, now delegate to the real main process
  require('./dist/main/index.js');
} else {
  console.error('ERROR: electron module still not available after bootstrap');
  console.error('This Electron version may be incompatible with your system.');
  process.exit(1);
}
