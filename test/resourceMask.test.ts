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
} from '../server/resourceMask.js';
import type { ResourceField } from '../src/types/resources.js';

const field = (fields: ResourceField[], key: string) => fields.find((f) => f.key === key);
const GH_TOKEN = `ghp_${'A1b2C3d4E5'.repeat(4)}`; // 44 chars — a real-looking PAT
// Synthetic token shapes assembled at runtime so source scanners do not mistake
// masking fixtures for issued credentials. Keep the full formats for coverage.
const TELEGRAM_TOKEN = `${'123456789'}:${'A'.repeat(35)}`;
const AWS_TEMP_ACCESS_KEY_ID = `ASIA${'EXAMPLE0'.repeat(2)}`;
const ANTHROPIC_TOKEN = `sk-ant-api03-${'a'.repeat(16)}`;
const OPENAI_TOKEN = `sk-proj-${'b'.repeat(11)}`;
const FINE_GH_TOKEN = `github_pat_${'1'.repeat(21)}_${'c'.repeat(10)}`;
const SLACK_TOKEN = `xoxb-${'1'.repeat(10)}-${'d'.repeat(10)}`;
const AWS_ACCESS_KEY_ID = `AKIA${'EXAMPLE0'.repeat(2)}`;
const GOOGLE_TOKEN = `AIza${'x'.repeat(35)}`;
const JWT_TOKEN = [`${'eyJ'}${'a'.repeat(17)}`, `${'eyJ'}${'b'.repeat(14)}`, 'c'.repeat(16)].join('.');
const HF_TOKEN = `hf_${'e'.repeat(36)}`;
const STRIPE_SECRET = `sk_live_${'f'.repeat(24)}`;
const STRIPE_RESTRICTED = `rk_test_${'g'.repeat(14)}`;
const STRIPE_PUBLIC = `pk_live_${'h'.repeat(15)}`;
const TWILIO_TOKEN = `SK${'0123456789abcdef'.repeat(2)}`;
const GITLAB_TOKEN = `glpat-${'x'.repeat(20)}`;
const NPM_TOKEN = `npm_${'j'.repeat(28)}`;
const DO_TOKEN = `dop_v1_${'0123456789abcdef'.repeat(2)}`;
const XAI_TOKEN = `xai-${'k'.repeat(32)}`;
const AWS_SECRET = `${'example/'.repeat(4)}EXAMPLE0`;
const OPAQUE_TOKEN = 'Ab3dEf6hIj'.repeat(2);
const PASSWORD = ['synthetic', 'password'].join('-');
const BASIC_AUTH = Buffer.from('synthetic-user:synthetic-password').toString('base64');
const BEARER_TOKEN = ['synthetic', 'bearer-token'].join('.');
const ARGS_TOKEN = 'abcdefghijklmnop'.repeat(2);
const ANTHROPIC_NEW_TOKEN = `sk-ant-api03-${'b'.repeat(16)}`;
const GENERIC_SECRET = ['synthetic', 'secret'].join('-');
const PASSWORD_HASH = ['scrypt', 'synthetic-salt', 'synthetic-hash'].join('$');

