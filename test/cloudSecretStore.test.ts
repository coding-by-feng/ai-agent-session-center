import { afterEach, expect, it } from 'vitest';
import { mkdtemp, realpath, rm, stat, readFile, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createFileSecretStore, createEncryptedSecretStore } from '../server/cloud/secretStore.js';
const dirs:string[]=[];
afterEach(async()=>{for(const dir of dirs.splice(0))await rm(dir,{recursive:true,force:true});});
async function dir(){const d=await realpath(await mkdtemp(join(tmpdir(),'aasc-secret-test-')));dirs.push(d);return d;}
it('headless token has private directory and owner-only file; remove survives reopen',async()=>{
 const root=join(await dir(),'private');const store=createFileSecretStore(root);await store.set('test-key','synthetic-token');
 expect((await stat(root)).mode&0o777).toBe(0o700);expect((await stat(join(root,'test-key'))).mode&0o777).toBe(0o600);
 expect(await createFileSecretStore(root).get('test-key')).toBe('synthetic-token');await store.remove('test-key');expect(await store.get('test-key')).toBeNull();
});
it('encrypted_secret_unavailable_is_explicit and never writes plaintext',async()=>{
 const root=join(await dir(),'private');const store=createEncryptedSecretStore(root,{isAvailable:()=>false,encrypt:()=>Buffer.from('x'),decrypt:()=>''});
 await expect(store.set('test-key','synthetic-token')).rejects.toThrow(/secure.*unavailable/i);
 await expect(store.get('test-key')).rejects.toThrow(/secure.*unavailable/i);
});
it('encrypted storage persists ciphertext and decrypts after restart',async()=>{
 const root=join(await dir(),'private');const provider={isAvailable:()=>true,encrypt:(value:string)=>Buffer.from(value).map(b=>b^0x55),decrypt:(value:Buffer)=>Buffer.from(value).map(b=>b^0x55).toString()};
 await createEncryptedSecretStore(root,provider).set('test-key','synthetic-token');expect(await readFile(join(root,'test-key'),'utf8')).not.toContain('synthetic-token');
 expect(await createEncryptedSecretStore(root,provider).get('test-key')).toBe('synthetic-token');
});
it('symlinked storage and key files are rejected without touching targets',async()=>{
 const base=await dir();const root=join(base,'private');const store=createFileSecretStore(root);await store.set('test-key','original');
 await symlink(root,join(base,'link'));await expect(createFileSecretStore(join(base,'link')).get('test-key')).rejects.toThrow();
 await symlink(join(root,'test-key'),join(root,'other-key'));await expect(store.set('other-key','changed')).rejects.toThrow();await expect(store.get('other-key')).rejects.toThrow();await expect(store.remove('other-key')).rejects.toThrow();expect(await store.get('test-key')).toBe('original');
});
