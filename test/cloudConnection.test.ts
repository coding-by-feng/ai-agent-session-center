import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server, type RequestListener } from 'node:http';
import { createCloudConnection } from '../server/cloud/connection.js';
import { createFileSecretStore, createEncryptedSecretStore } from '../server/cloud/secretStore.js';
const owner = 'd23c54de-1b99-4802-87bf-d84ddba2fdf1';
const device = 'ddf341c5-6747-4d12-a012-e29034536836';
const token = 't'.repeat(43);
const code = 'c'.repeat(22);
const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const clean of cleanups.splice(0).reverse()) await clean(); });
async function fixture(handler?: RequestListener) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'aasc-cloud-test-')));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  let calls = 0;
  const server = createServer((req, res) => {
    calls++;
    if (handler) return handler(req, res);
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ success: true, data: req.url === '/v1/devices/pair' ? { token, ownerId: owner, deviceId: device } : { status: 'ok', contractVersion: 1, ownerId: owner, deviceId: device } }));
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  cleanups.push(() => new Promise<void>(r => { server.closeAllConnections(); server.close(() => r()); }));
  const url = `http://127.0.0.1:${(server.address() as {port:number}).port}`;
  const secrets = createFileSecretStore(join(dir, 'secrets'));
  const cloud = await createCloudConnection({ directory: join(dir, 'config'), secrets, timeoutMs: 200 });
  cleanups.push(() => cloud.stop());
  return { dir, cloud, secrets, url, calls: () => calls, connect: () => cloud.connectCloud({ backendUrl: url, pairingCode: code, deviceName: 'Test device' }) };
}
describe('optional cloud connector', () => {
  it('off_by_default_makes_no_request', async () => {
    const f = await fixture();
    expect(f.cloud.status().state).toBe('disconnected');
    await expect(f.cloud.client.request('GET', '/v1/health')).rejects.toThrow('disconnected');
    expect(f.calls()).toBe(0);
  });
  it('token_not_in_status and identity survives reload', async () => {
    const f = await fixture(); const c = await f.connect();
    expect(c).toEqual({ backendOrigin: f.url, accountId: owner, deviceId: device, deviceName: 'Test device', generation: 1 });
    expect(JSON.stringify(f.cloud.status())).not.toContain(token);
    expect(await readFile(join(f.dir, 'config', 'connection.json'), 'utf8')).not.toContain(token);
    const loaded = await createCloudConnection({ directory: join(f.dir, 'config'), secrets: f.secrets });
    cleanups.push(() => loaded.stop());
    expect(loaded.status().connection).toEqual(c);
    expect(f.calls()).toBe(1);
  });
  it.each(['https://user:pass@example.com', 'https://example.com/path', 'https://example.com?x=y', 'https://example.com#x', 'http://example.com', 'file:///tmp/x', 'http://127.0.0.2'])('refuses unsafe origin %s before requesting', async backendUrl => {
    const f = await fixture();
    await expect(f.cloud.connectCloud({ backendUrl, pairingCode: code, deviceName: 'Test' })).rejects.toThrow();
    expect(f.calls()).toBe(0);
  });
  it('redirect_does_not_forward_token', async () => {
    let leaked = false;
    const target = createServer((req,res) => { leaked = !!req.headers.authorization; res.end('{}'); });
    await new Promise<void>(r => target.listen(0,'127.0.0.1',r));
    cleanups.push(() => new Promise<void>(r => target.close(() => r())));
    const destination = `http://127.0.0.1:${(target.address() as {port:number}).port}`;
    const f = await fixture((req,res) => {
      if (req.url === '/v1/devices/pair') res.end(JSON.stringify({ success:true,data:{token,ownerId:owner,deviceId:device} }));
      else { res.writeHead(302,{Location:destination}); res.end(); }
    });
    await f.connect();
    await expect(f.cloud.client.request('GET','/v1/health')).rejects.toThrow('redirect');
    expect(leaked).toBe(false);
  });
  it.each(['https://evil.example/v1/skill-notes', '//evil.example/v1/skill-notes', '/v1/skill-notes/../devices', '/v1/skill-notes/%2e%2e/devices', '/api/files', '/v1/unknown'])('never sends bearer to disallowed path %s', async path => {
    const f = await fixture(); await f.connect();
    await expect(f.cloud.client.request('GET', path)).rejects.toThrow();
    expect(f.calls()).toBe(1);
  });
  it('disconnect_aborts_inflight and keeps a persistent generation tombstone', async () => {
    let started!: () => void; const waiting = new Promise<void>(r => started=r);
    const f = await fixture((req,res) => {
      if(req.url === '/v1/devices/pair') res.end(JSON.stringify({success:true,data:{token,ownerId:owner,deviceId:device}}));
      else started();
    });
    await f.connect();
    const request = f.cloud.client.request('GET','/v1/health'); const rejection = expect(request).rejects.toThrow();
    await waiting; await f.cloud.disconnectCloud(); await rejection;
    expect(f.cloud.status().connection).toBeNull();
    expect((JSON.parse(await readFile(join(f.dir,'config','connection.json'),'utf8'))).generation).toBe(2);
    expect(f.calls()).toBe(2);
  });
  it('connect/disconnect overlap cannot republish credentials', async () => {
    const f = await fixture(); let release!:()=>void; let entered!:()=>void;
    const enteredPromise=new Promise<void>(r=>entered=r); const hold=new Promise<void>(r=>release=r);
    const secrets={ ...f.secrets, set: async(key:string,value:string)=>{await f.secrets.set(key,value); entered(); await hold;} };
    const cloud=await createCloudConnection({directory:join(f.dir,'overlap'),secrets}); cleanups.push(()=>cloud.stop());
    const connecting=cloud.connectCloud({backendUrl:f.url,pairingCode:code,deviceName:'Test'}); const rejection=expect(connecting).rejects.toThrow();
    await enteredPromise; const disconnecting=cloud.disconnectCloud(); release(); await disconnecting; await rejection;
    const reloaded=await createCloudConnection({directory:join(f.dir,'overlap'),secrets:f.secrets}); cleanups.push(()=>reloaded.stop());
    expect(reloaded.status().connection).toBeNull();
  });
  it('interruption between secret and config writes retains only the old binding', async () => {
    const f = await fixture(); const previous = await f.connect();
    const secrets={...f.secrets,set:async(key:string,value:string)=>{await f.secrets.set(key,value); throw new Error(`disk failure ${token} ${code}`);}};
    const cloud=await createCloudConnection({directory:join(f.dir,'config'),secrets}); cleanups.push(()=>cloud.stop());
    await expect(cloud.connectCloud({backendUrl:f.url,pairingCode:code,deviceName:'Replacement'})).rejects.not.toThrow(token);
    const loaded=await createCloudConnection({directory:join(f.dir,'config'),secrets:f.secrets}); cleanups.push(()=>loaded.stop());
    expect(loaded.status().connection).toEqual(previous);
    expect(JSON.stringify(cloud.status())).not.toContain(code);
  });
  it('mismatched secret binding cannot reload', async () => {
    const f=await fixture(); await f.connect();
    const path=join(f.dir,'config','connection.json');const config=JSON.parse(await readFile(path,'utf8'));
    config.connection.backendOrigin='https://other.example';await writeFile(path,JSON.stringify(config),{mode:0o600});
    const loaded=await createCloudConnection({directory:join(f.dir,'config'),secrets:f.secrets});cleanups.push(()=>loaded.stop());
    expect(loaded.status().connection).toBeNull();expect(loaded.status().lastError).toMatch(/credential|binding/i);
  });
  it('remote errors and transport exceptions are redacted', async () => {
    const f=await fixture((req,res)=>{if(req.url==='/v1/devices/pair')res.end(JSON.stringify({success:true,data:{token,ownerId:owner,deviceId:device}}));else{res.statusCode=401;res.end(JSON.stringify({success:false,error:{code:'unauthorized',message:`Bearer ${token} ${code}`}}));}});
    await f.connect();await expect(f.cloud.client.request('GET','/v1/health')).rejects.not.toThrow(token);
    expect(f.cloud.status().state).toBe('revoked');expect(JSON.stringify(f.cloud.status())).not.toContain(code);
  });
  it('timeouts and offline revoke are honest; disconnect sends no revoke', async () => {
    const f=await fixture((req,res)=>{if(req.url==='/v1/devices/pair')res.end(JSON.stringify({success:true,data:{token,ownerId:owner,deviceId:device}}));});
    await f.connect();await expect(f.cloud.revokeDevice()).rejects.toThrow();expect(f.cloud.status().state).toBe('offline');
    const before=f.calls();await f.cloud.disconnectCloud();expect(f.calls()).toBe(before);
  });
});
it.each(['https://example.com?', 'https://example.com#', 'https://:@example.com', 'https://exam\nple.com'])('empty or hidden URL components still rejected %s',async backendUrl=>{
 const f=await fixture();const outbound=vi.fn(async()=>new Response(JSON.stringify({success:true,data:{token,ownerId:owner,deviceId:device}})));const cloud=await createCloudConnection({directory:join(f.dir,'url-test'),secrets:f.secrets,fetch:outbound});cleanups.push(()=>cloud.stop());await expect(cloud.connectCloud({backendUrl,pairingCode:code,deviceName:'Test'})).rejects.toThrow();expect(outbound).not.toHaveBeenCalled();
});
it('identity change cancels workers and increases generation before new calls',async()=>{
 const f=await fixture();await f.connect();let stopped=false;f.cloud.onStop(()=>{stopped=true;});
 const next=await f.cloud.connectCloud({backendUrl:f.url,pairingCode:code,deviceName:'Replacement'});
 expect(stopped).toBe(true);expect(next.generation).toBe(2);expect(next.deviceName).toBe('Replacement');
});
it('encrypted unavailable message is visible before pairing consumes code',async()=>{
 const f=await fixture();const cloud=await createCloudConnection({directory:join(f.dir,'unavailable'),secrets:{set:async()=>{},get:async()=>{const {CloudError}=await import('../server/cloud/types.js');throw new CloudError('secure_storage_unavailable','Secure encryption is unavailable. Unlock the OS keychain.',503);},remove:async()=>{}}});
 cleanups.push(()=>cloud.stop());await expect(cloud.connectCloud({backendUrl:f.url,pairingCode:code,deviceName:'Test'})).rejects.toThrow(/encryption.*unavailable/);expect(f.calls()).toBe(0);expect(cloud.status().lastError).toMatch(/keychain/);
});

