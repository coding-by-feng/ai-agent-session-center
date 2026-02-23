#!/usr/bin/env node
/**
 * capture-screenshots.mjs — Capture real dashboard screenshots for marketing website
 *
 * Strategy: Temporarily start a second server on port 4444 serving the vanilla
 * CSS dashboard (public/) by temporarily moving dist/client. This gives us the
 * beautiful CSS robot characters that render perfectly in headless Chromium.
 *
 * Usage: node scripts/capture-screenshots.mjs
 */
import { chromium } from 'playwright';
import { mkdirSync, existsSync, renameSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, '..');
const DIST_DIR = join(PROJECT_ROOT, 'dist', 'client');
const DIST_BAK = join(PROJECT_ROOT, 'dist', 'client-screenshot-bak');
const PORT = 4444;
const BASE = `http://localhost:${PORT}`;
const OUTPUT_DIR = join(PROJECT_ROOT, '..', 'ai-agent-session-center-website', 'public', 'images', 'screenshots');

const MOCK_SESSIONS = [
  // Session 1: Working (orange glow) — claude
  { id: 'ss-work-1', project: 'web-app', prompt: 'Refactor the authentication module to use JWT tokens', tool: 'Edit', model: 'claude-opus-4-6' },
  // Session 2: Working (orange glow) — claude
  { id: 'ss-work-2', project: 'api-server', prompt: 'Add rate limiting middleware to all API endpoints', tool: 'Bash', model: 'claude-sonnet-4-6' },
  // Session 3: Idle (green glow)
  { id: 'ss-idle-1', project: 'mobile-app', prompt: '', tool: null, model: 'claude-sonnet-4-6' },
  // Session 4: Prompting (cyan glow)
  { id: 'ss-prompt-1', project: 'data-pipeline', prompt: 'Optimize the ETL pipeline for incremental loads', tool: null, model: 'claude-opus-4-6' },
  // Session 5: Approval (yellow glow, pulsing)
  { id: 'ss-approval-1', project: 'infra-deploy', prompt: 'Deploy staging environment with new config', tool: 'Bash', model: 'claude-sonnet-4-6', label: 'IMPORTANT' },
  // Session 6: Input (purple glow)
  { id: 'ss-input-1', project: 'design-system', prompt: 'Create a color palette for the new theme', tool: 'AskUserQuestion', model: 'claude-haiku-4-5' },
  // Session 7: Gemini session (working)
  { id: 'ss-gemini-1', project: 'ml-pipeline', prompt: 'Train the recommendation model with new features', tool: null, model: 'gemini-2.5-pro', cli: 'gemini' },
  // Session 8: Codex session (idle)
  { id: 'ss-codex-1', project: 'docs-site', prompt: '', tool: null, model: 'codex-mini', cli: 'codex' },
];

