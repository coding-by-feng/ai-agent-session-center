/** Fixed, dependency-free helper sent over SSH stdin protocol; no resource code is executed. */
export const REMOTE_HELPER = String.raw`
const fs = require('fs/promises'), path = require('path'), os = require('os'), crypto = require('crypto'), constants = require('fs').constants;
const hash = b => crypto.createHash('sha256').update(b).digest('hex');
const within = (root,p) => p === root || p.startsWith(root + path.sep);
const fail = message => { throw new Error(message); };
const safeRel = p => typeof p === 'string' && p.length < 4096 && p.length > 0 && !p.includes('\\') && !p.includes('\0') && !path.isAbsolute(p) && p.split('/').every(x => x && x!=='.' && x!=='..');
// Mirror the source credential-path policy: a standalone helper cannot import AASC modules.
const credentialPath = p => {
 const parts=p.toLowerCase().split('/'), name=parts[parts.length-1];
 return parts.some(x=>['secrets','.ssh','.gnupg','.aws','.kube'].includes(x)) || [
 /^(?:auth\.json|\.auth-token|\.credentials.*|secrets)$/,
 /^(?:.*[-_.])?credentials?\.json$|^(?:tokens?|secrets?)\.json$|^client_secret.*\.json$|service[-_]?account.*\.json$/,
 /^\.env(?:\..+)?$|^.+\.env$|^\.envrc$/,
 /^[._]netrc$|^\.(?:npmrc|pypirc|pgpass|git-credentials|htpasswd|my\.cnf)$/,
 /^.+\.tfvars(?:\.json)?$|^.+\.tfstate(?:\.backup)?$|^kubeconfig(?:\.ya?ml)?$/,
 /^id_(?:rsa|dsa|ecdsa|ed25519).*$|^.+\.(?:pem|key|p12|pfx|jks|keystore)$/,
 ].some(re=>re.test(name));
};
const summaryHash = files => hash([...files].sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0).map(f=>f.path+'\0'+f.hash+'\0'+f.mode+'\n').join(''));
async function exists(p) { try {return await fs.lstat(p);} catch(e) {if(e.code==='ENOENT') return null; throw e;} }
async function noLinks(p) {
  let part = path.parse(p).root;
  for (const name of p.slice(part.length).split(path.sep).filter(Boolean)) {
    part = path.join(part,name); const st = await exists(part);
    if(st && st.isSymbolicLink()) fail('Destination contains a symbolic link. Choose a direct folder.');
  }
}
async function main(req) {
 const home = await fs.realpath(os.homedir());
 const roots = {claude:process.env.CLAUDE_CONFIG_DIR || path.join(home,'.claude'),codex:process.env.CODEX_HOME || path.join(home,'.codex'),shared:path.join(home,'.agents')};
 if(req.op === 'probe') return {home,platform:process.platform,roots,node:process.versions.node};
 if(!['file','package'].includes(req.kind)) fail('Unknown resource shape.');
 if(!['inspect','apply','restore'].includes(req.op)) fail('Unknown transfer operation.');
 if(!['claude','codex','shared'].includes(req.agent)) fail('Unknown agent.');
 const root = req.project || roots[req.agent];
 if(typeof root!=='string' || !path.isAbsolute(root) || path.normalize(root)!==root || root===home || !within(home,root)) fail('Destination folder must be inside the remote home directory.');
 if(!safeRel(req.relativePath)) fail('Invalid resource path.');
 const rel = req.relativePath;
 const allowed = req.project ? /^(?:\.claude|\.codex|\.agents)\/(?:skills|commands|prompts|rules|agents)\/./ : /^(?:skills|commands|prompts|rules|agents)\/./;
 if(!allowed.test(rel) || credentialPath(rel)) fail('Unsupported destination path.');
 if(req.project && !rel.startsWith('.'+(req.agent==='shared'?'agents':req.agent)+'/')) fail('Agent and project path disagree.');
 const dest=path.join(root,rel);if(req.op!=='inspect'&&req.expectedDestinationPath!==dest)fail('Destination root changed since comparison. Compare again.');await noLinks(dest);
 const read = async p => {
   const st = await exists(p); if(!st) return {hash:null,files:[]};
   const files=[];let bytes=0;
   async function walk(abs,relative,depth) {
     if(credentialPath(relative||path.basename(dest)))fail('Destination resource contains a credential path. Transfer refused.');
     if(depth>12 || files.length>=2000) fail('Destination is too large to compare.');
     const s=await fs.lstat(abs);if(s.isSymbolicLink()) fail('Destination contains links.');
     if(s.isDirectory()) {for(const n of (await fs.readdir(abs)).sort()) await walk(path.join(abs,n),relative?relative+'/'+n:n,depth+1);return;}
     if(!s.isFile()) fail('Destination contains a special file.');
     bytes+=s.size;if(bytes>67108864 || s.size>16777216) fail('Destination exceeds comparison limits.');
     const handle=await fs.open(abs,constants.O_RDONLY|constants.O_NOFOLLOW);let b;try{const opened=await handle.stat();if(opened.ino!==s.ino||opened.dev!==s.dev||!opened.isFile())fail('Destination changed while reading.');b=await handle.readFile();const after=await handle.stat();if(after.size!==s.size||after.mtimeMs!==s.mtimeMs)fail('Destination changed while reading.');}finally{await handle.close();}files.push({path:relative||path.basename(dest),hash:hash(b),mode:s.mode&73?493:420,...(b.length<262144&&!b.includes(0)?{text:b.toString('utf8')}:{})});
   }
   await walk(p,'',0); return {hash:summaryHash(files),files};
 };
 if(req.op==='inspect') return {...await read(dest),destinationPath:dest};
 if(!/^[a-f0-9-]{36}$/.test(req.operationId)) fail('Invalid operation id.');
 const journal=path.join(home,'.aasc-resource-transfers');await noLinks(journal);await fs.mkdir(journal,{recursive:true,mode:448});
 const journalStat=await fs.lstat(journal);if((journalStat.mode&63)!==0||journalStat.uid!==process.getuid())fail('Transfer journal must be private to this user.');
 const dir=path.join(journal,req.operationId),lock=path.join(journal,'lock-'+hash(dest));
 const owner='owner-'+process.pid+'-'+crypto.randomUUID();
 await noLinks(lock);
 for(let attempt=0;attempt<2;attempt++) {
   try {await fs.mkdir(lock,{mode:448});await fs.writeFile(path.join(lock,owner),'',{flag:'wx',mode:384});break;}
   catch(e) {
     if(e.code!=='EEXIST')throw e;
     const entries=await fs.readdir(lock);
     if(entries.length===1 && /^owner-\d+-[a-f0-9-]+$/.test(entries[0])) {
       const pid=Number(entries[0].split('-')[1]);let alive=true;
       try{process.kill(pid,0);}catch(k){if(k.code==='ESRCH')alive=false;}
       if(!alive){await fs.unlink(path.join(lock,entries[0])).catch(e=>{if(e.code!=='ENOENT')throw e;});await fs.rmdir(lock).catch(e=>{if(e.code!=='ENOENT')throw e;});continue;}
     }
     if(!entries.length && Date.now()-(await fs.stat(lock)).mtimeMs>120000){await fs.rmdir(lock);continue;}
     fail('Another transfer holds this destination lock. Retry after it finishes.');
   }
 }
 if(!(await exists(path.join(lock,owner))))fail('Could not acquire destination lock. Retry.');
 try {
   await noLinks(dir);await fs.mkdir(dir,{recursive:true,mode:448});
   const receipt=path.join(dir,'receipt.json'),backup=path.join(dir,'backup');
   await noLinks(receipt);await noLinks(backup);await noLinks(receipt+'.tmp');
   const stage=path.join(path.dirname(dest),'.aasc-stage-'+req.operationId);
   let record=null;try{record=JSON.parse(await fs.readFile(receipt,'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;}
   const save=async v=>{await fs.writeFile(receipt+'.tmp',JSON.stringify(v),{mode:384});await fs.rename(receipt+'.tmp',receipt);record=v;};
   if(record && (record.destination!==dest || record.hash!==req.sourceHash)) fail('Operation does not match its recovery receipt.');
   let current=await read(dest);
   if(req.op==='restore') {
     if(record?.state==='restored' || (record?.state==='restoring' && current.hash===record.originalHash && !await exists(backup))) {await save({...record,state:'restored'});return {restored:true};}
     if(!record || !record.hadOriginal || !await exists(backup)) fail('No replaced resource to restore.');
     if((await read(backup)).hash!==record.originalHash && req.kind==='package')fail('Recovery backup changed. Restore refused.');
     if(req.kind==='file') {const backupFile=await read(backup);backupFile.files[0].path=path.basename(dest);if(summaryHash(backupFile.files)!==record.originalHash)fail('Recovery backup changed. Restore refused.');}
     if(record.state==='restoring' && current.hash===null && await exists(path.join(dir,'replaced-copy'))) {await fs.rename(backup,dest);await save({...record,state:'restored'});return {restored:true};}
     if(current.hash!==record.hash) fail('Destination changed after transfer; restore needs a fresh review.');
     await noLinks(dest);await noLinks(path.join(dir,'replaced-copy'));
     await save({...record,state:'restoring'});
     await fs.rename(dest,path.join(dir,'replaced-copy'));
     try{await fs.rename(backup,dest);}catch(e){await fs.rename(path.join(dir,'replaced-copy'),dest);throw e;}
     await save({...record,state:'restored'});return {restored:true};
   }
   if(record?.state==='restored') fail('This transfer was restored. Compare a new task to copy again.');
   if(record && current.hash===req.sourceHash) {await save({...record,state:'complete'});return {hash:current.hash,backupId:record.hadOriginal?req.operationId:undefined};}
   if(record?.state==='prepared' && current.hash===null && await exists(backup)) {
     // A process stopped between the two renames. Recover the original first.
     if((await read(backup)).hash!==record.originalHash)fail('Recovery backup changed.');
     await noLinks(dest);await fs.rename(backup,dest);current=await read(dest);
   }
   if(current.hash!==req.expectedHash) fail('Destination changed since comparison. Compare again.');
   if(!Array.isArray(req.files)||req.files.length===0||req.files.length>2000)fail('Invalid resource packet.');
   let total=0;const seen=new Set();
   for(const f of req.files) {
     if(!safeRel(f.path)||credentialPath(f.path)||seen.has(f.path)||!['644','755'].includes(Number(f.mode).toString(8))) fail('Invalid packet file.');
     seen.add(f.path);const b=Buffer.from(f.content,'base64');total+=b.length;
     if(total>67108864 || hash(b)!==f.hash)fail('Packet checksum mismatch.');
   }
   if(summaryHash(req.files)!==req.sourceHash)fail('Packet checksum mismatch.');
   if(req.kind==='file' && (req.files.length!==1||req.files[0].path!==path.basename(dest))) fail('Invalid single-file packet.');
   await noLinks(dest);await fs.mkdir(path.dirname(dest),{recursive:true});
   // The stage is owned by this operation; a retry may replace its own incomplete stage.
   await fs.rm(stage,{recursive:true,force:true});
   for(const f of req.files){const out=req.kind==='file'?stage:path.join(stage,f.path);await fs.mkdir(path.dirname(out),{recursive:true});await fs.writeFile(out,Buffer.from(f.content,'base64'),{mode:f.mode,flag:'wx'});await fs.chmod(out,f.mode);}
   const staged=await read(stage);
   // Single files have a temporary basename, so verify bytes directly instead.
   if(req.kind==='package'&&staged.hash!==req.sourceHash)fail('Staging verification failed.');
   if(req.kind==='file'&&hash(await fs.readFile(stage))!==req.files[0].hash)fail('Staging verification failed.');
   current=await read(dest);if(current.hash!==req.expectedHash)fail('Destination changed during staging. Compare again.');
   await save({destination:dest,hash:req.sourceHash,hadOriginal:current.hash!==null,originalHash:current.hash,state:'prepared'});
   if(current.hash!==null) await fs.rename(dest,backup);
   try{await fs.rename(stage,dest);}catch(e){if(current.hash!==null)await fs.rename(backup,dest);throw e;}
   const verified=await read(dest);if(verified.hash!==req.sourceHash)fail('Destination verification failed; recovery backup retained.');
   await save({...record,state:'complete'});
   return {hash:verified.hash,backupId:record.hadOriginal?req.operationId:undefined};
 } finally {await fs.unlink(path.join(lock,owner)).catch(()=>{});await fs.rmdir(lock).catch(()=>{});}
}
let input='';process.stdin.setEncoding('utf8');process.stdin.on('data',s=>{input+=s;if(input.length>100000000)process.exit(1);});
process.stdin.on('end',()=>{Promise.resolve().then(()=>main(JSON.parse(input))).then(data=>process.stdout.write(JSON.stringify({ok:true,data}))).catch(e=>{process.stdout.write(JSON.stringify({ok:false,error:e.message}));process.exitCode=1;});});
`;
