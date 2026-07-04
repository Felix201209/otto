#!/usr/bin/env node
/**
 * Otto Enterprise - Production Launcher
 *
 * One command to start everything:
 *   node start-enterprise.js [--port 7777] [--dashboard]
 *
 * Starts:
 *   1. Otto Enterprise Server (HTTP API + SQLite + Dashboard)
 *   2. Post-execution auto-learning (learns from every task)
 *   3. Dashboard URL output
 *
 * Usage:
 *   node start-enterprise.js                    # Start on default port 7777
 *   node start-enterprise.js --port 8888        # Custom port
 *   node start-enterprise.js --dashboard        # Open dashboard in browser
 */

const { exec } = require('child_process');

const args = process.argv.slice(2);
const port = args.includes('--port') ? args[args.indexOf('--port') + 1] : '7777';
const openDashboard = args.includes('--dashboard');

process.env.OTTO_ENTERPRISE_PORT = port;

console.log('');
console.log('=============================================');
console.log('  Otto Enterprise - Production Launch');
console.log('=============================================');
console.log(`  Server:  http://0.0.0.0:${port}`);
console.log(`  Dashboard: http://localhost:${port}/enterprise/dashboard`);
console.log(`  Data:     ~/.otto-enterprise/data.db`);
console.log('=============================================');
console.log('');

// Start Enterprise Server
require('./packages/server/dist/src/enterprise/server.js');

// Open dashboard if requested
if (openDashboard) {
  const url = `http://localhost:${port}/enterprise/dashboard`;
  exec(`open "${url}"`);
  console.log(`Dashboard opening in browser: ${url}`);
}

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\n[Otto Enterprise] Shutting down...');
  process.exit(0);
});

console.log('[Otto Enterprise] Press Ctrl+C to stop.');
