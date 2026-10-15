import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import express from 'express';
import { createServer, type Server } from 'http';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
const processCalls = vi.hoisted(() => vi.fn(() => { throw new Error('Retired route attempted subprocess'); }));
vi.mock('child_process', async original => ({...await original<typeof import('child_process')>(), spawn:processCalls, exec:processCalls, execFile:processCalls, spawnSync:processCalls,execSync:processCalls,execFileSync:processCalls}));
import { createResourceRouter } from '../server/resourceRouter.js';
let server: Server, url: string, home: string;
beforeAll(async () => {
  home=mkdtempSync(join(tmpdir(),'aasc-retired-routes-'));
  const app=express();app.use(express.json());
  app.use('/api/resources',createResourceRouter({home,env:{},sessionProjectPaths:()=>[],isLocalRequest:()=>true}));
  const {default:apiRouter}=await import('../server/apiRouter.js');app.use('/api',apiRouter);
  server=createServer(app);await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  url=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
});
afterAll(async()=>{await new Promise<void>(resolve=>server.close(()=>resolve()));rmSync(home,{recursive:true,force:true});});
it('retired_routes_start_no_process and return the unavailable envelope for every old surface',async()=>{
  const id='11111111-1111-4111-8111-111111111111';
  const paths=[['GET','transfers'],['POST','transfers/devices'],['POST',`transfers/devices/${id}/remove`],['POST','transfers/tasks'],...['compare','cancel','repeat','run'].map(op=>['POST',`transfers/tasks/${id}/${op}`]),['POST',`transfers/tasks/${id}/items/${id}/restore`],['GET','sync'],['POST','sync/links'],['POST',`sync/links/${id}/compare`],['POST',`sync/links/${id}/update`],['POST',`sync/links/${id}/remove`],['GET',`sync/runs/${id}`],['GET',`sync/runs/${id}/entries`],['GET',`sync/runs/${id}/entries/${id}/diff`],...['run','cancel','undo','decisions'].map(op=>['POST',`sync/runs/${id}/${op}`])];
  for(const [method,path] of paths){const response=await fetch(`${url}/api/resources/${path}`,{method,...(method==='GET'?{}:{headers:{'Content-Type':'application/json'},body:'{}'})});expect(response.status,path).toBe(404);expect(await response.json(),path).toEqual({success:false,error:'Not found'});}
  expect(processCalls).not.toHaveBeenCalled();
});
it('unrelated_ssh_still_routes without creating a terminal',async()=>{
  const response=await fetch(`${url}/api/terminals`);expect(response.status).toBe(200);expect(await response.json()).toEqual({terminals:[]});
});
