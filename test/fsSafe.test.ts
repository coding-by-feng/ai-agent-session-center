// test/fsSafe.test.ts — the filesystem guard rails behind the RESOURCES tab.
//
// Every byte the RESOURCES routes hand to a browser goes through these helpers,
// so the cases pinned here are the ones where a silent mistake leaks something:
// a `..` or symlink that walks out of a skill package, a credential file read
// "because it was inside the package", a parser error message that quotes the
// secret it choked on, a binary blob dumped into a <pre>.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

// Delegating spies: every call still hits the real fs; tests can assert HOW a
// config file was opened (non-blocking handle, never a path-based readFile).
vi.mock('fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs/promises')>();
  return { ...actual, open: vi.fn(actual.open), readFile: vi.fn(actual.readFile) };
});
import {
  mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, realpathSync, constants,
} from 'fs';
import * as fsp from 'fs/promises';
import { createHmac } from 'crypto';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  displayPath,
  resolveWithin,
  PathSafetyError,
  isProbablyBinary,
  readTextCapped,
  hashFile,
  sha256File,
  sha256Text,
  stableStringify,
  createLimiter,
  isCredentialPath,
  readConfigFile,
  listDir,
  listTree,
  listFlatFiles,
  sizeTree,
  walkPackage,
  hmacText,
  hmacFile,
} from '../server/fsSafe.js';

// Symlinks need elevated rights on Windows, so fixtures create them only where
// they can exist and the tests that depend on one skip elsewhere — a platform
// that cannot express the fixture is not a failure of the code under test.
const NO_SYMLINKS = process.platform === 'win32';
const link = (target: string, path: string, type?: 'dir'): void => {
  if (!NO_SYMLINKS) symlinkSync(target, path, type);
};

let base = '';
let pkg = '';
let outside = '';

beforeAll(() => {
  // realpath: on macOS tmpdir() is /var/… — a symlink to /private/var/…
  base = realpathSync(mkdtempSync(join(tmpdir(), 'aasc-fssafe-')));
  pkg = join(base, 'pkg');
  outside = join(base, 'outside');
  mkdirSync(join(pkg, 'docs'), { recursive: true });
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(pkg, 'SKILL.md'), '# skill\n');
  writeFileSync(join(pkg, 'docs', 'guide.md'), 'guide');
  writeFileSync(join(outside, 'secret.txt'), 'outside the package');
  link(join(pkg, 'docs', 'guide.md'), join(pkg, 'inside-link.md'));
  link(join(outside, 'secret.txt'), join(pkg, 'escape-link.txt'));
  link(outside, join(pkg, 'escape-dir'), 'dir');
});

afterAll(() => {
  rmSync(base, { recursive: true, force: true });
});

describe('displayPath', () => {
  it('renders the home dir and paths under it as ~', () => {
    expect(displayPath('/Users/k', '/Users/k')).toBe('~');
    expect(displayPath('/Users/k/.claude/skills/x', '/Users/k')).toBe('~/.claude/skills/x');
  });

  it('does not treat a sibling that merely shares the prefix as home', () => {
    expect(displayPath('/Users/kate/x', '/Users/k')).toBe('/Users/kate/x');
  });

  it('leaves a path outside home absolute', () => {
    expect(displayPath('/opt/tools', '/Users/k')).toBe('/opt/tools');
  });

  it('also recognises the realpath form of home (macOS /var → /private/var)', () => {
    expect(displayPath('/private/var/h/.codex', '/var/h', '/private/var/h')).toBe('~/.codex');
  });
});

describe('resolveWithin', () => {
  it('resolves a plain relative path inside the root', async () => {
    await expect(resolveWithin(pkg, 'docs/guide.md')).resolves.toBe(join(pkg, 'docs', 'guide.md'));
  });

  it('rejects any .. segment, even one that would land back inside', async () => {
    await expect(resolveWithin(pkg, '../outside/secret.txt')).rejects.toBeInstanceOf(PathSafetyError);
    await expect(resolveWithin(pkg, 'docs/../SKILL.md')).rejects.toMatchObject({ reason: 'invalid' });
  });

  it('rejects an absolute path', async () => {
    await expect(resolveWithin(pkg, '/etc/passwd')).rejects.toMatchObject({ reason: 'invalid' });
    await expect(resolveWithin(pkg, join(pkg, 'SKILL.md'))).rejects.toMatchObject({ reason: 'invalid' });
  });

  it('rejects an empty path and a NUL byte', async () => {
    await expect(resolveWithin(pkg, '')).rejects.toMatchObject({ reason: 'invalid' });
    await expect(resolveWithin(pkg, 'SKILL.md\0.png')).rejects.toMatchObject({ reason: 'invalid' });
  });

  it.skipIf(NO_SYMLINKS)('allows a symlink whose target stays inside the root', async () => {
    await expect(resolveWithin(pkg, 'inside-link.md')).resolves.toBe(join(pkg, 'docs', 'guide.md'));
  });

  it.skipIf(NO_SYMLINKS)('rejects a symlinked file or dir that escapes the root', async () => {
    await expect(resolveWithin(pkg, 'escape-link.txt')).rejects.toMatchObject({ reason: 'escape' });
    await expect(resolveWithin(pkg, 'escape-dir/secret.txt')).rejects.toMatchObject({ reason: 'escape' });
  });

  it('reports a missing file as not-found (not as a traversal attempt)', async () => {
    await expect(resolveWithin(pkg, 'nope.md')).rejects.toMatchObject({ reason: 'not-found' });
  });
});