it('disconnect removes a saved encrypted token even when reload cannot unlock it',async()=>{
 const f=await fixture();let available=true;const encryption={isAvailable:()=>available,encrypt:(s:string)=>Buffer.from(Buffer.from(s).map(b=>b^0x55)),decrypt:(b:Buffer)=>Buffer.from(b).map(b=>b^0x55).toString()};
 const directory=join(f.dir,'locked');const secrets=createEncryptedSecretStore(join(f.dir,'encrypted'),encryption);const cloud=await createCloudConnection({directory,secrets});cleanups.push(()=>cloud.stop());
 await cloud.connectCloud({backendUrl:f.url,pairingCode:code,deviceName:'Fixture'});const saved=JSON.parse(await readFile(join(directory,'connection.json'),'utf8'));available=false;
 const loaded=await createCloudConnection({directory,secrets});cleanups.push(()=>loaded.stop());expect(loaded.status().connection).toBeNull();await loaded.disconnectCloud();
 await expect(readFile(join(f.dir,'encrypted',saved.secretRef))).rejects.toThrow();
});

it('approved skill-notes service path reaches the backend',async()=>{
 const f=await fixture();await f.connect();const data=await f.cloud.client.request<{status:string}>('GET','/v1/skill-notes');expect(data.status).toBe('ok');expect(f.calls()).toBe(2);
});
it('held pairing blocks interleaved old requests and late old results cannot reach new identity',async()=>{
 const f=await fixture();let pairCount=0;let healthCalls=0;let oldSignal:AbortSignal|undefined;
 let pairingEntered!:()=>void;const pairingStarted=new Promise<void>(r=>pairingEntered=r);let releasePair!:()=>void;const holdPair=new Promise<void>(r=>releasePair=r);
 let healthEntered!:()=>void;const healthStarted=new Promise<void>(r=>healthEntered=r);let releaseHealth!:()=>void;const holdHealth=new Promise<void>(r=>releaseHealth=r);
 const outbound=async(input:Parameters<typeof fetch>[0],init?:RequestInit)=>{
  const url=new URL(String(input));
  if(url.pathname==='/v1/devices/pair'){pairCount++;if(pairCount===2){pairingEntered();await holdPair;}return new Response(JSON.stringify({success:true,data:{token:pairCount===1?token:'n'.repeat(43),ownerId:owner,deviceId:device}}));}
  healthCalls++;oldSignal=init?.signal??undefined;healthEntered();await holdHealth;return new Response(JSON.stringify({success:true,data:{identity:'old'}}));
 };
 const cloud=await createCloudConnection({directory:join(f.dir,'transition'),secrets:f.secrets,fetch:outbound,timeoutMs:5000});cleanups.push(()=>cloud.stop());
 await cloud.connectCloud({backendUrl:f.url,pairingCode:code,deviceName:'Old'});
 const oldRequest=cloud.recheckCloud().then(value=>({value,error:null}),error=>({value:null,error}));await healthStarted;
 const replacing=cloud.connectCloud({backendUrl:'https://replacement.example',pairingCode:code,deviceName:'New'});await pairingStarted;
 const interleaved=cloud.client.request('GET','/v1/health').then(value=>({value,error:null}),error=>({value:null,error}));
 releasePair();await replacing;releaseHealth();
 const old=await oldRequest;const during=await interleaved;
 expect(healthCalls).toBe(1);expect(oldSignal?.aborted).toBe(true);expect(old.value).toBeNull();expect(old.error).toBeInstanceOf(Error);expect(during.value).toBeNull();expect(during.error).toBeInstanceOf(Error);expect(cloud.status().connection?.backendOrigin).toBe('https://replacement.example');
});