async function sendHook(data) {
  try {
    await fetch(`${BASE}/api/hooks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
  } catch { /* ignore */ }
}

async function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function injectSessions() {
  const now = Date.now();

  for (const s of MOCK_SESSIONS) {
    // 1. SessionStart
    await sendHook({
      session_id: s.id,
      hook_event_name: 'SessionStart',
      project_name: s.project,
      working_directory: `/workspace/${s.project}`,
      model: s.model,
      timestamp: now - 600000,
    });
    await sleep(80);

    // 2. UserPromptSubmit (if has prompt)
    if (s.prompt) {
      await sendHook({
        session_id: s.id,
        hook_event_name: 'UserPromptSubmit',
        project_name: s.project,
        user_prompt: s.prompt,
        timestamp: now - 300000,
      });
      await sleep(80);
    }

    // 3. PreToolUse (for working/approval/input states)
    if (s.tool) {
      await sendHook({
        session_id: s.id,
        hook_event_name: 'PreToolUse',
        project_name: s.project,
        tool_name: s.tool,
        timestamp: now - 200000,
      });
      await sleep(80);

      // For approval: also send PermissionRequest to trigger approval state
      if (s.id === 'ss-approval-1') {
        await sendHook({
          session_id: s.id,
          hook_event_name: 'PermissionRequest',
          project_name: s.project,
          tool_name: s.tool,
          timestamp: now - 100000,
        });
        await sleep(80);
      }
    }

    // 4. For idle sessions: send Stop event
    if (!s.tool && !s.prompt) {
      await sendHook({
        session_id: s.id,
        hook_event_name: 'Stop',
        project_name: s.project,
        timestamp: now - 100000,
      });
      await sleep(80);
    }
  }

  console.log(`  Injected ${MOCK_SESSIONS.length} mock sessions`);
}

async function cleanupSessions() {
  for (const s of MOCK_SESSIONS) {
    await sendHook({
      session_id: s.id,
      hook_event_name: 'SessionEnd',
      timestamp: Date.now(),
    });
  }
}

async function waitForServer(maxMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    try {
      const res = await fetch(`${BASE}/api/sessions`);
      if (res.ok) return true;
    } catch { /* retry */ }
    await sleep(500);
  }
  return false;
}

async function main() {
  mkdirSync(OUTPUT_DIR, { recursive: true });

  // Step 1: Temporarily move dist/client so server falls back to public/
  const hadDist = existsSync(DIST_DIR);
  if (hadDist) {
    console.log('Moving dist/client aside for vanilla CSS dashboard...');
    renameSync(DIST_DIR, DIST_BAK);
  }

  // Step 2: Start temporary server on port 4444
  console.log(`Starting temporary dashboard server on port ${PORT}...`);
  const serverProc = spawn('node', ['server/index.js', '--no-open'], {
    cwd: PROJECT_ROOT,
    env: { ...process.env, PORT: String(PORT), DEBUG: '' },
    stdio: 'pipe',
  });

  // Collect stderr for debugging
  let serverErr = '';
  serverProc.stderr.on('data', d => { serverErr += d.toString(); });
  serverProc.stdout.on('data', d => { /* suppress */ });

  try {
    const ready = await waitForServer();
    if (!ready) {
      console.error('Server failed to start. stderr:', serverErr);
      throw new Error('Server timeout');
    }
    console.log('Server ready');

    // Step 3: Inject mock sessions
    console.log('Injecting mock sessions...');
    await injectSessions();
    await sleep(2000); // Let CSS animations settle

    // Step 4: Capture screenshots
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
      viewport: { width: 1400, height: 850 },
      deviceScaleFactor: 2,
    });

    try {
      // ---- Screenshot 1: Dashboard Overview (cards grid) ----
      console.log('Capturing: cyberdrome-overview...');
      const page1 = await context.newPage();
      await page1.goto(BASE, { waitUntil: 'networkidle' });
      await page1.waitForTimeout(3000);
      await page1.screenshot({ path: join(OUTPUT_DIR, 'cyberdrome-overview.png') });
      console.log('  Saved cyberdrome-overview.png');

      // ---- Screenshot 2: Detail Panel open ----
      console.log('Capturing: detail-panel...');
      // Click a working session card to open detail panel
      const card = await page1.$('.session-card');
      if (card) {
        await card.click();
        await page1.waitForTimeout(1500);
      }
      await page1.screenshot({ path: join(OUTPUT_DIR, 'detail-panel.png') });
      console.log('  Saved detail-panel.png');

      // ---- Screenshot 3: Cards with varied statuses ----
      console.log('Capturing: dashboard-cards...');
      const page3 = await context.newPage();
      await page3.goto(BASE, { waitUntil: 'networkidle' });
      await page3.waitForTimeout(2000);
      // Close any detail panel by clicking empty space
      await page3.click('body', { position: { x: 700, y: 400 } });
      await page3.waitForTimeout(500);
      // Scroll to show more cards if needed
      const grid = await page3.$('#sessions-grid, .sessions-grid');
      if (grid) {
        await grid.evaluate(el => el.scrollTop = 0);
      }
      await page3.screenshot({ path: join(OUTPUT_DIR, 'dashboard-cards.png') });
      console.log('  Saved dashboard-cards.png');

      // ---- Screenshot 4: Click a session to show different detail tab (Activity) ----
      console.log('Capturing: team-tracking...');
      const cards = await page3.$$('.session-card');
      if (cards.length > 1) {
        await cards[1].click();
        await page3.waitForTimeout(1000);
        // Try to click Activity tab
        const activityTab = await page3.$('[data-tab="activity"], .tab-btn:nth-child(4), button:has-text("Activity")');
        if (activityTab) {
          await activityTab.click();
          await page3.waitForTimeout(500);
        }
      }
      await page3.screenshot({ path: join(OUTPUT_DIR, 'team-tracking.png') });
      console.log('  Saved team-tracking.png');

      // ---- Screenshot 5: Approval state focus ----
      console.log('Capturing: approval-alerts...');
      const page5 = await context.newPage();
      await page5.goto(BASE, { waitUntil: 'networkidle' });
      await page5.waitForTimeout(2000);
      // Find the approval session card and click it
      const approvalCard = await page5.$('.session-card.status-approval, .session-card[data-status="approval"]');
      if (approvalCard) {
        await approvalCard.click();
        await page5.waitForTimeout(1000);
      }
      await page5.screenshot({ path: join(OUTPUT_DIR, 'approval-alerts.png') });
      console.log('  Saved approval-alerts.png');

    } finally {
      await browser.close();
    }

    // Step 5: Cleanup
    await cleanupSessions();

  } finally {
    // Kill the temporary server
    serverProc.kill('SIGTERM');
    await sleep(500);
    if (!serverProc.killed) serverProc.kill('SIGKILL');

    // Restore dist/client
    if (hadDist && existsSync(DIST_BAK)) {
      renameSync(DIST_BAK, DIST_DIR);
      console.log('Restored dist/client');
    }
  }

  console.log(`\nAll screenshots saved to: ${OUTPUT_DIR}`);
}

main().catch(err => {
  console.error('Failed:', err);
  // Ensure dist is restored on error
  if (existsSync(DIST_BAK) && !existsSync(DIST_DIR)) {
    renameSync(DIST_BAK, DIST_DIR);
    console.log('Restored dist/client after error');
  }
  process.exit(1);
});
