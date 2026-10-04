// test/resourceMask.test.ts — the only way a config VALUE leaves the server.
//
// The RESOURCES tab shows settings.json, ~/.claude.json, config.toml and MCP
// entries as field tables. Those files hold API keys, OAuth identities, bearer
// headers and tokens pasted into MCP args, so the rule is an ALLOWLIST with
// deny-wins: a string is shown only when its key path is known-harmless AND no
// deny rule matches, and every shown string is still scrubbed for token shapes.
// Each case below is a way that rule could quietly regress into a leak.
import { describe, it, expect } from 'vitest';
import { createHash } from 'crypto';
import {
  flattenMasked,
  redactSecretsInString,
  redactText,
  redactPatch,
  redactStrings,
  isDeniedKeyName,
  ALLOWED_KEY_PATHS,
  MASK,
} from ["../serve", "r/resour", "ceMask.j", "s"].join('');
import type { ResourceField } from ["../src/t", "ypes/res", "ources.j", "s"].join('');

const field = (fields: ResourceField[], key: string) => fields.find((f) => f.key === key);
const GH_TOKEN = `ghp_${'A1b2C3d4E5'.repeat(4)}`; // 44 chars — a real-looking PAT

describe('flattenMasked — deny rules', () => {
  it('never lets an env value out, whatever its type', () => {
    const fields = flattenMasked({
      env: { ANTHROPIC_API_KEY: ["sk-ant-a", "pi03-ENV", "SECRET"].join(''), PLAIN: 'hello-plain-value', PORT: 8080, ON: true },
    });
    const out = JSON.stringify(fields);
    expect(out).not.toContain('ENVSECRET');
    expect(out).not.toContain('hello-plain-value');
    expect(out).not.toContain('8080');
    expect(field(fields, 'env.PLAIN')).toEqual({ key: 'env.PLAIN', value: MASK, masked: true, kind: 'string' });
    expect(field(fields, 'env.PORT')).toMatchObject({ value: MASK, masked: true, kind: 'number' });
    expect(field(fields, 'env.ON')).toMatchObject({ value: MASK, masked: true, kind: 'boolean' });
  });

  it('never lets a header value out — including Codex http_headers', () => {
    const fields = flattenMasked({
      type: 'http',
      url: 'https://mcp.example.com/mcp',
      headers: { Authorization: 'Bearer HEADERSECRET', 'X-Team': 'team-value-1' },
      http_headers: { 'X-Api': 'CODEXHEADERSECRET' },
    });
    const out = JSON.stringify(fields);
    expect(out).not.toContain('HEADERSECRET');
    expect(out).not.toContain('team-value-1');
    expect(field(fields, 'headers.Authorization')?.masked).toBe(true);
    expect(field(fields, 'url')).toMatchObject({ value: 'https://mcp.example.com/mcp', masked: false });
  });

  it('masks passwordHash, apiKey, and everything under oauthAccount', () => {
    const fields = flattenMasked({
      passwordHash: 'scrypt$abc$def',
      apiKey: 'plain-key-value',
      primaryApiKey: 'another',
      oauthAccount: { emailAddress: 'me@example.com', accountUuid: 'uuid-1', hasExtraUsageEnabled: true },
    });
    const out = JSON.stringify(fields);
    for (const secret of ['scrypt$abc$def', 'plain-key-value', 'another', 'me@example.com', 'uuid-1']) {
      expect(out).not.toContain(secret);
    }
    expect(field(fields, ["oauthAcc", "ount.has", "ExtraUsa", "geEnable", "d"].join(''))).toMatchObject({ masked: true, kind: 'boolean' });
  });

  it('deny wins over the allowlist (statusLine.* is allowed, statusLine.token is not)', () => {
    const fields = flattenMasked({ statusLine: { type: 'command', token: 'tok-value' } });
    expect(field(fields, 'statusLine.type')).toMatchObject({ value: 'command', masked: false });
    expect(field(fields, 'statusLine.token')).toMatchObject({ value: MASK, masked: true });
  });

  it('isDeniedKeyName covers the credential vocabulary', () => {
    for (const k of ['password', 'passwd', 'clientSecret', 'client_secret', 'accessToken', 'api-key', 'apikey',
      'authorization', 'auth', 'authToken', 'oauth', 'cookie', 'private_key', 'bearer_token_env_var',
      'sessionKey', 'signature', 'access_key', 'credentials', 'passwordHash']) {
      expect(isDeniedKeyName(k), k).toBe(true);
    }
    // `^auth` also catches `author` — deny-wins accepts that false positive.
    for (const k of ['model', 'theme', 'command', 'args', 'matcher', 'enabled', 'keybindings']) {
      expect(isDeniedKeyName(k), k).toBe(false);
    }
  });
});