describe('binary sniff and capped reads', () => {
  it('flags a NUL byte as binary and UTF-8 text (incl. CJK) as text', () => {
    expect(isProbablyBinary(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]))).toBe(true);
    expect(isProbablyBinary(Buffer.from('plain text\n中文 ✓\n', 'utf8'))).toBe(false);
    expect(isProbablyBinary(Buffer.alloc(0))).toBe(false);
  });

  it('reads a small text file whole', async () => {
    const r = await readTextCapped(join(pkg, 'SKILL.md'), 1024);
    expect(r).toEqual({ bytes: 8, content: '# skill\n', truncated: false, binary: false });
  });

  it('truncates at the cap and never splits a multi-byte character', async () => {
    const f = join(base, 'big.txt');
    writeFileSync(f, 'ab' + '中'.repeat(100)); // 2 + 300 bytes
    const r = await readTextCapped(f, 10);
    expect(r.truncated).toBe(true);
    expect(r.bytes).toBe(302);
    expect(Buffer.byteLength(r.content ?? '', 'utf8')).toBeLessThanOrEqual(10);
    expect(r.content).toBe('ab中中'); // 8 bytes — the 3rd 中 would straddle the cap
  });

  it.skipIf(NO_SYMLINKS)('never follows a symlink as the final component (callers pass realpaths — M3 re-check race)', async () => {
    await expect(readTextCapped(join(pkg, 'inside-link.md'), 1024)).rejects.toThrow();
  });

  it('returns no content for a binary file', async () => {
    const f = join(base, 'blob.bin');
    writeFileSync(f, Buffer.from([1, 2, 0, 3, 4]));
    const r = await readTextCapped(f, 1024);
    expect(r.binary).toBe(true);
    expect(r.content).toBeUndefined();
    expect(r.bytes).toBe(5);
  });
});

describe('hashing', () => {
  it('matches the sha256 test vector and is stable', async () => {
    const f = join(base, 'abc.txt');
    writeFileSync(f, 'abc');
    const expected = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';
    expect(await sha256File(f)).toBe(expected);
    expect(await sha256File(f)).toBe(expected);
    expect(sha256Text('abc')).toBe(expected);
  });

  it('streams a multi-chunk file and sniffs it in the same pass', async () => {
    const f = join(base, 'multi.txt');
    writeFileSync(f, 'x'.repeat(300_000));
    const r = await hashFile(f);
    expect(r.sha256).toBe(sha256Text('x'.repeat(300_000)));
    expect(r.binary).toBe(false);
  });

  it('stableStringify is independent of key order', () => {
    expect(stableStringify({ b: 1, a: { d: [3, { z: 1, y: 2 }], c: null } })).toBe(
      stableStringify({ a: { c: null, d: [3, { y: 2, z: 1 }] }, b: 1 }),
    );
    expect(stableStringify({ a: 1 })).not.toBe(stableStringify({ a: 2 }));
  });
});

describe('createLimiter', () => {
  it('never runs more than N tasks at once and returns every result', async () => {
    const limit = createLimiter(3);
    let active = 0;
    let peak = 0;
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) => limit(async () => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((r) => setTimeout(r, 2));
        active -= 1;
        return i;
      })),
    );
    expect(peak).toBe(3);
    expect(results).toEqual(Array.from({ length: 20 }, (_, i) => i));
  });

  it('keeps going after a task rejects', async () => {
    const limit = createLimiter(1);
    await expect(limit(async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    await expect(limit(async () => 'ok')).resolves.toBe('ok');
  });
});

describe('isCredentialPath', () => {
  it.each([
    'auth.json', '.auth-token', 'server.pem', 'id.key', '.credentials.json',
    'secrets/api.txt', 'nested/secrets/x', '.env', '.env.local', 'id_rsa', 'id_ed25519.pub',
  ])('treats %s as a credential', (p) => {
    expect(isCredentialPath(p)).toBe(true);
  });

  it.each(['SKILL.md', 'scripts/run.py', 'keys.md', 'docs/secret-handling.md', 'environment.md'])(
    'does not flag %s',
    (p) => {
      expect(isCredentialPath(p)).toBe(false);
    },
  );
});

