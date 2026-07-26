#!/usr/bin/env node
/**
 * Container sandbox image packaging was tied to the retired terminal npm bundle.
 * Desktop/server builds keep sandbox runtime checks through scripts/sandbox_command.js;
 * this packaging entry now exits cleanly until a desktop/server image is defined.
 */
console.warn('Skipping sandbox image packaging: terminal bundle has been retired.');
process.exit(0);