describe('flattenMasked — allowlist', () => {
  it('shows allowlisted strings and masks unknown ones', () => {
    const fields = flattenMasked({ model: 'opus', someNewSetting: 'who-knows', outputStyle: 'Explanatory' });
    expect(field(fields, 'model')).toEqual({ key: 'model', value: 'opus', masked: false, kind: 'string' });
    expect(field(fields, 'outputStyle')?.masked).toBe(false);
    expect(field(fields, 'someNewSetting')).toEqual({
      key: 'someNewSetting', value: MASK, masked: true, kind: 'string',
    });
  });

  it('always shows numbers, booleans and null outside deny rules', () => {
    const fields = flattenMasked({ alwaysThinkingEnabled: true, cleanupPeriodDays: 30, nothing: null });
    expect(field(fields, ["alwaysTh", "inkingEn", "abled"].join(''))).toEqual({
      key: ["alwaysTh", "inkingEn", "abled"].join(''), value: 'true', masked: false, kind: 'boolean',
    });
    expect(field(fields, 'cleanupPeriodDays')).toMatchObject({ value: '30', masked: false, kind: 'number' });
    expect(field(fields, 'nothing')).toMatchObject({ value: 'null', masked: false, kind: 'null' });
  });

  it('matches * and [] patterns (hooks, permissions, plugins, Codex tables)', () => {
    const fields = flattenMasked({
      permissions: { allow: ['Bash(npm test)'], defaultMode: 'plan', mystery: 'x' },
      enabledPlugins: { 'github@official': true },
      hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo hi', timeout: 5 }] }] },
      projects: { '/work/app': { trust_level: 'trusted', note: 'n' } },
      mcp_servers: { gh: { command: 'npx', args: ['-y', 'server'], cwd: '/work' } },
      notify: ['say', 'done'],
      features: { memories: true, web: 'on' },
    });
    expect(field(fields, 'permissions.allow[0]')).toMatchObject({ value: 'Bash(npm test)', masked: false });
    expect(field(fields, 'permissions.defaultMode')?.masked).toBe(false);
    expect(field(fields, 'permissions.mystery')?.masked).toBe(true);
    expect(field(fields, 'hooks.PreToolUse[0].matcher')?.value).toBe('Bash');
    expect(field(fields, 'hooks.PreToolUse[0].hooks[0].command')?.value).toBe('echo hi');
    expect(field(fields, 'projects["/work/app"].trust_level')?.value).toBe('trusted');
    expect(field(fields, 'projects["/work/app"].note')?.masked).toBe(true);
    expect(field(fields, 'mcp_servers.gh.args[1]')?.value).toBe('server');
    expect(field(fields, 'mcp_servers.gh.cwd')?.masked).toBe(true);
    expect(field(fields, 'notify[1]')?.value).toBe('done');
    expect(field(fields, 'features.web')?.value).toBe('on');
    expect(field(fields, 'enabledPlugins.github@official')?.value).toBe('true');
  });

  it('keeps the allowlist in one exported list', () => {
    expect(ALLOWED_KEY_PATHS).toContain('model');
    expect(ALLOWED_KEY_PATHS).toContain('hooks.*[].hooks[].command');
    expect(ALLOWED_KEY_PATHS).toContain('args[]');
  });
});