it.each([
  [409, 'version_conflict', {headVersion: 2}],
  [409, 'abbreviation_conflict', undefined],
  [429, 'rate_limited', undefined],
  [400, 'invalid_request', undefined],
  [404, 'not_found', undefined],
  [403, 'forbidden', undefined],
] as const)('validated HTTP %s %s is reachable and keeps actions available after reload', async (status, errorCode, details) => {
  const f = await fixture((req,res) => {
    if(req.url === '/v1/devices/pair') res.end(JSON.stringify({success:true,data:{token,ownerId:owner,deviceId:device}}));
    else {res.writeHead(status, {'content-type':'application/json'});res.end(JSON.stringify({success:false,error:{code:errorCode,message:'Remote text must remain redacted',...(details?{details}:{})}}));}
  });
  const binding=await f.connect();
  const reloaded=await createCloudConnection({directory:join(f.dir,'config'),secrets:f.secrets});cleanups.push(()=>reloaded.stop());
  expect(reloaded.status().state).toBe('offline');
  await expect(reloaded.client.request('GET','/v1/projects')).rejects.toMatchObject({code:errorCode,status});
  expect(reloaded.status()).toMatchObject({state:'connected',connection:binding,lastError:null});
});
it('unrecognized 409 errors never count as a validated reachable domain response', async () => {
 const f=await fixture((req,res)=>{if(req.url==='/v1/devices/pair')res.end(JSON.stringify({success:true,data:{token,ownerId:owner,deviceId:device}}));else{res.writeHead(409);res.end(JSON.stringify({success:false,error:{code:'untrusted_custom_code',message:'untrusted'}}));}});
 await f.connect();await expect(f.cloud.client.request('GET','/v1/projects')).rejects.toMatchObject({code:'backend_error'});expect(f.cloud.status().state).toBe('offline');
});

