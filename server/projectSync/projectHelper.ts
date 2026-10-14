/**
 * Fixed, dependency-free Node 18+ helper for Project Sync. The same source runs on the
 * device (over pinned SSH) and on this machine (spawned locally) — one audited writer.
 *
 * It is deliberately SEPARATE from the Transfers helper: project sync copies every file,
 * credential files and symlinks included, while the Transfers helper refuses both by design.
 *
 * Wire format on stdin: frames of [type:1 byte 'J'|'D'][length:uint32 BE][payload].
 * Replies on stdout: one JSON object per line. Ops: probe · manifest · apply · undo · read.
 * The source is a String.raw template: never put a backtick or a dollar-brace in it.
 */
export const PROJECT_HELPER = String.raw`
'use strict';
const fs = require('fs'), fsp = require('fs/promises'), path = require('path'), os = require('os'), crypto = require('crypto');
const C = fs.constants;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const TMP_RE = /^\.p\.aasc-tmp-[0-9a-f-]{36}$/;
const MAX_JSON = 16 * 1048576, MAX_DATA = 4 * 1048576, MAX_ENTRIES = 500000;
const fail = (m) => { throw new Error(m); };
const fatal = (m) => { const e = new Error(m); e.fatal = true; throw e; };
const within = (root, p) => p === root || p.startsWith(root + path.sep);
function out(o) {
  return new Promise((resolve) => { if (process.stdout.write(JSON.stringify(o) + '\n')) resolve(); else process.stdout.once('drain', resolve); });
}
const safeRel = (p) => typeof p === 'string' && p.length > 0 && p.length < 4096 && !p.includes('\\') && !p.includes('\0') && !path.isAbsolute(p) &&
  p.split('/').every((x) => x && x !== '.' && x !== '..' && !TMP_RE.test(x));

// Mirror of fsSafe's credential names: a standalone helper cannot import AASC modules.
const secretPath = (p) => {
  const parts = p.toLowerCase().split('/'), name = parts[parts.length - 1];
  return parts.some((x) => ['secrets', '.ssh', '.gnupg', '.aws', '.kube'].includes(x)) || [
    /^(?:auth\.json|\.auth-token|\.credentials.*|secrets)$/,
    /^(?:.*[-_.])?credentials?\.json$|^(?:tokens?|secrets?)\.json$|^client_secret.*\.json$|service[-_]?account.*\.json$/,
    /^\.env(?:\..+)?$|^.+\.env$|^\.envrc$/,
    /^[._]netrc$|^\.(?:npmrc|pypirc|pgpass|git-credentials|htpasswd|my\.cnf)$/,
    /^.+\.tfvars(?:\.json)?$|^.+\.tfstate(?:\.backup)?$|^kubeconfig(?:\.ya?ml)?$/,
    /^id_(?:rsa|dsa|ecdsa|ed25519).*$|^.+\.(?:pem|key|p12|pfx|jks|keystore)$/,
  ].some((re) => re.test(name));
};
// The mode both sides report and the device writes: never group/other-writable, credentials owner-only.
const normMode = (rel, mode, kind) => kind === 'symlink' ? 511 : kind === 'file' && secretPath(rel) ? mode & 448 : mode & 493;

async function* frames() {
  let buf = Buffer.alloc(0), parts = [], pending = 0, need = 5;
  for await (const chunk of process.stdin) {
    parts.push(chunk);
    pending += chunk.length;
    if (buf.length + pending < need) continue;
    buf = Buffer.concat([buf, ...parts]);
    parts = [];
    pending = 0;
    while (buf.length >= 5) {
      const type = String.fromCharCode(buf[0]), len = buf.readUInt32BE(1);
      if ((type !== 'J' && type !== 'D') || len > (type === 'J' ? MAX_JSON : MAX_DATA)) fatal('Invalid input frame.');
      if (buf.length < 5 + len) { need = 5 + len; break; }
      need = 5;
      const payload = buf.subarray(5, 5 + len);
      buf = buf.subarray(5 + len);
      if (type === 'J') { let json; try { json = JSON.parse(payload.toString('utf8')); } catch (e) { fatal('Invalid input frame.'); } yield { type, json }; }
      else yield { type, data: payload };
    }
  }
  if (buf.length || pending) fatal('Input ended inside a frame.');
}
async function next(it) { const r = await it.next(); if (r.done) fatal('Input ended early.'); return r.value; }

async function lst(p) { try { return await fsp.lstat(p); } catch (e) { if (e.code === 'ENOENT' || e.code === 'ENOTDIR') return null; throw e; } }
async function noLinks(p) {
  let part = path.parse(p).root;
  for (const n of p.slice(part.length).split(path.sep).filter(Boolean)) {
    part = path.join(part, n);
    const s = await lst(part);
    if (s && s.isSymbolicLink()) fail('A folder on the way is a symbolic link; nothing is written through links.');
  }
}
async function checkRoot(root, inHome) {
  if (typeof root !== 'string' || !path.isAbsolute(root) || path.normalize(root) !== root || root.endsWith(path.sep) || root.length > 4096 || /[\x00-\x1f]/.test(root)) fail('Invalid project folder.');
  const home = await fsp.realpath(os.homedir());
  if (root === home || root === path.parse(root).root) fail('The project folder cannot be the home folder or the disk root.');
  if (inHome && !within(home, root)) fail('The device folder must be inside the home folder on the device.');
  const journal = path.join(home, '.aasc-project-sync');
  if (within(journal, root) || within(root, journal)) fail('The project folder overlaps the sync journal.');
  await noLinks(root);
  return home;
}
async function hashFile(abs, st) {
  const h = crypto.createHash('sha256');
  const fh = await fsp.open(abs, C.O_RDONLY | C.O_NOFOLLOW);
  try {
    const o = await fh.stat();
    if (st && (o.ino !== st.ino || o.dev !== st.dev)) fail('changed while reading');
    const buf = Buffer.allocUnsafe(1048576);
    let pos = 0;
    for (;;) { const r = await fh.read(buf, 0, buf.length, pos); if (!r.bytesRead) break; h.update(buf.subarray(0, r.bytesRead)); pos += r.bytesRead; }
    const a = await fh.stat();
    if (a.size !== o.size || a.mtimeMs !== o.mtimeMs || pos !== a.size) fail('changed while reading');
  } finally { await fh.close(); }
  return h.digest('hex');
}

// gitignore-style excludes: name or path patterns, * ? **, trailing / = folders only, leading / = anchored.
function globRe(p) {
  let re = '';
  for (let i = 0; i < p.length; i++) {
    const c = p[i];
    if (c === '*') {
      if (p[i + 1] === '*') { i++; if (p[i + 1] === '/') { i++; re += '(?:.*/)?'; } else re += '.*'; }
      else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^$()|[\]{}\\]/g, '\\$&');
  }
  return re;
}
function compile(list) {
  if (!Array.isArray(list) || list.length > 200) fail('Invalid exclude list.');
  return list.map((raw) => {
    if (typeof raw !== 'string' || !raw.trim() || raw.length > 256 || raw.trim().startsWith('!')) fail('Invalid exclude pattern.');
    let p = raw.trim();
    const dirOnly = p.endsWith('/');
    if (dirOnly) p = p.slice(0, -1);
    const anchored = p.startsWith('/') || p.includes('/');
    if (p.startsWith('/')) p = p.slice(1);
    return { re: new RegExp('^' + (anchored ? '' : '(?:.*/)?') + globRe(p) + '$'), dirOnly };
  });
}
const excluded = (rules, rel, isDir) => rules.some((r) => (!r.dirOnly || isDir) && r.re.test(rel));

async function manifest(h, it) {
  await checkRoot(h.root, h.inHome === true);
  const rules = compile(h.excludes || []);
  const base = new Map();
  for (;;) {
    const f = await next(it);
    if (f.type !== 'J') fatal('Unexpected data.');
    if (f.json.end) break;
    for (const b of f.json.base || []) if (Array.isArray(b) && typeof b[0] === 'string') base.set(b[0], b);
  }
  const top = await lst(h.root);
  if (!top) { await out({ done: true, count: 0, missing: true }); return; }
  if (!top.isDirectory()) fail('The project folder is not a folder.');
  let count = 0;
  async function visit(abs, rel, depth) {
    if (depth > 128) fail('Folders are nested too deeply.');
    let names;
    try { names = (await fsp.readdir(abs)).sort(); }
    catch (e) { if (e.code === 'EACCES' || e.code === 'EPERM') fail('Cannot read ' + (rel || 'the project folder') + ' (permission denied). Exclude it or fix its permissions.'); throw e; }
    for (const n of names) {
      if (TMP_RE.test(n)) continue;
      const r = rel ? rel + '/' + n : n, a = path.join(abs, n);
      const s = await lst(a);
      if (!s) continue;
      const isDir = s.isDirectory();
      if (excluded(rules, r, isDir)) continue;
      if (++count > MAX_ENTRIES) fail('More than 500,000 entries. Add exclude patterns or split the project.');
      const e = { p: r, s: isDir ? 0 : s.size, m: Math.floor(s.mtimeMs), mo: normMode(r, s.mode, isDir ? 'dir' : 'file') };
      if (s.isSymbolicLink()) { e.k = 'l'; e.t = await fsp.readlink(a); e.mo = 511; e.s = 0; }
      else if (isDir) e.k = 'd';
      else if (s.isFile()) {
        e.k = 'f';
        const b = base.get(r);
        if (b && b[1] === s.size && Math.abs(b[2] - e.m) <= 1 && b[3] === e.mo && typeof b[4] === 'string' && HEX64.test(b[4])) e.h = b[4];
        else { try { e.h = await hashFile(a, s); } catch (err) { if (!/changed while reading/.test(err.message)) throw err; } }
        if (s.size <= 256 && /(^|\/)\.git\/(HEAD|refs\/heads\/.+)$/.test(r)) { try { e.x = (await fsp.readFile(a)).toString('utf8'); } catch (err) { /* optional */ } }
      } else e.k = 'o';
      await out(e);
      if (isDir) await visit(a, r, depth + 1);
    }
  }
  await visit(h.root, '', 0);
  await out({ done: true, count });
}

async function privateDir(p) {
  await noLinks(p);
  await fsp.mkdir(p, { recursive: true, mode: 448 });
  const s = await fsp.lstat(p);
  if (!s.isDirectory() || (s.mode & 63) !== 0 || s.uid !== process.getuid()) fail('The sync journal must be private to this user.');
}
async function journal(home, linkId, runId, create) {
  if (!UUID.test(linkId) || !UUID.test(runId)) fail('Invalid run.');
  const root = path.join(home, '.aasc-project-sync'), link = path.join(root, linkId), run = path.join(link, 'runs', runId);
  if (create) { await privateDir(root); await privateDir(link); await privateDir(path.join(link, 'runs')); await privateDir(run); await privateDir(path.join(run, 'backup')); await privateDir(path.join(run, 'trash')); }
  else { await noLinks(run); if (!(await lst(run))) fail('Nothing to undo for this run on the device.'); }
  return { link, run, backup: path.join(run, 'backup'), trash: path.join(run, 'trash'), undone: path.join(run, 'undone'), log: path.join(run, 'journal.ndjson') };
}
async function lockDir(home, root) {
  const locks = path.join(home, '.aasc-project-sync', 'locks');
  await privateDir(path.join(home, '.aasc-project-sync'));
  await privateDir(locks);
  const dir = path.join(locks, crypto.createHash('sha256').update(root).digest('hex').slice(0, 32));
  await privateDir(dir);
  return dir;
}
async function lock(dir) {
  const l = path.join(dir, 'lock'), owner = 'owner-' + process.pid + '-' + crypto.randomUUID();
  await noLinks(l);
  for (let attempt = 0; attempt < 2; attempt++) {
    try { await fsp.mkdir(l, { mode: 448 }); await fsp.writeFile(path.join(l, owner), '', { flag: 'wx', mode: 384 }); break; }
    catch (e) {
      if (e.code !== 'EEXIST') throw e;
      const entries = await fsp.readdir(l);
      if (entries.length === 1 && /^owner-\d+-[a-f0-9-]+$/.test(entries[0])) {
        let alive = true;
        try { process.kill(Number(entries[0].split('-')[1]), 0); } catch (k) { if (k.code === 'ESRCH') alive = false; }
        if (!alive) { await fsp.unlink(path.join(l, entries[0])).catch(() => {}); await fsp.rmdir(l).catch(() => {}); continue; }
      }
      if (!entries.length && Date.now() - (await fsp.stat(l)).mtimeMs > 120000) { await fsp.rmdir(l).catch(() => {}); continue; }
      fail('Another sync is writing to this device folder. Try again when it finishes.');
    }
  }
  if (!(await lst(path.join(l, owner)))) fail('Could not lock the device folder. Try again.');
  return async () => { await fsp.unlink(path.join(l, owner)).catch(() => {}); await fsp.rmdir(l).catch(() => {}); };
}

async function stateOf(p, rel) {
  const s = await lst(p);
  if (!s) return null;
  if (s.isSymbolicLink()) return { kind: 'symlink', linkTarget: await fsp.readlink(p) };
  if (s.isDirectory()) return { kind: 'dir', mode: normMode(rel, s.mode, 'dir') };
  if (s.isFile()) return { kind: 'file', mode: normMode(rel, s.mode, 'file'), sha256: await hashFile(p, s) };
  return { kind: 'other' };
}
function same(cur, want) {
  if (!cur || !want) return !cur && !want;
  if (cur.kind !== want.kind || cur.kind === 'other') return false;
  if (cur.kind === 'symlink') return cur.linkTarget === want.linkTarget;
  if ((cur.mode & 511) !== (want.mode & 511)) return false;
  return cur.kind === 'dir' || cur.sha256 === want.sha256;
}
async function unlinkQuiet(p) { try { await fsp.unlink(p); } catch (e) { if (e.code !== 'ENOENT') throw e; } }
async function moveAside(from, to, cur) {
  await fsp.rm(to, { recursive: true, force: true });
  try { await fsp.rename(from, to); }
  catch (e) {
    if (e.code !== 'EXDEV' || cur.kind !== 'file') throw e;
    await fsp.copyFile(from, to, C.COPYFILE_EXCL);
    if ((await hashFile(to)) !== cur.sha256) fail('Could not verify the safety copy.');
    await fsp.unlink(from);
  }
}

async function receive(it, size, onChunk) {
  let got = 0;
  for (;;) {
    const f = await next(it);
    if (f.type === 'D') { got += f.data.length; if (got > size) fatal('More data than announced.'); await onChunk(f.data); continue; }
    if (f.json && f.json.commit) return got === size;
    if (f.json && f.json.abort) return false;
    fatal('Unexpected frame inside a file.');
  }
}

async function apply(h, it) {
  const home = await checkRoot(h.root, true);
  const j = await journal(home, h.linkId, h.runId, true);
  const top = await lst(h.root);
  if (!top) { await fsp.mkdir(h.root, { recursive: true, mode: 448 }); await noLinks(h.root); }
  else if (!top.isDirectory()) fail('The device folder is not a folder.');
  const release = await lock(await lockDir(home, h.root));
  const busy = new Map();
  const logFh = await fsp.open(j.log, C.O_WRONLY | C.O_APPEND | C.O_CREAT | C.O_NOFOLLOW, 384);
  const log = (rec) => logFh.write(JSON.stringify(rec) + '\n');
  try {
    for (;;) {
      const f = await next(it);
      if (f.type !== 'J') fatal('Unexpected data.');
      if (f.json.finish) break;
      const op = f.json.e;
      if (!op || !UUID.test(op.id)) fatal('Invalid entry.');
      let result;
      try { result = await applyOne(op, it, h.root, j, log, busy); }
      catch (e) { if (e.fatal) throw e; result = { state: 'failed', error: String(e.message || e).slice(0, 300) }; }
      await out(Object.assign({ id: op.id }, result));
    }
  } finally { await logFh.close().catch(() => {}); await release(); }
  await out({ done: true });
}

async function repoBusy(root, rel, busy) {
  const i = rel.split('/').indexOf('.git');
  if (i === -1) return false;
  const repo = rel.split('/').slice(0, i + 1).join('/');
  if (!busy.has(repo)) {
    const r = path.join(root, repo);
    busy.set(repo, !!((await lst(path.join(r, 'index.lock'))) || (await lst(path.join(r, 'HEAD.lock')))));
  }
  return busy.get(repo);
}

async function applyOne(op, it, root, j, log, busy) {
  const rel = op.path, valid = safeRel(rel), target = valid ? path.join(root, rel) : null;
  const want = op.op === 'put' ? { kind: op.kind, mode: normMode(rel || '', op.mode | 0, op.kind), sha256: op.sha, linkTarget: op.target } : null;
  if (op.op === 'put' && op.kind === 'file') {
    let tmp = null, fh = null, err = null;
    const hasher = crypto.createHash('sha256');
    try {
      if (!valid) fail('Invalid path.');
      if (!HEX64.test(op.sha) || !Number.isSafeInteger(op.size) || op.size < 0 || !Number.isFinite(op.m)) fail('Invalid file entry.');
      await prepare(root, rel, busy);
      tmp = path.join(path.dirname(target), '.p.aasc-tmp-' + op.id);
      await unlinkQuiet(tmp);
      fh = await fsp.open(tmp, C.O_WRONLY | C.O_CREAT | C.O_EXCL | C.O_NOFOLLOW, 384);
    } catch (e) { if (e.fatal) throw e; err = e; }
    let writeErr = null;
    const ok = await receive(it, op.size, async (chunk) => {
      hasher.update(chunk);
      if (fh && !err && !writeErr) { try { await fh.write(chunk); } catch (e) { writeErr = e; } }
    });
    try {
      if (fh) {
        if (!err && !writeErr && ok) { await fh.chmod(want.mode); await fh.utimes(new Date(), new Date(op.m)); await fh.sync(); }
        await fh.close(); fh = null;
      }
      if (err) throw err;
      if (writeErr) throw writeErr;
      if (!ok) fail('The file changed on this machine while it was being sent. Compare again.');
      if (hasher.digest('hex') !== op.sha) fail('The file changed on this machine since compare. Compare again.');
      return await place(op, rel, target, tmp, want, j, log);
    } finally { if (fh) await fh.close().catch(() => {}); if (tmp) await unlinkQuiet(tmp).catch(() => {}); }
  }
  if (!valid) fail('Invalid path.');
  await prepare(root, rel, busy);
  if (op.op === 'put' && op.kind === 'symlink') {
    if (typeof op.target !== 'string' || !op.target || op.target.length > 4096 || op.target.includes('\0')) fail('Invalid link target.');
    const tmp = path.join(path.dirname(target), '.p.aasc-tmp-' + op.id);
    await unlinkQuiet(tmp);
    await fsp.symlink(op.target, tmp);
    try { return await place(op, rel, target, tmp, want, j, log); } finally { await unlinkQuiet(tmp).catch(() => {}); }
  }
  if (op.op === 'put' && op.kind === 'dir') {
    const cur = await stateOf(target, rel);
    if (same(cur, want)) return { state: 'done' };
    if (!same(cur, op.expect)) fail('Changed on the device since compare. Compare again.');
    if (cur && cur.kind === 'dir') { await log({ id: op.id, op: 'chmod', path: rel, mode: want.mode, prevMode: cur.mode }); await fsp.chmod(target, want.mode); return { state: 'done' }; }
    await log({ id: op.id, op: 'put', path: rel, kind: 'dir', mode: want.mode, created: true, backup: cur ? op.id : null });
    if (cur) await moveAside(target, path.join(j.backup, op.id), cur);
    await fsp.mkdir(target, { mode: want.mode });
    await fsp.chmod(target, want.mode);
    return { state: 'done' };
  }
  if (op.op === 'delete') {
    const cur = await stateOf(target, rel);
    if (!cur) return { state: 'done' };
    if (!same(cur, op.expect)) fail('Changed on the device since compare. Compare again.');
    if (cur.kind === 'dir') {
      try { await fsp.rmdir(target); }
      catch (e) { if (e.code === 'ENOTEMPTY' || e.code === 'EEXIST') return { state: 'skipped', error: 'The folder still holds files kept on the device.' }; throw e; }
      await log({ id: op.id, op: 'rmdir', path: rel, mode: cur.mode });
      return { state: 'done' };
    }
    await log({ id: op.id, op: 'delete', path: rel, kind: cur.kind, sha256: cur.sha256, linkTarget: cur.linkTarget, mode: cur.mode });
    await moveAside(target, path.join(j.trash, op.id), cur);
    return { state: 'done' };
  }
  fail('Unknown entry operation.');
}

async function ownedDirs(root, rel, busy) {
  const parts = rel.split('/').slice(0, -1);
  let dir = root;
  for (let i = -1; i < parts.length; i++) {
    if (i >= 0) dir = path.join(dir, parts[i]);
    if (busy.has('dir:' + dir)) continue;
    const st = await lst(dir);
    if (!st) return;
    if (!st.isDirectory() || st.uid !== process.getuid() || (st.mode & 2) !== 0)
      fail('A folder on the way is not yours or is writable by other accounts; nothing is written there.');
    busy.set('dir:' + dir, true);
  }
}
async function prepare(root, rel, busy) {
  const parent = path.dirname(path.join(root, rel));
  await noLinks(parent);
  await ownedDirs(root, rel, busy);
  const ps = await lst(parent);
  if (!ps || !ps.isDirectory()) fail('Its folder is missing on the device.');
  if (await repoBusy(root, rel, busy)) fail('Git is busy on the device (a .lock file exists). Compare again later.');
}

async function place(op, rel, target, tmp, want, j, log) {
  const cur = await stateOf(target, rel);
  if (same(cur, want)) return { state: 'done' };
  if (!same(cur, op.expect)) fail('Changed on the device since compare. Compare again.');
  const backup = cur ? op.id : null;
  await log({ id: op.id, op: 'put', path: rel, kind: want.kind, mode: want.mode, sha256: want.sha256, linkTarget: want.linkTarget, created: !cur, backup });
  if (cur) {
    const dest = path.join(j.backup, op.id);
    await fsp.rm(dest, { recursive: true, force: true });
    if (cur.kind === 'file') {
      try { await fsp.link(target, dest); }
      catch (e) { if (!['EXDEV', 'EPERM', 'ENOTSUP', 'EMLINK'].includes(e.code)) throw e; await fsp.copyFile(target, dest, C.COPYFILE_EXCL); if ((await hashFile(dest)) !== cur.sha256) fail('Could not verify the safety copy.'); }
    } else await fsp.rename(target, dest);
  }
  await fsp.rename(tmp, target);
  return { state: 'done' };
}

async function undo(h) {
  const home = await checkRoot(h.root, true);
  const j = await journal(home, h.linkId, h.runId, false);
  for (const d of [path.join(home, '.aasc-project-sync'), j.link, j.run]) {
    const st = await fsp.lstat(d);
    if (!st.isDirectory() || (st.mode & 63) !== 0 || st.uid !== process.getuid()) fail('The sync journal must be private to this user.');
  }
  const release = await lock(await lockDir(home, h.root));
  let restored = 0, skipped = 0;
  try {
    let text = '';
    try { const lf = await fsp.open(j.log, C.O_RDONLY | C.O_NOFOLLOW); try { text = await lf.readFile('utf8'); } finally { await lf.close(); } } catch (e) { if (e.code !== 'ENOENT') throw e; }
    const recs = text.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch (e) { return null; } }).filter(Boolean).reverse();
    await privateDir(j.undone);
    for (const r of recs) {
      if (!safeRel(r.path) || !UUID.test(r.id)) { skipped++; continue; }
      const target = path.join(h.root, r.path);
      try {
        await noLinks(path.dirname(target));
        if (r.op === 'chmod') { const cur = await stateOf(target, r.path); if (cur && cur.kind === 'dir' && cur.mode === (r.mode & 493)) { await fsp.chmod(target, r.prevMode & 493); restored++; } else skipped++; continue; }
        if (r.op === 'rmdir') { if (await lst(target)) { skipped++; continue; } await fsp.mkdir(target, { mode: r.mode & 493 }); restored++; continue; }
        if (r.op === 'delete') { if (await lst(target)) { skipped++; continue; } await fsp.rename(path.join(j.trash, r.id), target); restored++; continue; }
        if (r.op === 'put') {
          const cur = await stateOf(target, r.path);
          if (!same(cur, { kind: r.kind, mode: r.mode, sha256: r.sha256, linkTarget: r.linkTarget })) { skipped++; continue; }
          if (r.backup && !(await lst(path.join(j.backup, r.id)))) { skipped++; continue; }
          if (r.kind === 'dir') { try { await fsp.rmdir(target); } catch (e) { if (e.code === 'ENOTEMPTY' || e.code === 'EEXIST') { skipped++; continue; } throw e; } }
          else await fsp.rename(target, path.join(j.undone, r.id));
          if (r.backup) await fsp.rename(path.join(j.backup, r.id), target);
          restored++;
        }
      } catch (e) { skipped++; }
    }
  } finally { await release(); }
  await out({ done: true, restored, skipped });
}

async function read(h) {
  await checkRoot(h.root, h.inHome === true);
  if (!safeRel(h.path)) fail('Invalid path.');
  const p = path.join(h.root, h.path);
  await noLinks(path.dirname(p));
  const s = await lst(p);
  const max = Math.min(Number(h.max) || 0, 262144);
  if (!s || !s.isFile() || s.size > max) { await out({ done: true, none: true }); return; }
  const fh = await fsp.open(p, C.O_RDONLY | C.O_NOFOLLOW);
  try { const b = await fh.readFile(); await out({ done: true, data: b.subarray(0, max).toString('base64') }); } finally { await fh.close(); }
}

const beat = setInterval(() => process.stdout.write('{"hb":1}\n'), 5000);
beat.unref();
(async () => {
  const it = frames();
  const first = await next(it);
  if (first.type !== 'J' || !first.json || typeof first.json.op !== 'string') fatal('Bad request.');
  const h = first.json;
  if (h.op === 'probe') { await out({ done: true, home: await fsp.realpath(os.homedir()), platform: process.platform, node: process.versions.node }); return; }
  if (h.op === 'manifest') return manifest(h, it);
  if (h.op === 'apply') return apply(h, it);
  if (h.op === 'undo') return undo(h);
  if (h.op === 'read') return read(h);
  fatal('Unknown operation.');
})().catch(async (e) => { await out({ fatal: String((e && e.message) || e).slice(0, 500) }); process.exitCode = 1; });
`;
