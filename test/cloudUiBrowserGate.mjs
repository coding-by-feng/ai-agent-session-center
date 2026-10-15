/** Synthetic UI acceptance only. No server/index.ts, hooks, real resources, Git, BE, or user browser. */
import {createServer} from 'vite';
import react from '@vitejs/plugin-react';
import {chromium} from 'playwright';
import {mkdtemp,rm,mkdir,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve,join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import assert from 'node:assert/strict';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..'),tmp=await mkdtemp(join(tmpdir(),'aasc-cloud-ui-'));
const screenshotDir=join(root,'test-screenshots/task13');await mkdir(screenshotDir,{recursive:true});
const account=randomUUID(),resourceId=randomUUID(),projectId=randomUUID();
const connection={backendOrigin:'https://fixture.invalid',accountId:account,generation:1,deviceId:randomUUID(),deviceName:'Fixture Mac'};
let state='connected',installAction='add',conflict=false,localState='missing';
const files=[{path:'test-workflow/SKILL.md',sha256:'a'.repeat(64),bytes:240,mode:420}];
const manifest={resourceId,agent:'claude',kind:'skill',name:'Test workflow',scope:'global',projectId:null,files,dependencies:[]};
const version={manifest,version:1,digest:'a'.repeat(64),createdAt:'2026-10-10T00:00:00.000Z'};
let projects=[{id:projectId,version:1,name:'Demo workspace',repository:{provider:'github',owner:'fixture',name:'workspace',url:'https://github.com/fixture/workspace',branch:'main'},description:'Fixture project with separately reviewed resource pins',resources:[{resourceId,version:1}],deleted:false}];
const summary={id:'local-workflow',type:'skill',agent:'claude',scope:'global',name:'Test workflow',description:'Reusable testing instructions',origin:'user',format:'markdown',path:'~/.claude/skills/test-workflow',fileCount:1,bytes:240,mtimeMs:Date.now(),hash:'a'.repeat(64),repo:{status:'not-tracked'},variantIds:[],findingCodes:[]};
const catalog={state:'ready',scannedAt:Date.now(),roots:{claude:'~/.claude',codex:'~/.codex',shared:'~/.agents',repo:null},projects:[{id:'local-project',name:'Demo workspace',path:'/fixture/workspace',exists:true,evidence:[],counts:{}}],resources:[summary,{...summary,id:'blocked',name:'Local settings',type:'settings'}],findings:[],coverage:[]};
const jobs=new Map(),plans=new Map(),calls=[];let installs=0;const errors=[];
const newJob=(kind,jobState='complete',steps=[{id:'resource',label:'Test workflow',state:'complete'}])=>{const job={id:randomUUID(),kind,state:jobState,steps};jobs.set(job.id,job);return job;};
const plan=()=>{const p={id:randomUUID(),items:[{id:randomUUID(),resourceId,version:1,destinationLabel:'~/.claude/skills/test-workflow',action:installAction,files:[{path:'test-workflow/SKILL.md',change:installAction==='add'?'add':'change'}]}]};plans.set(p.id,p);return p;};
const vite=await createServer({root,configFile:false,cacheDir:join(tmp,'vite'),optimizeDeps:{entries:['test/fixtures/cloud-ui-browser.tsx']},resolve:{alias:{'@':join(root,'src')}},plugins:[react({exclude:/\/vite\/deps\//}),{name:'cloud-ui-fixture',configureServer(server){server.middlewares.use(async(req,res,next)=>{
 const u=new URL(req.url,'http://fixture.local');
 if(u.pathname==='/resources'||u.pathname==='/project-browser'){res.setHeader('Content-Type','text/html');res.end('<html><head><meta name="viewport" content="width=device-width, initial-scale=1"><script type="module">import RefreshRuntime from "/@react-refresh";RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>(type)=>type;window.__vite_plugin_react_preamble_installed__=true;</script></head><body><div id="root"></div><script type="module" src="/test/fixtures/cloud-ui-browser.tsx"></script></body></html>');return;}
 if(!u.pathname.startsWith('/api/'))return next();
 const chunks=[];for await(const chunk of req)chunks.push(chunk);const body=chunks.length?JSON.parse(Buffer.concat(chunks).toString()):{};calls.push({path:u.pathname,method:req.method,body,headers:req.headers});res.setHeader('content-type','application/json');const send=data=>res.end(JSON.stringify({success:true,data}));const fail=(code,message,status=409)=>{res.statusCode=status;res.end(JSON.stringify({success:false,error:{code,message}}));};
 if(u.pathname==='/api/resources')return send(catalog);
 if(u.pathname==='/api/resources/cloud/skill-notes/status')return send({connection:{backendOrigin:connection.backendOrigin,accountId:account,generation:1},state});
 if(u.pathname==='/api/resources/cloud/skill-notes')return send({records:[],cursor:'fixture',hasMore:false});
 const p=u.pathname.replace('/api/resources/cloud','');
 if(p==='/status')return send({connection,state,lastError:null});
 if(!u.pathname.startsWith('/api/resources/cloud'))return fail('fixture_unhandled',u.pathname,404);
 if(!p.startsWith('/jobs/')&&!['/connect','/status'].includes(p)){
  if(req.headers['x-aasc-cloud-backend']!==connection.backendOrigin||req.headers['x-aasc-cloud-account']!==account||req.headers['x-aasc-cloud-generation']!=='1')return fail('connection_changed','Review the current account.');
 }
 if(p==='/resources')return state==='offline'?fail('offline','Fixture offline',503):send({items:[version],nextCursor:null});
 if(p==='/publish-plans'){const publication={id:randomUUID(),items:[{catalogId:summary.id,manifest,sourceDigest:'a'.repeat(64),baseVersion:null}],blocked:[{catalogId:'blocked',reason:'Settings require a dedicated credential-free adapter.'}]};plans.set(publication.id,publication);return send(publication);}
 if(/^\/publish-plans\/[^/]+\/run$/.test(p))return send(newJob('publish'));
 if(p==='/install-plans')return send(plan());
 if(/^\/install-plans\/[^/]+\/run$/.test(p)){installs++;return send(newJob('install','complete',[{id:'resource',label:'Test workflow',state:'complete',receiptId:randomUUID()}]));}
 if(p==='/downloads')return send(newJob('download'));
 if(/^\/downloads\/[^/]+\/file$/.test(p)){res.setHeader('content-type','application/zip');res.end('fixture portable ZIP payload');return;}
 if(p==='/projects'&&req.method==='GET')return send({items:projects,nextCursor:null});
 if((p==='/projects'&&req.method==='POST')||(/^\/projects\/[^/]+$/.test(p)&&req.method==='PUT')){if(conflict)return fail('version_conflict','Cloud version changed. Review latest.');const saved={...body.value,version:(body.baseVersion??0)+1};projects=[...projects.filter(p=>p.id!==saved.id),saved];return send(saved);}
 if(/^\/projects\/[^/]+$/.test(p))return send(projects.find(x=>x.id===p.split('/')[2]));
 if(p.endsWith('/local')||p.endsWith('/associate')){if(p.endsWith('/associate'))localState='ready';return send({state:localState,branch:localState==='missing'?null:'main',localProjectId:localState==='missing'?null:'local-project',openUrl:localState==='missing'?null:'/project-browser?path=%2Ffixture%2Fworkspace'});}
 if(p.endsWith('/get')){localState='ready';return send(newJob('get-project','partial',[{id:'git',label:'Git checkout',state:'complete'},{id:'resources',label:'Resource installation',state:'failed',error:'Replacement requires review'}]));}
 if(p.endsWith('/resources-plan'))return send(plan());
 if(p.endsWith('/retry-resources')){const id=p.split('/')[3],job={...jobs.get(id),state:'complete',steps:[{id:'git',label:'Git checkout',state:'complete'},{id:'resources',label:'Resource installation',state:'complete'}]};jobs.set(id,job);return send(job);}
 if(/^\/jobs\/[^/]+$/.test(p))return send(jobs.get(p.split('/')[2]));
 return fail('fixture_unhandled',p,404);
 });}}],server:{host:'127.0.0.1',port:0,strictPort:true,cors:false}});
