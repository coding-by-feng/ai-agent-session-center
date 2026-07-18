// test/externalDiscovery.test.ts — process-scan filters for external-session discovery
// Fixtures are REAL `ps -o args=` lines observed on the dev machine (20 interactive
// sessions amid ~40 infra processes) so the noise filter is validated against the
// exact strings it must accept/reject.
import { describe, it, expect } from 'vitest';
import {
  isInteractiveClaude,
  parseNameFlag,
  parseModelFlag,
} from '../server/processMonitor.js';

describe('external-session discovery — isInteractiveClaude', () => {
  const interactive = [
    'claude --model opus --effort xhigh --resume 9560ecb4 --fork-session --dangerously-skip-permissions -n Fork of PM',
    'claude -n agent-manager #2 --resume e8c675be',
    'claude --model claude-opus-4-8 --effort xhigh --resume 9560ecb4',
    'claude --model opus --effort xhigh --dangerously-skip-permissions -n AASC Fix',
    'claude --model fable --effort xhigh --dangerously-skip-permissions -n Clone of KTS --resume 8319d793',
    '/usr/local/bin/claude --model opus -n Home Project',
  ];
  for (const args of interactive) {
    it(`accepts interactive: ${args.slice(0, 40)}…`, () => {
      expect(isInteractiveClaude(args)).toBe(true);
    });
  }

  const infra = [
    '/Users/kasonzhan/.local/bin/claude daemon run --json-path /Users/kasonzhan/.claude/daemon.json',
    'claude bg-pty-host --bg-pty-host /tmp/cc-daemon-501/bf66733d/spare/509aae37.pty.sock 200 50',
    'claude bg-spare --bg-spare /tmp/cc-daemon-501/bf66733d/spare/509aae37.claim.sock',
    '/Users/kasonzhan/.local/bin/claude --output-format stream-json --verbose --input-format stream-json --model claude-sonnet-4-6 --resume a28efed5',
    'bun /Users/kasonzhan/.claude/plugins/cache/thedotmack/claude-mem/12.3.8/scripts/mcp-server.cjs',
    'script -q e2e.txt env CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=1 zsh -l',
  ];
  for (const args of infra) {
    it(`rejects infra/non-interactive: ${args.slice(0, 40)}…`, () => {
      expect(isInteractiveClaude(args)).toBe(false);
    });
  }
});

describe('external-session discovery — parseNameFlag', () => {
  it('parses a simple name', () => {
    expect(parseNameFlag('claude --model opus -n Victor --resume x')).toBe('Victor');
  });
  it('parses a multi-word name up to the next flag', () => {
    expect(parseNameFlag('claude -n Clone of KTS --resume 6c30be09')).toBe('Clone of KTS');
  });
  it('parses a name containing "#" with no trailing flag', () => {
    expect(parseNameFlag('claude -n agent-manager #2')).toBe('agent-manager #2');
  });
  it('parses a name that runs to end of string', () => {
    expect(parseNameFlag('claude --model opus --dangerously-skip-permissions -n AASC Fix')).toBe('AASC Fix');
  });
  it('returns null when there is no -n flag', () => {
    expect(parseNameFlag('claude --model opus --resume abc')).toBeNull();
  });
});

describe('external-session discovery — parseModelFlag', () => {
  it('extracts the model id', () => {
    expect(parseModelFlag('claude --model claude-opus-4-8 --effort xhigh')).toBe('claude-opus-4-8');
  });
  it('extracts a short alias', () => {
    expect(parseModelFlag('claude --model fable -n Foo')).toBe('fable');
  });
  it('returns null when no --model flag', () => {
    expect(parseModelFlag('claude -n Foo --resume abc')).toBeNull();
  });
});
