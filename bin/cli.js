#!/usr/bin/env node
// CLI entry point for npx/global install

import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { existsSync } from 'fs';
import { spawn } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, '..');
const serverPath = join(projectRoot, 'server', 'index.ts');
const setupPath = join(projectRoot, 'hooks', 'setup-wizard.js');
const configPath = join(projectRoot, 'data', 'server-config.json');

const args = process.argv.slice(2);
const forceSetup = args.includes('--setup');
const forceUninstall = args.includes('--uninstall');
const isFirstRun = !existsSync(configPath);

const installHooksPath = join(projectRoot, 'hooks', 'install-hooks.js');

// Resolve tsx binary: prefer local node_modules/.bin (works for global installs)
const localTsx = join(projectRoot, 'node_modules', '.bin', 'tsx');
const tsxBin = existsSync(localTsx) ? localTsx : 'tsx';

function startServer() {
  const serverArgs = args.filter(a => a !== '--setup');
  const child = spawn(tsxBin, [serverPath, ...serverArgs], {
    stdio: 'inherit',
    cwd: projectRoot,
  });
  child.on('exit', (code) => process.exit(code || 0));
}

if (forceUninstall) {
  // Run uninstall hooks and exit
  const uninstall = spawn('node', [installHooksPath, '--uninstall'], {
    stdio: 'inherit',
    cwd: projectRoot,
  });
  uninstall.on('exit', (code) => process.exit(code || 0));
} else if (forceSetup || isFirstRun) {
  // Run setup wizard, then start server on success
  const setup = spawn('node', [setupPath], {
    stdio: 'inherit',
    cwd: projectRoot,
  });
  setup.on('exit', (code) => {
    if (code === 0) {
      startServer();
    } else {
      process.exit(code || 1);
    }
  });
} else {
  startServer();
}