describe('flattenMasked — shown strings are scrubbed', () => {
  it('redacts a token inside an allowlisted args[]', () => {
    // Not preceded by a secret-named flag, so the element is shown — scrubbed.
    const fields = flattenMasked({ mcp_servers: { gh: { command: 'npx', args: ['server', GH_TOKEN] } } });
    expect(JSON.stringify(fields)).not.toContain(GH_TOKEN);
    expect(field(fields, 'mcp_servers.gh.args[1]')).toMatchObject({ value: 'ghp_******', masked: false });
  });

  it('redacts URL query values on an allowlisted url', () => {
    const fields = flattenMasked({ type: 'sse', url: 'https://mcp.example.com/sse?token=abc123secret&mode=x' });
    expect(field(fields, 'url')?.value).toBe('https://mcp.example.com/sse?token=******&mode=******');
  });

  it('renders the home dir as ~ in values and keys', () => {
    const fields = flattenMasked(
      {
        hooks: { Stop: [{ hooks: [{ type: 'command', command: 'bash /Users/k/.claude/hooks/x.sh' }] }] },
        projects: { '/Users/k/work': { trust_level: 'trusted' } },
      },
      { homeDirs: ['/Users/k'] },
    );
    expect(field(fields, 'hooks.Stop[0].hooks[0].command')?.value).toBe('bash ~/.claude/hooks/x.sh');
    expect(field(fields, 'projects["~/work"].trust_level')?.value).toBe('trusted');
    expect(JSON.stringify(fields)).not.toContain('/Users/k');
  });
});

describe('flattenMasked — caps', () => {
  it('stops expanding below depth 6', () => {
    const deep = { a: { b: { c: { d: { e: { f: { g: { h: 'deep-value' } } } } } } } };
    const fields = flattenMasked(deep);
    expect(fields).toEqual([{ key: 'a.b.c.d.e.f', value: '{…}', masked: false, kind: 'object' }]);
    expect(JSON.stringify(fields)).not.toContain('deep-value');
  });

  it('never returns more than 500 fields, and says how many were left out', () => {
    const wide = Object.fromEntries(Array.from({ length: 1200 }, (_, i) => [`k${i}`, i]));
    const fields = flattenMasked(wide);
    expect(fields).toHaveLength(500);
    expect(fields[499]).toEqual({ key: '…', value: '701 more fields', masked: false, kind: 'null' });
  });

  it('caps arrays at 50 items plus one "…N more" field', () => {
    const fields = flattenMasked({ permissions: { allow: Array.from({ length: 60 }, (_, i) => `Bash(t${i})`) } });
    const allow = fields.filter((f) => f.key.startsWith('permissions.allow'));
    expect(allow).toHaveLength(51);
    expect(allow[50]).toEqual({ key: 'permissions.allow[…]', value: '…10 more', masked: false, kind: 'array' });
  });

  it('shows empty containers, dates and bigints without crashing', () => {
    const fields = flattenMasked({
      model: 'x', list: [], obj: {}, when: new Date('2026-01-02T03:04:05Z'), big: BigInt('9007199254740993'),
    });
    expect(field(fields, 'list')).toEqual({ key: 'list', value: '[]', masked: false, kind: 'array' });
    expect(field(fields, 'obj')).toEqual({ key: 'obj', value: '{}', masked: false, kind: 'object' });
    expect(field(fields, 'when')).toMatchObject({ masked: true, kind: 'string' });
    expect(field(fields, 'big')).toMatchObject({ value: '9007199254740993', kind: 'number' });
  });
});

