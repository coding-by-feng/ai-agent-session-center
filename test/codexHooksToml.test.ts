// configureCodexHooksToml / removeAllCodexHooksToml: the dashboard's Codex hooks must never break the
// user's config.toml. Oct 29 2026: a config that already had its own top-level `notify` (Codex Computer
// Use) got a second `notify =` key, so Codex refused to load it ("duplicate key").
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { parse } from 'smol-toml';
import * as esm from '../hooks/install-hooks-core.js';

const cjs = createRequire(import.meta.url)('../hooks/install-hooks-core.cjs');

const SOURCE = 'ai-agent-session-center';
const PATTERN = 'dashboard-hook';
const COMMAND = '~/.codex/hooks/dashboard-hook.sh';
const EVENTS = ['SessionStart', 'Stop'];

const COMPUTER_USE = '/Users/me/.codex/computer-use/Client';
const FOREIGN_NOTIFY = `notify = ["${COMPUTER_USE}", "turn-ended"]`;
/** Computer Use installed after the dashboard: it chains our command inside its own notify. */
const CHAINED_NOTIFY =
  `notify = ["${COMPUTER_USE}", "turn-ended", "--previous-notify", "[\\"~\\\\/.codex\\\\/hooks\\\\/dashboard-hook.sh\\"]"]`;

const notifyKeys = (toml: string) => toml.split('\n').filter((l) => /^\s*notify\s*=/.test(l));

describe.each([
  ['esm', esm],
  ['cjs', cjs],
])('Codex hooks TOML (%s)', (_name, core) => {
  const configure = (toml: string) => core.configureCodexHooksToml(toml, EVENTS, COMMAND, PATTERN, SOURCE).toml as string;

  it('adds our notify and lifecycle hooks to a config without a notify', () => {
    const out = configure('model = "gpt"\n\n[projects."/x"]\ntrust_level = "trusted"\n');
    const parsed = parse(out) as Record<string, unknown>;
    expect(parsed.notify).toEqual([COMMAND]);
    expect(Object.keys(parsed.hooks as object)).toEqual(EVENTS);
  });

  it('keeps a foreign top-level notify and adds no second one', () => {
    const out = configure(`model = "gpt"\n${FOREIGN_NOTIFY}\n\n[projects."/x"]\ntrust_level = "trusted"\n`);
    expect(notifyKeys(out)).toEqual([FOREIGN_NOTIFY]);
    const parsed = parse(out) as Record<string, unknown>;
    expect(parsed.notify).toEqual([COMPUTER_USE, 'turn-ended']);
    expect(Object.keys(parsed.hooks as object)).toEqual(EVENTS);
  });

  it('repairs the broken form: a foreign notify plus ours becomes the foreign one alone', () => {
    const broken = [
      'model = "gpt"',
      FOREIGN_NOTIFY,
      '',
      `# [${SOURCE}] Dashboard hook -- safe to remove with "npm run reset"`,
      `notify = ["${COMMAND}"]`,
      '',
      '[projects."/x"]',
      'trust_level = "trusted"',
      '',
    ].join('\n');
    expect(() => parse(broken)).toThrow();
    const out = configure(broken);
    expect(notifyKeys(out)).toEqual([FOREIGN_NOTIFY]);
    expect(() => parse(out)).not.toThrow();
  });

  it('never deletes a foreign notify that merely chains our command', () => {
    const out = configure(`model = "gpt"\n${CHAINED_NOTIFY}\n\n[features]\nx = true\n`);
    expect(notifyKeys(out)).toEqual([CHAINED_NOTIFY]);
    expect(() => parse(out)).not.toThrow();
  });

  it('removeAllCodexHooksToml keeps a foreign notify that chains our command', () => {
    const { toml } = core.removeAllCodexHooksToml(`${CHAINED_NOTIFY}\n`, PATTERN, SOURCE);
    expect(notifyKeys(toml)).toEqual([CHAINED_NOTIFY]);
  });

  it('removeAllCodexHooksToml still removes our own notify', () => {
    const { toml, removed } = core.removeAllCodexHooksToml(`notify = ["${COMMAND}"]\nmodel = "gpt"\n`, PATTERN, SOURCE);
    expect(notifyKeys(toml)).toEqual([]);
    expect(removed).toBe(1);
  });

  it('is idempotent with a foreign notify', () => {
    const once = configure(`${FOREIGN_NOTIFY}\n\n[projects."/x"]\ntrust_level = "trusted"\n`);
    expect(configure(once)).toBe(once);
  });
});
