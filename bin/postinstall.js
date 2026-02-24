#!/usr/bin/env node
// Postinstall script — shows version banner and setup progress

import { readFileSync, chmodSync, existsSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, '..');

// ── ANSI colors ──
const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const GREEN = '\x1b[32m';
const CYAN = '\x1b[36m';
const YELLOW = '\x1b[33m';

// ── Read version from package.json ──
let version = 'unknown';
try {
  const pkg = JSON.parse(readFileSync(join(projectRoot, 'package.json'), 'utf8'));
  version = pkg.version;
} catch { /* ignore */ }

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// ── Animated progress bar ──
async function animatedProgress(label, stepFn) {
  const width = 30;
  // Animate filling up
  for (let i = 0; i <= width; i += 3) {
    const filled = Math.min(i, width);
    const bar = '█'.repeat(filled) + '░'.repeat(width - filled);
    const pct = Math.round((filled / width) * 100);
    process.stdout.write(`\r  ${DIM}${label}${RESET} ${GREEN}${bar}${RESET} ${pct}%`);
    await sleep(20);
  }
  // Run the actual step
  const result = stepFn ? stepFn() : undefined;
  // Complete the bar
  const bar = '█'.repeat(width);
  process.stdout.write(`\r  ${DIM}${label}${RESET} ${GREEN}${bar}${RESET} ${GREEN}done${RESET}\n`);
  return result;
}

// ── Banner ──
console.log('');
console.log(`${CYAN}╭──────────────────────────────────────────────────────╮${RESET}`);
console.log(`${CYAN}│${RESET}  ${BOLD}AI Agent Session Center${RESET}  v${version}                     ${CYAN}│${RESET}`);
console.log(`${CYAN}╰──────────────────────────────────────────────────────╯${RESET}`);
console.log('');

// ── Step 1: Fix native module permissions ──
await animatedProgress('Setting up native modules...', () => {
  if (process.platform !== 'win32') {
    try {
      const prebuildsDir = join(projectRoot, 'node_modules', 'node-pty', 'prebuilds');
      if (existsSync(prebuildsDir)) {
        const dirs = readdirSync(prebuildsDir);
        for (const dir of dirs) {
          const helper = join(prebuildsDir, dir, 'spawn-helper');
          if (existsSync(helper)) {
            chmodSync(helper, 0o755);
          }
        }
      }
    } catch { /* non-critical */ }
  }
});

// ── Step 2: Verify dependencies ──
const missing = await animatedProgress('Verifying dependencies...   ', () => {
  const criticalDeps = ['express', 'ws', 'better-sqlite3', 'tsx'];
  return criticalDeps.filter(dep =>
    !existsSync(join(projectRoot, 'node_modules', dep))
  );
});

// ── Step 3: Finalize ──
await animatedProgress('Finalizing installation...  ');

console.log('');
if (missing.length > 0) {
  console.log(`  ${YELLOW}⚠ Missing dependencies: ${missing.join(', ')}${RESET}`);
  console.log(`  ${DIM}Run: npm install${RESET}`);
} else {
  console.log(`  ${GREEN}✓${RESET} All dependencies installed`);
}

console.log('');
console.log(`  ${DIM}Start the dashboard:${RESET}`);
console.log(`    ${BOLD}ai-agent-session-center${RESET}          ${DIM}# if installed globally${RESET}`);
console.log(`    ${BOLD}npx ai-agent-session-center${RESET}      ${DIM}# via npx${RESET}`);
console.log('');
console.log(`  ${DIM}Options:${RESET}`);
console.log(`    ${BOLD}--setup${RESET}       ${DIM}Interactive setup wizard${RESET}`);
console.log(`    ${BOLD}--port 4444${RESET}   ${DIM}Custom port${RESET}`);
console.log(`    ${BOLD}--uninstall${RESET}   ${DIM}Remove hooks${RESET}`);
console.log('');
