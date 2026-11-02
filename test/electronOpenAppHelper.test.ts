// electronOpenAppHelper.test.ts — the DMG's "Open App" helper names and unlocks whichever edition it ships beside.
// osascript is a stub that records the first dialog and answers Quit, so nothing real is unlocked or opened.
import { describe, it, expect } from 'vitest';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const helper = join(process.cwd(), 'scripts/Open App (Start Here).command');

function firstDialog(appBeside?: string): string {
  const root = mkdtempSync(join(tmpdir(), 'open-app-'));
  try {
    const bin = join(root, 'bin');
    const volume = join(root, 'volume');
    mkdirSync(bin);
    mkdirSync(volume);
    if (appBeside) mkdirSync(join(volume, `${appBeside}.app`));
    const log = join(root, 'dialogs.txt');
    writeFileSync(join(bin, 'osascript'), `#!/bin/bash\ncat >> "${log}"\necho Quit\n`);
    chmodSync(join(bin, 'osascript'), 0o755);
    const script = join(volume, 'helper.command');
    copyFileSync(helper, script);
    const result = spawnSync('/bin/bash', [script], {
      encoding: 'utf8',
      env: { PATH: `${bin}:/usr/bin:/bin`, HOME: root },
    });
    expect(result.status, result.stderr).toBe(0);
    return existsSync(log) ? readFileSync(log, 'utf8') : '';
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe.skipIf(process.platform === 'win32')('Open App (Start Here).command', () => {
  it('names Lite in the Lite DMG', () => {
    expect(firstDialog('AI Agent Session Center Lite')).toContain('Welcome to AI Agent Session Center Lite!');
  });

  it('names Full in the Full DMG', () => {
    expect(firstDialog('AI Agent Session Center')).toContain('Welcome to AI Agent Session Center!');
  });

  it('ignores any other app, so a copy in /Applications never unlocks and opens that one', () => {
    expect(firstDialog('1Password')).toContain('Welcome to AI Agent Session Center!');
  });

  it('falls back to the Full name once it has been copied away from the DMG', () => {
    expect(firstDialog()).toContain('Welcome to AI Agent Session Center!');
  });
});
