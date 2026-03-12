/**
 * Rebuild native modules (better-sqlite3, node-pty) against Electron's Node version.
 * Uses @electron/rebuild API directly to avoid ESM/yargs incompatibilities on Node 25+.
 */
const path = require('path');
const { rebuild } = require('@electron/rebuild');

const electronVersion = require('../node_modules/electron/package.json').version;
const appRoot = path.join(__dirname, '..');

console.log(`Rebuilding native modules for Electron ${electronVersion}...`);

rebuild({
  buildPath: appRoot,
  electronVersion,
  onlyModules: ['better-sqlite3', 'node-pty'],
  force: true,
})
  .then(() => {
    console.log(`✓ Native modules rebuilt for Electron ${electronVersion}`);
  })
  .catch((err) => {
    console.error('Failed to rebuild native modules:', err.message || err);
    process.exit(1);
  });
