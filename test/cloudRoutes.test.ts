import express from 'express';
import { afterEach, expect, it } from 'vitest';
import { createResourceRouter, resourceErrorHandler } from '../server/resourceRouter.js';
import { cloudJsonParser } from '../server/cloud/router.js';
import { createCloudConnection } from '../server/cloud/connection.js';
import { createFileSecretStore } from '../server/cloud/secretStore.js';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { request as httpRequest } from 'node:http';
import { gzipSync } from 'node:zlib';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
const cleanup:(()=>Promise<unknown>)[]=[];
afterEach(async()=>{for(const c of cleanup.splice(0).reverse())await c();});
async function setup(isLocalRequest?:()=>boolean){
 const dir=await realpath(await mkdtemp(join(tmpdir(),'aasc-cloud-route-')));cleanup.push(()=>rm(dir,{recursive:true,force:true}));
 const cloud=await createCloudConnection({directory:join(dir,'cloud'),secrets:createFileSecretStore(join(dir,'secrets'))});cleanup.push(()=>cloud.stop());
 const app=express();app.use('/api/resources/cloud',cloudJsonParser());app.use(express.json({limit:'50mb'}));app.use('/api/resources',createResourceRouter({sessionProjectPaths:()=>[],home:dir,cloud,cloudAliasDirectory:join(dir,'cloud'),isLocalRequest}));app.use('/api/resources',resourceErrorHandler);
 const server=await new Promise<ReturnType<typeof app.listen>>(r=>{const s=app.listen(0,'127.0.0.1',()=>r(s));});cleanup.push(()=>new Promise<void>(r=>{server.closeAllConnections();server.close(()=>r());}));
 return {url:`http://127.0.0.1:${(server.address() as {port:number}).port}/api/resources/cloud`,cloud,dir};
}
it('only_loopback_can_configure; reads stay hidden too',async()=>{
 const f=await setup(()=>false);expect((await fetch(f.url+'/status')).status).toBe(404);expect((await fetch(f.url+'/connect',{method:'POST',headers:{'content-type':'application/json'},body:'{}'})).status).toBe(404);
});
it('cross_origin_post_refused',async()=>{
 const f=await setup();for(const headers of [{origin:'https://evil.example'}, {origin:'http://localhost:4555','sec-fetch-site':'same-site'}, {'sec-fetch-site':'cross-site'}] as Record<string,string>[]) {
 const res=await fetch(f.url+'/disconnect',{method:'POST',headers:{'content-type':'application/json',...headers},body:'{}'});expect([403,404]).toContain(res.status);
 }
});
it('same-origin JSON actions and disconnected status do not need cloud',async()=>{
 const f=await setup();expect((await fetch(f.url+'/status')).status).toBe(200);
 const result=await fetch(f.url+'/disconnect',{method:'POST',headers:{'content-type':'application/json','sec-fetch-site':'same-origin'},body:'{}'});expect(result.status).toBe(200);expect(f.cloud.status().connection).toBeNull();
 expect((await fetch(f.url+'/disconnect',{method:'POST',body:'{}'})).status).toBe(415);
});
it('cloud JSON limit is enforced before the production 50mb parser',async()=>{
 const f=await setup();const res=await fetch(f.url+'/connect',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({backendUrl:'https://example.com',pairingCode:'c'.repeat(22),deviceName:'x'.repeat(1024*1024)})});expect(res.status).toBe(413);
 expect(JSON.stringify(await res.json())).not.toContain('c'.repeat(22));
});
it('cross-origin loopback Origin without browser metadata cannot configure',async()=>{
 const f=await setup();const response=await fetch(f.url+'/disconnect',{method:'POST',headers:{'content-type':'application/json',origin:'http://localhost:4555'},body:'{}'});expect(response.status).toBe(403);
});

async function rawChunked(url:string, bytes:string|Buffer, encoding?:string){
 return await new Promise<{status:number;body:string}>((resolve,reject)=>{
  const req=httpRequest(url,{method:'POST',headers:{'content-type':'application/json','transfer-encoding':'chunked',...(encoding?{'content-encoding':encoding}:{})}},res=>{let body='';res.setEncoding('utf8');res.on('data',c=>body+=c);res.on('end',()=>resolve({status:res.statusCode!,body}));});
  req.on('error',reject);req.write(bytes);req.end();
 });
}
it.each([
 ['chunked whitespace',' '.repeat(1048577)+'{}',undefined],
 ['duplicate JSON keys','{'+('"x":0,').repeat(180000)+'"x":0}',undefined],
 ['expanded unicode encoding','{"x":"'+('\\u0061').repeat(180000)+'"}',undefined],
 ['decompressed gzip bytes',gzipSync(' '.repeat(1048577)+'{}'),'gzip'],
] as const)('raw cloud cap rejects %s before handler under actual parser arrangement',async(_label,body,encoding)=>{
 const f=await setup();const response=await rawChunked(f.url+'/disconnect',body,encoding);expect(response.status).toBe(413);expect(JSON.parse(response.body).success).toBe(false);
 await expect(readFile(join(f.dir,'cloud','connection.json'))).rejects.toThrow();
});

it.each(['disconnect','revoke','recheck'])('stale UI cannot %s the newly configured account',async(action)=>{
 const {createCloudRouter}=await import('../server/cloud/router.js');
 const {vi}=await import('vitest');
 const connection={backendOrigin:'https://new.example',accountId:'00000000-0000-4000-8000-000000000002',deviceId:'00000000-0000-4000-8000-000000000003',deviceName:'new',generation:4};
 const disconnectCloud=vi.fn(),revokeDevice=vi.fn();
 const cloud={status:()=>({connection,state:'connected' as const,lastError:null}),disconnectCloud,revokeDevice} as unknown as import('../server/cloud/types.js').CloudConnector;
 const app=express();app.use('/cloud',createCloudRouter(cloud,()=>true));const server=await new Promise<ReturnType<typeof app.listen>>(r=>{const s=app.listen(0,'127.0.0.1',()=>r(s));});cleanup.push(()=>new Promise<void>(r=>{server.closeAllConnections();server.close(()=>r());}));
 const res=await fetch(`http://127.0.0.1:${(server.address() as {port:number}).port}/cloud/${action}`,{method:'POST',headers:{'content-type':'application/json','x-aasc-cloud-backend':'https://old.example','x-aasc-cloud-account':'00000000-0000-4000-8000-000000000001','x-aasc-cloud-generation':'1'},body:'{}'});
 expect(res.status).toBe(409);expect(disconnectCloud).not.toHaveBeenCalled();expect(revokeDevice).not.toHaveBeenCalled();expect((await res.json()).error.code).toBe('connection_changed');
});