describe('flattenMasked — deny rules', () => {
  it('never lets an env value out, whatever its type', () => {
    const fields = flattenMasked({
      env: { ANTHROPIC_API_KEY: ANTHROPIC_TOKEN, PLAIN: 'hello-plain-value', PORT: 8080, ON: true },
    });
    const out = JSON.stringify(fields);
    expect(out).not.toContain(ANTHROPIC_TOKEN);
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
      headers: { Authorization: `Bearer ${BEARER_TOKEN}`, 'X-Team': 'team-value-1' },
      http_headers: { 'X-Api': GENERIC_SECRET },
    });
    const out = JSON.stringify(fields);
    expect(out).not.toContain(BEARER_TOKEN);
    expect(out).not.toContain(GENERIC_SECRET);
    expect(out).not.toContain('team-value-1');
    expect(field(fields, 'headers.Authorization')?.masked).toBe(true);
    expect(field(fields, 'url')).toMatchObject({ value: 'https://mcp.example.com/mcp', masked: false });
  });

  it('masks passwordHash, apiKey, and everything under oauthAccount', () => {
    const fields = flattenMasked({
      passwordHash: PASSWORD_HASH,
      apiKey: GENERIC_SECRET,
      primaryApiKey: ARGS_TOKEN,
      oauthAccount: { emailAddress: 'me@example.com', accountUuid: 'uuid-1', hasExtraUsageEnabled: true },
    });
    const out = JSON.stringify(fields);
    for (const secret of [PASSWORD_HASH, GENERIC_SECRET, ARGS_TOKEN, 'me@example.com', 'uuid-1']) {
      expect(out).not.toContain(secret);
    }
    expect(field(fields, 'oauthAccount.hasExtraUsageEnabled')).toMatchObject({ masked: true, kind: 'boolean' });
  });

  it('deny wins over the allowlist (statusLine.* is allowed, statusLine.token is not)', () => {
    const fields = flattenMasked({ statusLine: { type: 'command', token: GENERIC_SECRET } });
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
    expect(field(fields, 'alwaysThinkingEnabled')).toEqual({
      key: 'alwaysThinkingEnabled', value: 'true', masked: false, kind: 'boolean',
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
    const fields = flattenMasked({ type: 'sse', url: `https://mcp.example.com/sse?token=${GENERIC_SECRET}&mode=x` });
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

describe('redactSecretsInString', () => {
  it.each([
    [ANTHROPIC_TOKEN, 'sk-ant-******'],
    [`key ${OPENAI_TOKEN}`, 'key sk-******'],
    [`gh ${GH_TOKEN}`, 'gh ghp_******'],
    [FINE_GH_TOKEN, 'github_pat_******'],
    [SLACK_TOKEN, 'xoxb-******'],
    [AWS_ACCESS_KEY_ID, 'AKIA******'],
    [GOOGLE_TOKEN, 'AIza******'],
    [`jwt ${JWT_TOKEN}`, 'jwt ******'],
    [`Authorization: Bearer ${BEARER_TOKEN}`, 'Authorization: Bearer ******'],
    [`https://user:${PASSWORD}@example.com/x`, 'https://******@example.com/x'],
    [`https://example.com/a?token=${GENERIC_SECRET}&x=1#top`, 'https://example.com/a?token=******&x=******#top'],
    [`API_KEY=${GENERIC_SECRET} node server.js`, 'API_KEY=****** node server.js'],
    [`--db-password=${PASSWORD}`, '--db-password=******'],
    [`id ${'a'.repeat(45)} end`, 'id ****** end'],
  ])('%s → %s', (input, expected) => {
    expect(redactSecretsInString(input)).toBe(expected);
  });

  it('leaves ordinary text alone', () => {
    expect(redactSecretsInString('npx -y @modelcontextprotocol/server-github')).toBe(
      'npx -y @modelcontextprotocol/server-github',
    );
    expect(redactSecretsInString('bash ~/.claude/hooks/dashboard-hook.sh')).toBe('bash ~/.claude/hooks/dashboard-hook.sh');
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
      args: ['--api-key', ARGS_TOKEN, '--port', '8080', '-t', 'short', '--password', PASSWORD],
    });
    expect(field(fields, 'args[1]')).toMatchObject({ value: MASK, masked: true });
    expect(field(fields, 'args[3]')?.value).toBe('8080');
    expect(field(fields, 'args[5]')?.value).toBe('short');
    expect(field(fields, 'args[7]')).toMatchObject({ value: MASK, masked: true });
    expect(JSON.stringify(fields)).not.toContain(ARGS_TOKEN);
  });

  it.each([
    [`curl -H "Authorization: Basic ${BASIC_AUTH}" x`, 'curl -H "Authorization: Basic ******" x'],
    [`curl -H "X-Api-Key: ${GENERIC_SECRET}" x`, 'curl -H "X-Api-Key: ******" x'],
    [`curl -u admin:${PASSWORD} https://x`, 'curl -u ****** https://x'],
    // Assembled at runtime (like GH_TOKEN above): GitHub push protection matches on
    // format, and this placeholder is deliberately shaped like a real webhook URL.
    [`https://hooks.slack.com/services/T0123ABCD/B0456EFGH/${'aBcD'.repeat(6)}`,
      'https://hooks.slack.com/services/T0123ABCD/B0456EFGH/******'],
  ])('%s → %s', (input, expected) => {
    expect(redactSecretsInString(input)).toBe(expected);
  });
});

describe('redactSecretsInString — more token shapes (security review M4)', () => {
  it.each([
    [`curl https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`,
      'curl https://api.telegram.org/bot******/sendMessage'],
    [`notify ${TELEGRAM_TOKEN} done`, 'notify ****** done'],
    [`curl -H "PRIVATE-TOKEN: ${GENERIC_SECRET}" x`, 'curl -H "PRIVATE-TOKEN: ******" x'],
    [`curl -H "X-Api-Key: ${GENERIC_SECRET}" x`, 'curl -H "X-Api-Key: ******" x'],
    [`curl -H "X-Auth-Token: ${GENERIC_SECRET}" x`, 'curl -H "X-Auth-Token: ******" x'],
    [`curl -H "Cookie: session=${GENERIC_SECRET}; theme=dark" x`, 'curl -H "Cookie: ******" x'],
    [`curl -H "Set-Cookie: sid=${GENERIC_SECRET}; Path=/" x`, 'curl -H "Set-Cookie: ******" x'],
    [`server --token ${GENERIC_SECRET} --port 8080`, 'server --token ****** --port 8080'],
    [`server --password ${PASSWORD} -v`, 'server --password ****** -v'],
    [`server --passwd ${PASSWORD}`, 'server --passwd ******'],
    [`server --api-key ${GENERIC_SECRET}`, 'server --api-key ******'],
    [`server --apikey ${GENERIC_SECRET}`, 'server --apikey ******'],
    [`server --secret ${GENERIC_SECRET}`, 'server --secret ******'],
    [`server --access-key ${GENERIC_SECRET}`, 'server --access-key ******'],
    [`server --auth ${GENERIC_SECRET}`, 'server --auth ******'],
    [HF_TOKEN, 'hf_******'],
    // Stripe and Twilio fixtures retain their provider formats at runtime.
    [STRIPE_SECRET, 'sk_live_******'],
    [STRIPE_RESTRICTED, 'rk_test_******'],
    [STRIPE_PUBLIC, 'pk_live_******'],
    [TWILIO_TOKEN, 'SK******'],
    [GITLAB_TOKEN, 'glpat-******'],
    [NPM_TOKEN, 'npm_******'],
    [DO_TOKEN, 'dop_v1_******'],
    [XAI_TOKEN, 'xai-******'],
    [AWS_TEMP_ACCESS_KEY_ID, 'ASIA******'],
    [`aws_secret_access_key = ${AWS_SECRET}`, 'aws_secret_access_key = ******'],
    [`key ${AWS_SECRET} end`, 'key ****** end'],
    [`x ${OPAQUE_TOKEN} end`, 'x ****** end'],
  ])('%s → %s', (input, expected) => {
    expect(redactSecretsInString(input)).toBe(expected);
  });

  it.each([
    'bash ~/.claude/hooks/dashboard-hook.sh',
    '/Users/me/Documents/Codex/2026-09-30/slug',
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
      passesEligibilityCache: { '0123456789abcdef0123': { eligible: false } },
      orgs: { '01HXYZ7K2M9Q4R6S8T0V2W4X6Y': 1, 'org:f47ac10b-58cc-4372-a567-0e02b2c3d479': 2 },
      features: { tengu_sonnet_4_5_launch: true, cachedStatsigGates: false },
      projects: { '/Users/k/work': { trust_level: 'trusted' } },
    }, { homeDirs: ['/Users/k'] });
    const keys = fields.map((f) => f.key);
    expect(keys).toEqual(expect.arrayContaining([
      's1mAccessCache.<id>.hasAccess', 'passesEligibilityCache.<id>.eligible', 'orgs.<id>', 'orgs["org:<id>"]',
      'features.tengu_sonnet_4_5_launch', 'features.cachedStatsigGates', 'projects["~/work"].trust_level',
    ]));
    expect(JSON.stringify(fields)).not.toMatch(/f47ac10b|0123456789abcdef0123|01HXYZ7K2M9Q4R6S8T0V2W4X6Y/);
  });
});

