import {it,expect} from 'vitest';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID,createHmac} from 'node:crypto';
import {createHostedAccess,hostedSocketAllowed} from '../server/hostedAccess.js';
import {createHostedToken} from '../server/authManager.js';

it('accepts signed launch audiences and authenticated sockets on the same order alias only',()=>{
 const dir=mkdtempSync(join(tmpdir(),'domain-alias-'));
 try {
  const orderId=randomUUID(), compact=orderId.replaceAll('-','');
  const oldOrigin=`https://order-${compact}.aasc.work`, runtimeOrigin=`https://order-${compact}.xclaude.dev`;
  const config={orderId,runtimeOrigin,websiteOrigin:'https://xclaude.dev',launchKey:'a'.repeat(64),dataDir:dir};
  const access=createHostedAccess(config);
  const sign=(aud:string)=>{
   const now=Math.floor(Date.now()/1000);
   const raw=Buffer.from(JSON.stringify({alg:'HS256',typ:'JWT'})).toString('base64url')+'.'+Buffer.from(JSON.stringify({iss:config.websiteOrigin,aud,orderId,sub:'owner',ownerEpoch:0,accessMode:'use',jti:randomUUID(),iat:now,exp:now+60})).toString('base64url');
   return raw+'.'+createHmac('sha256',config.launchKey).update(raw).digest('base64url');
  };
  expect(()=>access.consume(sign(runtimeOrigin))).not.toThrow();
  expect(()=>access.consume(sign(oldOrigin))).not.toThrow();
  for(const foreign of ['https://order-'+ '0'.repeat(32)+'.aasc.work',oldOrigin+'.evil.example',oldOrigin+'/hosted/order-pairing']) expect(()=>access.consume(sign(foreign))).toThrow();
  const token=createHostedToken(orderId,'principal',{sub:'owner',ownerEpoch:0,accessMode:'use'});
  const socket=(origin:string)=>hostedSocketAllowed(config,{headers:{origin,authorization:'Bearer '+token}} as any);
  expect(socket(runtimeOrigin)).toBe(true);
  expect(socket(oldOrigin)).toBe(true);
  expect(socket('https://xclaude.dev')).toBe(false);
  expect(socket(oldOrigin+'.evil.example')).toBe(false);
 } finally {rmSync(dir,{recursive:true,force:true});}
});
