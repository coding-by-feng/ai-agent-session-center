// Isolated browser regression against compiled Lite/Full UI and synthetic transport.
import { chromium } from '@playwright/test';
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import assert from 'node:assert/strict';
const out = resolve('output/mobile-restore');
await mkdir(out, { recursive: true });
const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/embed') {
    res.setHeader('Content-Type', 'text/html');
    res.end('<meta name="viewport" content="width=device-width, initial-scale=1"><body style="margin:0;background:#0b1224"><h3 style="color:white">Lite workspace</h3><iframe title="Workspace" style="width:calc(100% - 18px);height:650px;margin:8px;border:1px solid #394157" src="/ui/lite/"></iframe>'); return;
  }
  try {
    const match = url.pathname.match(/^\/ui\/(lite|full)\/(.*)$/);
    if (!match) throw Error('path');
    const root = resolve('dist/hosted', match[1]);
    const file = resolve(root, match[2] || 'index.html');
    if (!file.startsWith(root + '/')) throw Error('path');
    let body = await readFile(file);
    if (extname(file) === '.html' && !url.searchParams.has('standalone')) body = body.toString().replace('<head>', `<head><meta name="aasc-hosted-parent" content="http://localhost"><meta name="aasc-ui-base" content="/ui/${match[1]}">`);
    res.setHeader('Content-Type', { '.js': 'application/javascript', '.css': 'text/css', '.html': 'text/html' }[extname(file)] || 'application/octet-stream');
    res.end(body);
  } catch { res.statusCode = 404; res.end(); }
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
const snapshot = { version: 1, exportedAt: Date.now() - 7200000, rooms: [], sessions: [
  ['term-shell', 'VPS Terminal', '/bin/bash', false],
  ['term-claude', 'Claude — a project with a long title', '/usr/local/bin/claude', true],
  ['term-codex', 'Codex', 'codex', true],
].map(([id, title, command, pinned]) => ({ originalSessionId: id, title, pinned, sshConfig: { host: 'localhost', port: 22, username: 'fixture', authMethod: 'key', command, workingDir: '/var/lib/aasc/workspace/a-project-with-a-long-folder-name' }, enableOpsTerminal: false, projectTabs: null })) };
const live = { 'live-conversation': { sessionId: 'live-conversation', title: 'Live Claude', status: 'idle', projectName: 'workspace', cwd: '/workspace', cliSource: 'claude', terminalId: 'live-pty', source: 'ssh', events: [], promptHistory: [], toolLog: [], lastActivityAt: Date.now() } };
const browser = await chromium.launch({ channel: 'chrome', headless: true });
async function setup(viewport, theme = 'solarized') {
  const context = await browser.newContext({ viewport, isMobile: viewport.width < 700, hasTouch: true });
  const requests = [], errors = [];
  await context.addInitScript(theme => { localStorage.setItem('theme', theme); }, theme);
  await context.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname; requests.push(path);
    let body = { success: true, data: [] };
    if (path === '/api/auth/status') body = { passwordRequired: false, authenticated: true };
    if (path === '/api/settings') body = { success: true, data: {} };
    if (path === '/api/workspace/restore-claim') body = { granted: true };
    if (path === '/api/workspace/load') body = snapshot;
    if (path === '/api/sessions') body = live;
    if (path === '/api/workspace/continuation') body = route.request().method() === 'PUT' ? { revision: 1 } : { records: [] };
    await route.fulfill({ json: body });
  });
  await context.routeWebSocket('**/*', ws => ws.send(JSON.stringify({ type: 'snapshot', seq: 1, sessions: live })));
  const page = await context.newPage(); page.setDefaultTimeout(10000);
  page.on('pageerror', e => errors.push(e.message));
  return { context, page, requests, errors };
}
try {
  for (const [width, height, theme] of [[320,568,'solarized'],[390,680,'solarized'],[430,800,'light'],[390,360,'solarized'],[390,680,'cyberpunk'],[1280,800,'solarized']]) {
    const { context, page, requests, errors } = await setup({width,height},theme);
    await page.goto(base + '/ui/lite/?standalone=1');
    const dialog = page.getByRole('dialog', { name: 'Restore workspace' }); await dialog.waitFor();
    await page.evaluate(theme => new Promise((resolve, reject) => {
      const request = indexedDB.open('claude-dashboard');
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const db = request.result, tx = db.transaction('settings', 'readwrite');
        tx.objectStore('settings').put({ key: 'themeName', value: theme, updatedAt: Date.now() });
        tx.oncomplete = () => { db.close(); resolve(); };
        tx.onerror = () => reject(tx.error);
      };
    }), theme);
    await page.goto(base + '/ui/lite/?standalone=1'); await dialog.waitFor();
    assert.equal(await page.locator('body').getAttribute('data-theme'), theme);
    assert(requests.includes('/api/workspace/load'), 'fixture must exercise real snapshot loader');
    assert.equal(await page.locator('[title="Will start a fresh conversation"]').count(), 2, 'plain terminal must not be marked fresh');
    assert.equal(await page.evaluate(() => document.activeElement?.tagName), 'BODY', 'do not open the phone keyboard automatically');
    const geometry = await dialog.evaluate(el => {
      const p = el.firstElementChild, r = p.getBoundingClientRect();
      return { left:r.left,right:r.right,top:r.top,bottom:r.bottom,viewport:innerWidth,height:innerHeight,overflow:p.scrollWidth-p.clientWidth };
    });
    assert(geometry.left >= 0 && geometry.right <= width && geometry.top >= 0 && geometry.bottom <= height, JSON.stringify(geometry));
    assert(geometry.overflow <= 1, 'picker content overflows horizontally');
    for (const name of ['All','None','★ Pinned','Resume nothing','Resume all (3)','Resume selected (3/3)']) {
      const button = dialog.getByRole('button',{name,exact:true}); await button.scrollIntoViewIfNeeded();
      const box = await button.boundingBox(); assert(box.x >= 0 && box.x+box.width <= width && box.y >= 0 && box.y+box.height <= height, name);
      if (width < 700) assert(box.height >= 44, name+' touch target');
    }
    if (height > 480) await page.screenshot({ path: `${out}/picker-${width}-${height}-${theme}.png` });
    await page.getByRole('textbox', {name:'Search saved sessions'}).fill('Claude');
    assert.equal(await dialog.getByRole('button',{name:'Resume selected (3/3)',exact:true}).count(),1);
    await dialog.getByRole('button',{name:'None',exact:true}).click();
    assert(await dialog.getByRole('button',{name:'Resume selected (0/3)'}).isDisabled());
    assert(!requests.includes('/api/sessions/clear-all'));
    assert.deepEqual(errors, []); await context.close();
    console.log(`picker ${width}x${height} ${theme}: PASS`);
  }
  for (const path of ['/ui/lite/','/ui/full/','/embed']) {
    const {context,page,requests,errors} = await setup({width:390,height:844});
    for (let visit=0;visit<2;visit++) {
      if (visit) await page.reload(); else await page.goto(base+path);
      const surface = path === '/embed' ? page.frameLocator('iframe') : page;
      await surface.getByText('Ready for a prompt', {exact:true}).waitFor();
      // Give the desktop restore timer a chance to fire; it must be suppressed.
      await page.waitForTimeout(1600);
      assert.equal(await surface.getByRole('dialog',{name:'Restore workspace'}).count(),0);
      assert(requests.includes('/api/workspace/continuation'), 'hosted continuation must run');
      assert.equal(await surface.getByText('接续信息格式无效。', {exact:true}).count(),0);
      assert(!requests.includes('/api/workspace/restore-claim'));
      assert(!requests.includes('/api/sessions/clear-all'));
    }
    await page.screenshot({path:`${out}/hosted-${path.replaceAll('/','')}.png`});
    assert.deepEqual(errors,[]); await context.close();
    console.log(`${path} cold open and reload preserve live workspace: PASS`);
  }
} finally { await browser.close(); server.closeAllConnections(); await new Promise(r=>server.close(r)); }