describe('redactText — whole bodies, line by line (security review M2b)', () => {
  it('masks secrets anywhere in a multi-line body and leaves every other line intact', () => {
    const body = [
      '# Notes', '', `The key is ${ANTHROPIC_TOKEN}.`, `export OPENAI_API_KEY=${OPENAI_TOKEN}`,
      `password: ${PASSWORD}`, `  "apiKey": "${GENERIC_SECRET}",`, 'Keywords: alpha, beta', 'Nothing secret here.',
    ].join('\n');
    expect(redactText(body)).toBe([
      '# Notes', '', 'The key is sk-ant-******.', 'export OPENAI_API_KEY=******',
      'password: ******', '  "apiKey": "******",', 'Keywords: alpha, beta', 'Nothing secret here.',
    ].join('\n'));
  });

  it('masks a whole PRIVATE KEY block, keeping its markers and line count', () => {
    const pem = ['key:', '-----BEGIN RSA PRIVATE KEY-----', 'A'.repeat(23), `  ${'b/'.repeat(14)}`, '-----END RSA PRIVATE KEY-----', 'after'];
    expect(redactText(pem.join('\r\n'))).toBe(
      ['key:', '-----BEGIN RSA PRIVATE KEY-----', MASK, `  ${MASK}`, '-----END RSA PRIVATE KEY-----', 'after'].join('\r\n'),
    );
  });

  it('masks an escaped one-line PEM (a service-account JSON) and a block that never closes', () => {
    const pemLines = ['-----BEGIN PRIVATE KEY-----', 'A'.repeat(14), 'b'.repeat(12), '-----END PRIVATE KEY-----', ''];
    const json = JSON.stringify({ private_key: pemLines.join('\n'), x: 1 });
    expect(redactText(json)).not.toContain(pemLines[1]);
    expect(redactText(json)).not.toContain(pemLines[2]);
    const open = redactText(`-----BEGIN OPENSSH PRIVATE KEY-----\n${'c'.repeat(24)}\n${'d'.repeat(24)}`);
    expect(open).toBe(`-----BEGIN OPENSSH PRIVATE KEY-----\n${MASK}\n${MASK}`);
  });

  it('judges a patch line by its text, never by its +/-/space marker', () => {
    const patch = ['===', '--- ~/a', '+++ ~/b', '@@ -1,3 +1,3 @@', ' Token handling notes', `-Key ${ANTHROPIC_TOKEN} here.`, `+Key ${ANTHROPIC_NEW_TOKEN} here.`, `-password: ${PASSWORD}`].join('\n');
    expect(redactPatch(patch)).toBe(['===', '--- ~/a', '+++ ~/b', '@@ -1,3 +1,3 @@', ' Token handling notes', '-Key sk-ant-****** here.', '+Key sk-ant-****** here.', '-password: ******'].join('\n'));
  });

  it('masks a long quoted secret value whole, and a long base64 run whatever its slashes (review follow-up)', () => {
    // Deterministic, realistic base64 (≈ one '/' per 64 characters), like a raw DER key.
    const der = Array.from({ length: 18 }, (_, i) => createHash('sha512').update(`k${i}`).digest('base64').replace(/=+$/, '')).join('');
    expect(der.split('/').length - 1).toBeGreaterThan(2);
    const out = redactText(`{"private_key": "${der}", "id": "x"}`);
    expect(out).toBe('{"private_key": "******", "id": "x"}');
    expect(redactText(`blob ${der} end`)).toBe('blob ****** end');
    expect(redactText('see /Users/Me2/Projects/Alpha/Beta/Gamma/Delta/Epsilon/Zeta/Eta/Theta/file.md')).toContain('/Users/Me2/');
  });

  it('redacts frontmatter keys as well as values (review follow-up)', () => {
    const out = redactStrings({ [`https://deploy:${PASSWORD}@registry.example.com`]: 1, nested: { [GH_TOKEN]: 'v' } });
    expect(JSON.stringify(out)).not.toContain(PASSWORD);
    expect(JSON.stringify(out)).not.toContain(GH_TOKEN);
  });

  it('has no 300-character cap, but cuts a line over the per-line cap and never shows a token in part', () => {
    expect(redactText('word '.repeat(1000))).toHaveLength(5000);
    const cut = redactText(`${'a '.repeat(4094)}${OPAQUE_TOKEN}Rs\nnext line`);
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