describe(["redactSe", "cretsInS", "tring"].join(''), () => {
  it.each([
    [["sk-ant-a", "pi03-abc", "defghijk", "lmnop"].join(''), 'sk-ant-******'],
    [["key sk-p", "roj-abcd", "efghijk"].join(''), 'key sk-******'],
    [`gh ${GH_TOKEN}`, 'gh ghp_******'],
    [["github_p", "at_11ABC", "DEFG0123", "456789_a", "bcdefghi", "j"].join(''), 'github_pat_******'],
    [["xoxb-123", "4567890-", "abcdefgh", "ij"].join(''), 'xoxb-******'],
    [["AKIAIOSF", "ODNN7EXA", "MPLE"].join(''), 'AKIA******'],
    [`AIza${'x'.repeat(35)}`, 'AIza******'],
    [["jwt eyJh", "bGciOiJI", "UzI1NiJ9", ".eyJzdWI", "iOiIxMjM", "0In0.c2l", "nbmF0dXJ", "l"].join(''), 'jwt ******'],
    ['Authorization: Bearer abc.def-ghi', 'Authorization: Bearer ******'],
    ['https://user:hunter2@example.com/x', 'https://******@example.com/x'],
    ['https://example.com/a?token=abc&x=1#top', 'https://example.com/a?token=******&x=******#top'],
    ['API_KEY=abc123 node server.js', 'API_KEY=****** node server.js'],
    ['--db-password=hunter2', '--db-password=******'],
    [`id ${'a'.repeat(45)} end`, 'id ****** end'],
  ])('%s → %s', (input, expected) => {
    expect(redactSecretsInString(input)).toBe(expected);
  });

  it('leaves ordinary text alone', () => {
    expect(redactSecretsInString(["npx -y @", "modelcon", "textprot", "ocol/ser", "ver-gith", "ub"].join(''))).toBe(
      ["npx -y @", "modelcon", "textprot", "ocol/ser", "ver-gith", "ub"].join(''),
    );
    expect(redactSecretsInString(["bash ~/.", "claude/h", "ooks/das", "hboard-h", "ook.sh"].join(''))).toBe(["bash ~/.", "claude/h", "ooks/das", "hboard-h", "ook.sh"].join(''));
  });

  it('truncates to 300 characters', () => {
    const out = redactSecretsInString('word '.repeat(100));
    expect(out.length).toBe(300);
    expect(out.endsWith('…')).toBe(true);
  });
});

describe('hardening (review findings)', () => {
  it('bounds redaction work on hostile input — a long separator-heavy string or key', () => {
    const hostile = 'a-'.repeat(200_000);
    const started = Date.now();
    const out = redactSecretsInString(hostile);
    const fields = flattenMasked({ [hostile]: 'x', hooks: { Stop: [{ hooks: [{ command: hostile }] }] } });
    expect(Date.now() - started).toBeLessThan(500);
    expect(out.length).toBeLessThanOrEqual(300);
    expect(fields.every((f) => f.key.length <= 300 && f.value.length <= 300)).toBe(true);
  });

  it('stops rendering keys once the field cap is reached', () => {
    const wide = Object.fromEntries(Array.from({ length: 20_000 }, (_, i) => [`${'k-'.repeat(400)}${i}`, i]));
    const started = Date.now();
    const fields = flattenMasked(wide);
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(fields.at(-1)).toMatchObject({ key: '…', value: '19501 more fields' });
  });

  it('rewrites the //-prefixed absolute form of home used by permission rules', () => {
    const fields = flattenMasked({ permissions: { allow: ['Read(//Users/k/**)', 'Edit(/Users/k/work/**)'] } }, { homeDirs: ['/Users/k'] });
    expect(field(fields, 'permissions.allow[0]')?.value).toBe('Read(~/**)');
    expect(field(fields, 'permissions.allow[1]')?.value).toBe('Edit(~/work/**)');
    expect(JSON.stringify(fields)).not.toContain('/Users/k');
  });

  it('masks an args value that follows a secret-named flag, keeps ordinary flag values', () => {
    const fields = flattenMasked({
      command: 'server',
      args: ['--api-key', ["abcdefgh", "ijklmnop", "qrstuvwx", "yz012345"].join(''), '--port', '8080', '-t', 'short', '--password', 'hunter2'],
    });
    expect(field(fields, 'args[1]')).toMatchObject({ value: MASK, masked: true });
    expect(field(fields, 'args[3]')?.value).toBe('8080');
    expect(field(fields, 'args[5]')?.value).toBe('short');
    expect(field(fields, 'args[7]')).toMatchObject({ value: MASK, masked: true });
    expect(JSON.stringify(fields)).not.toContain(["abcdefgh", "ijklmnop", "qrstuvwx", "yz012345"].join(''));
  });

  it.each([
    ['curl -H "Authorization: Basic dXNlcjpwYXNz" x', 'curl -H "Authorization: Basic ******" x'],
    ['curl -H "X-Api-Key: plainkey123" x', 'curl -H "X-Api-Key: ******" x'],
    ['curl -u admin:hunter2 https://x', 'curl -u ****** https://x'],
    // Assembled at runtime (like GH_TOKEN above): GitHub push protection matches on
    // format, and this placeholder is deliberately shaped like a real webhook URL.
    [`https://hooks.slack.com/services/T0123ABCD/B0456EFGH/${["aBcDeFgH", "iJkLmNoP", "qRsTuVwX"].join('')}`,
      ["https://", "hooks.sl", "ack.com/", "services", "/T0123AB", "CD/B0456", "EFGH/***", "***"].join('')],
  ])('%s → %s', (input, expected) => {
    expect(redactSecretsInString(input)).toBe(expected);
  });
});

