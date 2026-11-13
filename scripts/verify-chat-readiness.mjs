// Compiled Lite/Full regression. Transport is synthetic; real hooks need live verification.
import { chromium, expect } from '@playwright/test';
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import assert from 'node:assert/strict';
const out = resolve('output/claude-readiness');
await mkdir(out, { recursive: true });
const server = createServer(async (req, res) => {
  try {
    const path = new URL(req.url, 'http://localhost').pathname;
    const match = path.match(/^\/ui\/(lite|full)\/(.*)$/);
    if (!match) throw Error('path');
    const root = resolve('dist/hosted', match[1]), file = resolve(root, match[2] || 'index.html');
    if (!file.startsWith(root + '/')) throw Error('path');
    let body = await readFile(file);
    if (extname(file) === '.html') body = body.toString().replace('<head>', `<head><meta name="aasc-hosted-parent" content="http://localhost"><meta name="aasc-ui-base" content="/ui/${match[1]}">`);
    res.setHeader('Content-Type', {'.js':'application/javascript','.css':'text/css','.html':'text/html'}[extname(file)] || 'application/octet-stream');
    res.end(body);
  } catch { res.statusCode = 404; res.end(); }
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({channel:'chrome',headless:true});
try {
  for (const [edition,width,height,theme] of [['lite',320,568,'solarized'],['lite',390,844,'cyberpunk'],['full',390,844,'light']]) {
    const context = await browser.newContext({viewport:{width,height},isMobile:true,hasTouch:true});
    let session = {sessionId:'readiness-claude',title:'Claude',status:'idle',projectName:'workspace',cwd:'/workspace',cliSource:'claude',terminalId:'live-pty',startHeard:false,source:'ssh',events:[],promptHistory:[],toolLog:[],lastActivityAt:Date.now(),model:''};
    const sockets = [], requests = [], errors = [];
    await context.route('**/api/**', async route => {
      const req = route.request(), path = new URL(req.url()).pathname;
      let body = {success:true,data:[]}, status = 200;
      if (path === '/api/auth/status') body = {passwordRequired:false,authenticated:true};
      if (path === '/api/settings') body = {success:true,data:{}};
      if (path === '/api/workspace/load') body = null;
      if (path === '/api/workspace/continuation') body = req.method() === 'PUT' ? {revision:1} : {records:[]};
      if (path === '/api/sessions') body = {[session.sessionId]:session};
      if (path.endsWith('/chat')) body = {success:true,data:{entries:[],before:null,after:null,cli:'claude',hasMore:false}};
      if (path.endsWith('/context-breakdown')) body = {success:true,data:null};
      if (path.endsWith('/prompt') && req.method()==='POST') {
        requests.push(req.postDataJSON()); status=202; body={success:true,data:{accepted:true,key:req.postDataJSON().key}};
      }
      if (path.includes('/prompt/')) body = {success:true,data:{state:'submitted'}};
      await route.fulfill({status,json:body});
    });
    await context.routeWebSocket('**/*', ws => { sockets.push(ws); ws.send(JSON.stringify({type:'snapshot',sessions:{[session.sessionId]:session}})); });
    const page = await context.newPage(); page.setDefaultTimeout(12000); page.on('pageerror',e=>errors.push(e.message));
    const url = `${base}/ui/${edition}/?m=/sessions/${session.sessionId}/chat`;
    await page.goto(url);
    await page.getByText('Needs recovery',{exact:true}).waitFor();
    await page.evaluate(theme => new Promise((resolve,reject)=>{
      const request=indexedDB.open('claude-dashboard'); request.onerror=()=>reject(request.error);
      request.onsuccess=()=>{const db=request.result,tx=db.transaction('settings','readwrite');tx.objectStore('settings').put({key:'themeName',value:theme,updatedAt:Date.now()});tx.oncomplete=()=>{db.close();resolve()};tx.onerror=()=>reject(tx.error)};
    }),theme);
    await page.reload(); await page.getByText('Needs recovery',{exact:true}).waitFor();
    const box=page.getByRole('textbox',{name:'Message to Claude'}), send=page.getByRole('button',{name:'Send',exact:true});
    await box.fill('hi'); await expect(send).toHaveAttribute('aria-disabled','true');
    await send.click({force:true}); assert.equal(requests.length,0,'blocked send must not reach API');
    await expect(box).toHaveValue('hi');
    const terminal=page.getByRole('button',{name:'Open Terminal',exact:true}); await terminal.waitFor();
    assert(await terminal.isEnabled(),'recovery remains reachable');
    assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'no horizontal overflow');
    await page.screenshot({path:`${out}/${edition}-${width}-${theme}-recovery.png`});
    // Warm update confirms startup without losing the draft or reloading the page.
    session={...session,startHeard:true};
    sockets.at(-1).send(JSON.stringify({type:'session_update',session}));
    await expect(page.getByText('Needs recovery',{exact:true})).toHaveCount(0);
    await expect(box).toHaveValue('hi'); await expect(send).not.toHaveAttribute('aria-disabled','true');
    await send.click(); await expect.poll(()=>requests.length).toBe(1); assert.equal(requests[0].text,'hi');
    await page.screenshot({path:`${out}/${edition}-${width}-${theme}-ready.png`});
    // A disconnected terminal is not a ready session, including on a cold reload.
    session={...session,terminalId:null,startHeard:true}; await page.reload();
    await page.getByText('Needs recovery',{exact:true}).waitFor();
    await box.fill('saved draft'); await expect(send).toHaveAttribute('aria-disabled','true');
    assert.equal(requests.length,1); assert.deepEqual(errors,[]); await context.close();
    console.log(`${edition} ${width} ${theme}: timeout + cold missing terminal + warm recovery + preserved draft + single send PASS`);
  }
} finally {await browser.close();server.closeAllConnections();await new Promise(r=>server.close(r));}