it('explicit health recheck recovers saved credentials and transient outage without replaying writes', async () => {
 let outage=false; const methods:string[]=[];
 const f=await fixture((req,res)=>{methods.push(req.method!); if(req.url==='/v1/devices/pair')res.end(JSON.stringify({success:true,data:{token,ownerId:owner,deviceId:device}}));else if(outage){res.writeHead(503);res.end('{}');}else res.end(JSON.stringify({success:true,data:{status:'ok',contractVersion:1,ownerId:owner,deviceId:device,services:[]}}));});
 const binding=await f.connect(); await f.cloud.stop();
 const loaded=await createCloudConnection({directory:join(f.dir,'config'),secrets:f.secrets});cleanups.push(()=>loaded.stop());
 expect(loaded.status().state).toBe('offline');
 await loaded.recheckCloud();expect(loaded.status().state).toBe('connected');
 outage=true;await expect(loaded.recheckCloud()).rejects.toThrow();expect(loaded.status().state).toBe('offline');
 outage=false;await loaded.recheckCloud();expect(loaded.status()).toMatchObject({state:'connected',connection:binding});
 expect(methods).toEqual(['POST','GET','GET','GET']);
});

it('health identity mismatch fails closed without exposing a new account',async()=>{
 const f=await fixture((req,res)=>{res.end(JSON.stringify({success:true,data:req.url==='/v1/devices/pair'?{token,ownerId:owner,deviceId:device}:{status:'ok',contractVersion:1,ownerId:device,deviceId:device}}));});
 const binding=await f.connect();await expect(f.cloud.recheckCloud()).rejects.toMatchObject({code:'invalid_response'});expect(f.cloud.status()).toMatchObject({state:'offline',connection:binding});
});