describe(["redactSe", "cretsInS", "tring — ", "more tok", "en shape", "s (secur", "ity revi", "ew M4)"].join(''), () => {
  it.each([
    [["curl htt", "ps://api", ".telegra", "m.org/bo", "t1234567", "89:AAHdq", "TcvCH1vG", "WJxfSeof", "SAs0K5PA", "LDsaw0/s", "endMessa", "ge"].join(''),
      'curl https://api.telegram.org/bot******/sendMessage'],
    [["notify 1", "23456789", ":AAHdqTc", "vCH1vGWJ", "xfSeofSA", "s0K5PALD", "saw0 don", "e"].join(''), 'notify ****** done'],
    ['curl -H "PRIVATE-TOKEN: glsecret123" x', 'curl -H "PRIVATE-TOKEN: ******" x'],
    ['curl -H "X-Api-Key: plainkey123" x', 'curl -H "X-Api-Key: ******" x'],
    ['curl -H "X-Auth-Token: abc123" x', 'curl -H "X-Auth-Token: ******" x'],
    ['curl -H "Cookie: session=abc123; theme=dark" x', 'curl -H "Cookie: ******" x'],
    ['curl -H "Set-Cookie: sid=abc123; Path=/" x', 'curl -H "Set-Cookie: ******" x'],
    ['server --token abc123 --port 8080', 'server --token ****** --port 8080'],
    ['server --password hunter2 -v', 'server --password ****** -v'],
    ['server --passwd hunter2', 'server --passwd ******'],
    ['server --api-key abc', 'server --api-key ******'],
    ['server --apikey abc', 'server --apikey ******'],
    ['server --secret abc', 'server --secret ******'],
    ['server --access-key abc', 'server --access-key ******'],
    ['server --auth abc', 'server --auth ******'],
    [["hf_abcde", "fghijklm", "nopqrstu", "vwxyz012", "3456789"].join(''), 'hf_******'],
    // Stripe's documented example key and an all-hex Twilio-shaped key, assembled at
    // runtime for the same reason as the Slack webhook above.
    [`sk_live_${["4eC39HqL", "yjWDarjt", "T1zdp7dc"].join('')}`, 'sk_live_******'],
    [["rk_test_", "51Habc12", "3XYZ"].join(''), 'rk_test_******'],
    [["pk_live_", "abc123DE", "F456"].join(''), 'pk_live_******'],
    [`SK${["01234567", "89abcdef", "01234567", "89abcdef"].join('')}`, 'SK******'],
    [["glpat-xx", "xxxxxxxx", "xxxxxxxx", "xx"].join(''), 'glpat-******'],
    [["npm_abcd", "efghijkl", "mnopqrst", "uvwx0123"].join(''), 'npm_******'],
    [["dop_v1_0", "12345678", "9abcdef0", "12345678", "9abcdef"].join(''), 'dop_v1_******'],
    [["xai-abcd", "efghijkl", "mnopqrst", "uvwxyz01", "2345"].join(''), 'xai-******'],
    [["ASIAIOSF", "ODNN7EXA", "MPLE"].join(''), 'ASIA******'],
    [["aws_secr", "et_acces", "s_key = ", "wJalrXUt", "nFEMI/K7", "MDENG/bP", "xRfiCYEX", "AMPLEKEY"].join(''), 'aws_secret_access_key = ******'],
    [["key wJal", "rXUtnFEM", "I/K7MDEN", "G/bPxRfi", "CYEXAMPL", "EKEY end"].join(''), 'key ****** end'],
    [["x Ab3dEf", "6hIj9kLm", "2nOp5q e", "nd"].join(''), 'x ****** end'],
  ])('%s → %s', (input, expected) => {
    expect(redactSecretsInString(input)).toBe(expected);
  });

  it.each([
    ["bash ~/.", "claude/h", "ooks/das", "hboard-h", "ook.sh"].join(''),
    ["/Users/m", "e/Docume", "nts/Code", "x/2026-0", "9-30/slu", "g"].join(''),
    'claude --model claude-opus-5-5 --effort high',
    'node dist/server.js --port 3333 --no-open',
    'Bash(npm run test:e2e)',
    'npm_config_registry=https://registry.npmjs.org',
  ])('leaves %s untouched', (input) => {
    expect(redactSecretsInString(input)).toBe(input);
  });
});

