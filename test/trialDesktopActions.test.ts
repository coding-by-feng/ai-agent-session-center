import { expect, it, vi } from 'vitest';
import { invokeTrialAction } from '../electron/trial/actions.js';

const status = { available:true, mode:'native_qa', policyVersion:'native-qa-v1', runtime:'claude-code', client:'aasc', turnLimit:3, inputLimit:600, contextTokenLimit:2500, outputTokenLimit:800, historyPairs:2, timeoutMs:45000, concurrentTurns:1 };
function setup() {
  const snapshot = { status, session:null, pending:null, busy:false };
  const client = { status:vi.fn(async()=>status),state:vi.fn(async()=>snapshot),getSnapshot:()=>snapshot, activate:vi.fn(async()=>snapshot),ask:vi.fn(async()=>snapshot),retry:vi.fn(async()=>snapshot),logout:vi.fn(async()=>snapshot) };
  const origin = 'http://localhost:3332';
  return { client, origin, sender:{ url:`${origin}/`,mainFrame:true } };
}
it('accepts only the trusted application top frame and fixed actions', async () => {
  const {client, origin, sender}=setup();
  for (const bad of [{...sender,url:'https://xclaude.dev/'},{...sender,url:'http://localhost:9999/'},{...sender,mainFrame:false}])
    expect(await invokeTrialAction(client, origin, bad, 'activate', 'AASC-test-code')).toEqual({ok:false,error:'untrusted_window'});
  expect(client.activate).not.toHaveBeenCalled();
  expect(await invokeTrialAction(client,origin,sender,'__proto__')).toEqual({ok:false,error:'invalid_request'});
  expect((await invokeTrialAction(client,origin,sender,'refresh')).ok).toBe(true);
  expect(client.status).toHaveBeenCalledOnce();
});
it('validates renderer input and never reflects private exception messages', async () => {
  const {client, origin, sender}=setup();
  expect(await invokeTrialAction(client,origin,sender,'ask','问'.repeat(601))).toEqual({ok:false,error:'invalid_prompt'});
  expect(await invokeTrialAction(client,origin,sender,'ask',{url:'https://evil.invalid'})).toEqual({ok:false,error:'invalid_prompt'});
  expect(client.ask).not.toHaveBeenCalled();
  client.ask.mockRejectedValueOnce(new Error('private-key-cookie-in-error'));
  const result=await invokeTrialAction(client,origin,sender,'ask','解释一个概念');
  expect(result).toMatchObject({ok:false,error:'runtime_unavailable',data:{session:null}});
  expect(JSON.stringify(result)).not.toContain('private-key');
});