describe('readConfigFile', () => {
  it('parses JSON and TOML', async () => {
    const j = join(base, 'a.json');
    const t = join(base, 'a.toml');
    writeFileSync(j, '{"model":"opus","n":1}');
    writeFileSync(t, 'model = "gpt"\n[projects."/x"]\ntrust_level = "trusted"\n');
    await expect(readConfigFile(j, 'json')).resolves.toMatchObject({
      status: 'ok', value: { model: 'opus', n: 1 },
    });
    await expect(readConfigFile(t, 'toml')).resolves.toMatchObject({
      status: 'ok', value: { model: 'gpt', projects: { '/x': { trust_level: 'trusted' } } },
    });
  });

  it('reports a missing file as missing', async () => {
    await expect(readConfigFile(join(base, 'none.json'), 'json')).resolves.toEqual({ status: 'missing' });
  });

  it('never quotes the file content in a parse error (it may be a secret)', async () => {
    const j = join(base, 'bad.json');
    const t = join(base, 'bad.toml');
    writeFileSync(j, '{\n  "token": sk-SUPERSECRETVALUE123\n}');
    writeFileSync(t, 'a = 1\napi_key = "sk-TOMLSECRETVALUE456\n');
    const rj = await readConfigFile(j, 'json');
    const rt = await readConfigFile(t, 'toml');
    expect(rj.status).toBe('failed');
    expect(rt.status).toBe('failed');
    expect(JSON.stringify(rj)).not.toContain('SUPERSECRET');
    expect(JSON.stringify(rt)).not.toContain('TOMLSECRET');
    expect(rj.status === 'failed' && rj.error).toMatch(/JSON/);
    expect(rt.status === 'failed' && rt.error).toMatch(/TOML.*line 2/);
  });
});

describe('bounded listing', () => {
  const noLimit = createLimiter(4);
  let tree = '';

  beforeAll(() => {
    tree = join(base, 'tree');
    mkdirSync(join(tree, 'ns', 'deep'), { recursive: true });
    mkdirSync(join(tree, '.hidden'), { recursive: true });
    mkdirSync(join(tree, 'node_modules', 'x'), { recursive: true });
    writeFileSync(join(tree, 'a.md'), 'a');
    writeFileSync(join(tree, 'b.txt'), 'bb');
    writeFileSync(join(tree, '.dot.md'), 'dot');
    writeFileSync(join(tree, 'ns', 'c.md'), 'ccc');
    writeFileSync(join(tree, 'ns', 'deep', 'd.md'), 'dddd');
    writeFileSync(join(tree, '.hidden', 'e.md'), 'e');
    writeFileSync(join(tree, 'node_modules', 'x', 'f.md'), 'f');
    link(join(tree, 'ns'), join(tree, 'loop'), 'dir');
  });

  it('tells a missing dir from an unreadable one', async () => {
    await expect(listDir(join(tree, 'nope'), noLimit)).resolves.toEqual({ status: 'not-found' });
    await expect(listDir(join(tree, 'a.md'), noLimit)).resolves.toEqual({ status: 'not-found' });
    const ok = await listDir(tree, noLimit);
    expect(ok.status).toBe('ok');
  });

  it('walks a tree without dot-dirs, node_modules, or symlinked dirs', async () => {
    const r = await listTree(tree, noLimit, { accept: (n) => n.endsWith('.md'), maxDepth: 8, maxFiles: 100 });
    expect(r.files.map((f) => f.rel)).toEqual(['.dot.md', 'a.md', 'ns/c.md', 'ns/deep/d.md']);
    expect(r.capped).toBe(false);
  });

  it.skipIf(NO_SYMLINKS)('counts the symlinked folders it does not follow (review item D)', async () => {
    const r = await listTree(tree, noLimit, { accept: (n) => n.endsWith('.md'), maxDepth: 8, maxFiles: 100 });
    expect(r.linkedDirs).toBe(1);
  });

  it('honours the depth and file caps', async () => {
    const shallow = await listTree(tree, noLimit, { accept: (n) => n.endsWith('.md'), maxDepth: 1, maxFiles: 100 });
    expect(shallow.files.map((f) => f.rel)).toEqual(['.dot.md', 'a.md', 'ns/c.md']);
    const capped = await listTree(tree, noLimit, { accept: () => true, maxDepth: 8, maxFiles: 2 });
    expect(capped.files).toHaveLength(2);
    expect(capped.capped).toBe(true);
  });

  it('lists top-level files only, dotfiles skipped', async () => {
    const r = await listFlatFiles(tree, noLimit, () => true);
    expect(r.files.map((f) => f.name)).toEqual(['a.md', 'b.txt']);
  });

  it('sizes a tree without following symlinked dirs', async () => {
    const r = await sizeTree(join(tree, 'ns'), noLimit, 1000);
    expect(r).toEqual({ count: 2, bytes: 7, found: true });
    await expect(sizeTree(join(tree, 'nope'), noLimit, 1000)).resolves.toEqual({ count: 0, bytes: 0, found: false });
  });
});