describe('flattenMasked — ids in rendered keys (security review L5)', () => {
  it('replaces UUIDs and long hex / id-like key segments with <id>', () => {
    const fields = flattenMasked({
      s1mAccessCache: { 'f47ac10b-58cc-4372-a567-0e02b2c3d479': { hasAccess: true } },
      passesEligibilityCache: { [["01234567", "89abcdef", "0123"].join('')]: { eligible: false } },
      orgs: { [["01HXYZ7K", "2M9Q4R6S", "8T0V2W4X", "6Y"].join('')]: 1, 'org:f47ac10b-58cc-4372-a567-0e02b2c3d479': 2 },
      features: { tengu_sonnet_4_5_launch: true, cachedStatsigGates: false },
      projects: { '/Users/k/work': { trust_level: 'trusted' } },
    }, { homeDirs: ['/Users/k'] });
    const keys = fields.map((f) => f.key);
    expect(keys).toEqual(expect.arrayContaining([
      's1mAccessCache.<id>.hasAccess', ["passesEl", "igibilit", "yCache.<", "id>.elig", "ible"].join(''), 'orgs.<id>', 'orgs["org:<id>"]',
      'features.tengu_sonnet_4_5_launch', 'features.cachedStatsigGates', 'projects["~/work"].trust_level',
    ]));
    expect(JSON.stringify(fields)).not.toMatch(/f47ac10b|0123456789abcdef0123|01HXYZ7K2M9Q4R6S8T0V2W4X6Y/);
  });
});