let browser;
try{await vite.listen();const origin=`http://127.0.0.1:${vite.httpServer.address().port}`;browser=await chromium.launch({headless:true});const context=await browser.newContext({viewport:{width:1365,height:1050}});const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
 await page.goto(origin+'/resources?section=cloud&cloudTab=resources');await page.getByRole('heading',{name:'Cloud resource versions'}).waitFor();await page.getByRole('button',{name:'Download',exact:true}).waitFor();
 assert.deepEqual(await page.getByRole('tablist',{name:'Resource sections'}).getByRole('tab').allTextContents(),['Library','Sources','Checks','Cloud']);
 if(process.argv.includes('--comparison-only')) {
  await page.getByRole('tab',{name:'Projects',exact:true}).last().click();
  await page.getByRole('button',{name:'Edit project'}).click();
  await page.getByLabel('Project name').fill('My unsaved project title');
  projects=[{...projects[0],version:2,name:'Latest saved project title',description:'Changed in the cloud after this editor opened.',repository:{...projects[0].repository,branch:'release'},resources:[]}];
  await page.getByRole('button',{name:'Load latest for comparison'}).click();
  await page.getByRole('region',{name:'Revision comparison'}).waitFor();
  await page.getByRole('region',{name:'Revision comparison'}).scrollIntoViewIfNeeded();
  await page.screenshot({animations:'disabled',path:join(screenshotDir,'comparison-desktop.png')});
  await page.setViewportSize({width:390,height:844});
  await page.getByRole('region',{name:'Revision comparison'}).scrollIntoViewIfNeeded();
  await page.screenshot({animations:'disabled',path:join(screenshotDir,'comparison-390.png')});
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  await page.getByRole('button',{name:'Keep my draft using this reviewed revision'}).click();
  assert.equal(await page.getByLabel('Project name').inputValue(),'My unsaved project title');
  assert.equal(errors.length,0,errors.join('\n'));
  console.log(JSON.stringify({pass:true,mode:'comparison-only',runtimeErrors:errors,requests:calls.length,scope:'Synthetic API; actual themed project editor and explicit revision adoption.'}));
 } else {
 await page.getByRole('checkbox',{name:/Select global resources/}).check();await page.getByRole('button',{name:'Review selected resources'}).click();await page.getByText('1 ready · 1 blocked').waitFor();await page.screenshot({animations:'disabled',path:join(screenshotDir,'publication-desktop.png')});await page.getByRole('button',{name:'Publish reviewed resources'}).click();await page.getByText('Save to cloud · complete').waitFor();
 // Fresh independent browser storage: installation must still be an explicit action.
 const receiver=await browser.newContext({viewport:{width:1365,height:900}}),second=await receiver.newPage();second.on('pageerror',e=>errors.push(e.message));await second.goto(origin+'/resources?section=cloud&cloudTab=resources');await second.getByRole('button',{name:'Install on this device',exact:true}).click();await second.getByRole('button',{name:'Install reviewed resources'}).click();await second.getByText('Install · complete').waitFor();assert.equal(installs,1);await receiver.close();
 installAction='replace';await page.getByRole('button',{name:'Install on this device',exact:true}).click();assert.equal(await page.getByRole('button',{name:'Install reviewed resources'}).isEnabled(),false);await page.getByLabel('Decision for ~/.claude/skills/test-workflow').selectOption('replace-with-backup');await page.screenshot({animations:'disabled',path:join(screenshotDir,'replacement-desktop.png')});await page.getByRole('button',{name:'Install reviewed resources'}).click();await page.getByText('Install · complete').waitFor();assert.equal(installs,2);
 await page.getByRole('button',{name:'Download',exact:true}).click();const downloadEvent=page.waitForEvent('download');await page.getByRole('button',{name:'Save ZIP'}).click();await downloadEvent;assert.equal(installs,2);
 await page.getByRole('tab',{name:'Projects',exact:true}).last().click();await page.getByRole('button',{name:'Get project',exact:true}).click();await page.getByLabel('Parent folder on this device').fill('/fixture/receiving');await page.getByRole('button',{name:'Start Get project'}).click();await page.getByText('Get project · partially complete').waitFor();await page.getByRole('link',{name:'Open project'}).waitFor();await page.screenshot({animations:'disabled',path:join(screenshotDir,'project-partial-desktop.png')});const cloneCalls=calls.filter(c=>c.path.endsWith('/get')).length;await page.getByRole('button',{name:'Review resources for retry'}).click();await page.getByRole('button',{name:'Compare resources for retry'}).click();await page.getByLabel('Decision for ~/.claude/skills/test-workflow').selectOption('replace-with-backup');await page.getByRole('button',{name:'Install reviewed resources'}).click();await page.getByText('Get project · complete').waitFor();assert.equal(calls.filter(c=>c.path.endsWith('/get')).length,cloneCalls);
 // Revision conflict keeps user's draft and exposes a fresh comparison.
 await page.getByRole('button',{name:'Edit project'}).click();await page.getByLabel('Project name').fill('Draft stays visible');conflict=true;await page.getByRole('button',{name:'Save project details'}).click();await page.getByText(/Your draft is preserved/).waitFor();assert.equal(await page.getByLabel('Project name').inputValue(),'Draft stays visible');await page.setViewportSize({width:390,height:844});await page.screenshot({animations:'disabled',path:join(screenshotDir,'project-conflict-390.png')});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));conflict=false;
 await page.getByRole('tab',{name:'Connection',exact:true}).click();await page.getByRole('heading',{name:'Device connection'}).waitFor();await page.screenshot({animations:'disabled',path:join(screenshotDir,'connection-390.png')});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
 // Keyboard review focus trap + restoration on Escape.
 await page.getByRole('tab',{name:'Resources',exact:true}).click();const trigger=page.getByRole('button',{name:'Install on this device',exact:true});await trigger.click();await page.getByRole('dialog').waitFor();await page.keyboard.press('Shift+Tab');assert.ok(await page.getByRole('dialog').evaluate(el=>el.contains(document.activeElement)));await page.keyboard.press('Escape');await page.getByRole('dialog').waitFor({state:'hidden'});assert.ok(await trigger.evaluate(el=>el===document.activeElement));await page.screenshot({animations:'disabled',path:join(screenshotDir,'resources-390.png')});
 state='offline';await page.getByRole('button',{name:'Refresh connection',exact:true}).click();await page.getByText(/Cached browse · stale/).waitFor();assert.equal(await trigger.isEnabled(),false);await page.screenshot({animations:'disabled',path:join(screenshotDir,'offline-390.png')});assert.equal(errors.length,0,errors.join('\n'));
 const report={pass:true,runtimeErrors:errors,installs,cloneCalls,requests:calls.length,screenshots:screenshotDir,scope:'Themed production React components against synthetic fixture APIs; no live BE, Git or filesystem install exercised.'};await writeFile(join(screenshotDir,'result.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
}
}finally{await browser?.close();await vite.close();await rm(tmp,{recursive:true,force:true});}
