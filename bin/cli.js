#!/usr/bin/env node
// CLI entry point for npx/global install

import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { spawn } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const serverPath = join(__dirname, '..', 'server', 'index.js');

// Forward all args to the server
const args = process.argv.slice(2);
const child = spawn('node', [serverPath, ...args], {
  stdio: 'inherit',
  cwd: join(__dirname, '..')
});

child.on('exit', (code) => {
  process.exit(code || 0);
});
