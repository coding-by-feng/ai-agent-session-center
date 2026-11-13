import { describe, expect, it } from 'vitest';
import { execFileSync, spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';

// Run the hook's actual capture against a real long argv under a phone-width
// COLUMNS setting. Truncated launch flags must never become persisted commands.
describe.skipIf(process.platform === 'win32')('Claude startup command capture', () => {
  it('retains the last launch flag beyond the terminal width', () => {
    const marker = 'readiness-' + 'x'.repeat(180);
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)', '--', marker, '--continue']);
    try {
      const hook = readFileSync(new URL('../hooks/dashboard-hook.sh', import.meta.url), 'utf8');
      const capture = hook.split('\n').find(line => line.trimStart().startsWith('STARTUP_CMD=$(ps '));
      expect(capture).toBeTruthy();
      const command = capture!.replaceAll('$PPID', '$TEST_AGENT_PID') + '\nprintf "%s" "$STARTUP_CMD"';
      const actual = execFileSync('/bin/bash', ['-c', command], {
        env: { ...process.env, COLUMNS: '80', TEST_AGENT_PID: String(child.pid) }, encoding: 'utf8',
      });
      expect(actual).toContain(marker + ' --continue');
    } finally { child.kill(); }
  });
});