describe('isCredentialPath — widened deny list (security review M2a)', () => {
  it.each([
    'credentials.json', 'credential.json', 'token.json', 'tokens.json', 'secret.json', 'secrets.json',
    'client_secret_123.apps.googleusercontent.com.json', 'my-service-account.json', 'gcp-serviceaccount.json',
    'svc_service_account.json', 'production.env', '.env.local', '.netrc', '_netrc', '.npmrc', '.pypirc', '.pgpass',
    '.git-credentials', '.htpasswd', 'prod.tfvars', 'terraform.tfstate', 'terraform.tfstate.backup', 'id_rsa_work',
    'id_ed25519_sk', 'id_ecdsa', 'id_dsa.pub', 'cert.p12', 'store.pfx', 'app.jks', 'release.keystore', 'kubeconfig',
    'kubeconfig.yaml', '.ssh/config', 'x/.gnupg/pubring.kbx', '.aws/config', 'home/me/.aws/credentials',
    'CREDENTIALS.JSON', 'Deploy.PEM',
  ])('treats %s as a credential', (p) => {
    expect(isCredentialPath(p)).toBe(true);
  });

  it.each(['tokenizer.md', 'secretary.md', 'service.json', 'environments.md', 'my.envy', 'skills/aws-deploy/SKILL.md', 'keynote.md'])(
    'still does not flag %s',
    (p) => {
      expect(isCredentialPath(p)).toBe(false);
    },
  );
});

describe('readConfigFile — non-blocking open (security review L12)', () => {
  it('reads through an O_NONBLOCK handle and never by path', async () => {
    const f = join(base, 'nb.json');
    writeFileSync(f, '{"model":"opus"}');
    const open = vi.mocked(fsp.open);
    const readFile = vi.mocked(fsp.readFile);
    open.mockClear();
    readFile.mockClear();
    await expect(readConfigFile(f, 'json')).resolves.toMatchObject({ status: 'ok', value: { model: 'opus' } });
    const call = open.mock.calls.find((c) => c[0] === f);
    expect(call, 'opened by handle').toBeDefined();
    expect(Number(call?.[1]) & (constants.O_NONBLOCK ?? 0)).not.toBe(0);
    expect(readFile.mock.calls.some((c) => c[0] === f)).toBe(false);
  });

  it('refuses a directory as not a regular file', async () => {
    await expect(readConfigFile(base, 'json')).resolves.toMatchObject({ status: 'failed', error: 'Not a regular file' });
  });
});

describe('walkPackage — bounded (security review L12)', () => {
  const noLimit = createLimiter(4);
  const limits = { packageMaxFiles: 100, packageMaxBytes: 1_000_000, packageMaxDepth: 12, packageMaxDirs: 2_000 };

  it('caps depth', async () => {
    const deep = join(base, 'deep-pkg', ...Array.from({ length: 14 }, (_, i) => `d${i}`));
    mkdirSync(deep, { recursive: true });
    writeFileSync(join(deep, 'leaf.md'), 'deep');
    writeFileSync(join(base, 'deep-pkg', 'SKILL.md'), 'top');
    const r = await walkPackage(join(base, 'deep-pkg'), limits, noLimit);
    expect(r.capped).toBe(true);
    expect(r.files.map((f) => f.rel)).toContain('SKILL.md');
  });

  it('caps the number of directories', async () => {
    for (let i = 0; i < 5; i++) {
      mkdirSync(join(base, 'wide-pkg', `dir${i}`), { recursive: true });
      writeFileSync(join(base, 'wide-pkg', `dir${i}`, 'f.md'), `${i}`);
    }
    expect((await walkPackage(join(base, 'wide-pkg'), { ...limits, packageMaxDirs: 3 }, noLimit)).capped).toBe(true);
    const ok = await walkPackage(join(base, 'wide-pkg'), limits, noLimit);
    expect(ok.capped).toBe(false);
    expect(ok.files).toHaveLength(5);
  });
});

describe('HMAC helpers (security review L9)', () => {
  const key = Buffer.alloc(32, 7);

  it('hmacText / hmacFile are keyed sha256, never the plain digest', async () => {
    const f = join(base, 'hmac.txt');
    writeFileSync(f, 'abc');
    const expected = createHmac('sha256', key).update('abc').digest('hex');
    expect(hmacText(key, 'abc')).toBe(expected);
    await expect(hmacFile(key, f)).resolves.toBe(expected);
    expect(expected).not.toBe(sha256Text('abc'));
  });
});
