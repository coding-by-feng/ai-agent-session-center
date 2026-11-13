import {expect,it,vi} from 'vitest';
import {defaultSessionInitializer} from '../server/hostedDefaults.js';
it('serializes concurrent opens and reuses durable sessions on reopen',async()=>{
 const sessions=new Map();const create=vi.fn();
 const init=defaultSessionInitializer(async cli=>{await Promise.resolve();if(!sessions.has(cli)){create(cli);sessions.set(cli,cli+'-id');}return sessions.get(cli);});
 expect(await Promise.all([init(),init()])).toEqual([{claude:'claude-id',codex:'codex-id'},{claude:'claude-id',codex:'codex-id'}]);
 await init();expect(create).toHaveBeenCalledTimes(2);
});
it('releases failed initialization for retry without discarding completed work',async()=>{
 let failed=true;const saved=new Map();const init=defaultSessionInitializer(async cli=>{if(cli==='codex'&&failed)throw Error('temporary');if(!saved.has(cli))saved.set(cli,cli);return saved.get(cli);});
 await expect(init()).rejects.toThrow('temporary');failed=false;expect(await init()).toEqual({claude:'claude',codex:'codex'});expect(saved.size).toBe(2);
});