describe('redactText — whole bodies, line by line (security review M2b)', () => {
  it('masks secrets anywhere in a multi-line body and leaves every other line intact', () => {
    const body = [
      '# Notes', '', ["The key ", "is sk-an", "t-api03-", "abcdefgh", "ijklmnop", "."].join(''), ["export O", "PENAI_AP", "I_KEY=sk", "-proj-ab", "cdefghij", "k"].join(''),
      'password: hunter2', '  "apiKey": "plainvalue123",', 'Keywords: alpha, beta', 'Nothing secret here.',
    ].join('\n');
    expect(redactText(body)).toBe([
      '# Notes', '', 'The key is sk-ant-******.', 'export OPENAI_API_KEY=******',
      'password: ******', '  "apiKey": "******",', 'Keywords: alpha, beta', 'Nothing secret here.',
    ].join('\n'));
  });

  it('masks a whole PRIVATE KEY block, keeping its markers and line count', () => {
    const pem = ['key:', '-----BEGIN RSA PRIVATE KEY-----', ["MIIEowIB", "AAKCAQEA", "1b2C3d4"].join(''), ["  q1W2e3", "R4t5/Y6u", "7I8o9P0/", "+/+abc"].join(''), '-----END RSA PRIVATE KEY-----', 'after'];
    expect(redactText(pem.join('\r\n'))).toBe(
      ['key:', '-----BEGIN RSA PRIVATE KEY-----', MASK, `  ${MASK}`, '-----END RSA PRIVATE KEY-----', 'after'].join('\r\n'),
    );
  });

  it('masks an escaped one-line PEM (a service-account JSON) and a block that never closes', () => {
    const json = '{"private_key": "-----BEGIN PRIVATE KEY-----\\nMIIEvQIBADANBg\\nkqhkiG9w0BAQE\\n-----END PRIVATE KEY-----\\n", "x": 1}';
    expect(redactText(json)).not.toMatch(/MIIEvQIBADANBg|kqhkiG9w0BAQE/);
    const open = redactText(["-----BEG", "IN OPENS", "SH PRIVA", "TE KEY--", "---\nb3Bl", "bnNzaC1r", "ZXktdjEA", "AAAA\nAAA", "AC3NzaC1", "lZDI1NTE", "5AAAA"].join(''));
    expect(open).toBe(`-----BEGIN OPENSSH PRIVATE KEY-----\n${MASK}\n${MASK}`);
  });

  it('judges a patch line by its text, never by its +/-/space marker', () => {
    const patch = ['===', '--- ~/a', '+++ ~/b', '@@ -1,3 +1,3 @@', ' Token handling notes', ["-Key sk-", "ant-api0", "3-OLDabc", "defgh he", "re."].join(''), ["+Key sk-", "ant-api0", "3-NEWabc", "defgh he", "re."].join(''), '-password: hunter2'].join('\n');
    expect(redactPatch(patch)).toBe(['===', '--- ~/a', '+++ ~/b', '@@ -1,3 +1,3 @@', ' Token handling notes', '-Key sk-ant-****** here.', '+Key sk-ant-****** here.', '-password: ******'].join('\n'));
  });

  it('masks a long quoted secret value whole, and a long base64 run whatever its slashes (review follow-up)', () => {
    // Deterministic, realistic base64 (≈ one '/' per 64 characters), like a raw DER key.
    const der = Array.from({ length: 18 }, (_, i) => createHash('sha512').update(`k${i}`).digest('base64').replace(/=+$/, '')).join('');
    expect(der.split('/').length - 1).toBeGreaterThan(2);
    const out = redactText(`{"private_key": "${der}", "id": "x"}`);
    expect(out).toBe('{"private_key": "******", "id": "x"}');
    expect(redactText(`blob ${der} end`)).toBe('blob ****** end');
    expect(redactText(["see /Use", "rs/Me2/P", "rojects/", "Alpha/Be", "ta/Gamma", "/Delta/E", "psilon/Z", "eta/Eta/", "Theta/fi", "le.md"].join(''))).toContain('/Users/Me2/');
  });

  it('redacts frontmatter keys as well as values (review follow-up)', () => {
    const out = redactStrings({ 'https://deploy:Hunter2Secret@registry.example.com': 1, nested: { [GH_TOKEN]: 'v' } });
    expect(JSON.stringify(out)).not.toMatch(/Hunter2Secret|A1b2C3d4E5A1b2C3d4E5/);
  });

  it('has no 300-character cap, but cuts a line over the per-line cap and never shows a token in part', () => {
    expect(redactText('word '.repeat(1000))).toHaveLength(5000);
    const cut = redactText(`${'a '.repeat(4094)}Ab3dEf6hIj9kLm2nOp5qRs\nnext line`);
    const [first, second] = cut.split('\n');
    expect(first.length).toBeLessThanOrEqual(8193);
    expect(first.endsWith('…')).toBe(true);
    expect(first).not.toContain('Ab3d');
    expect(second).toBe('next line');
  });

  it.each([
    'a-', 'eyJ-', 'eyJa.', 'sk-', 'x://', 'https://a/', '--token ', 'x="', "a='", 'Authorization: ', 'Cookie: ',
    '1234567890:', 'A1b/', '//@', '-----BEGIN RSA PRIVATE KEY-----', 'key: ', 'hf_', 'k=v&', '%2F', 'a://?', 'a://&',
    'k: "', "k: '", '--token "',
  ])('stays linear on 512 KB (the file cap) of hostile %j lines', (unit) => {
    // Every line sits at the per-line cap, where one quadratic pattern costs
    // ~0.6 s here (the old `\beyJ…` JWT rule measured 574 ms); every pattern
    // today runs in ~10-30 ms. The budget sits between the two.
    const line = unit.repeat(Math.ceil(8192 / unit.length)).slice(0, 8192);
    const body = Array.from({ length: 64 }, () => line).join('\n');
    const started = Date.now();
    const out = redactText(body);
    expect(Date.now() - started).toBeLessThan(250);
    expect(out.split('\n')).toHaveLength(64);
  });
});
