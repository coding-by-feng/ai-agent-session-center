// The toolbar 🎙 drives Claude Code / Codex voice inside AASC's PTYs. macOS charges their mic
// use to this app, and under the hardened runtime it records silence without this entitlement.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(__dirname, '..');

describe('desktop mic access for agent CLI voice', () => {
  it('Full and Lite sign with device.audio-input (app and inherited)', () => {
    const plist = readFileSync(join(root, 'electron/entitlements.mac.plist'), 'utf8');
    expect(plist).toMatch(/<key>com\.apple\.security\.device\.audio-input<\/key>\s*<true\/>/);
    const cfg = JSON.parse(readFileSync(join(root, 'electron-builder.json'), 'utf8'));
    expect(cfg.mac.hardenedRuntime).toBe(true);
    expect(cfg.mac.entitlementsInherit).toBe('electron/entitlements.mac.plist');
  });

  it('says why it wants the microphone', () => {
    const cfg = JSON.parse(readFileSync(join(root, 'electron-builder.json'), 'utf8'));
    expect(cfg.mac.extendInfo.NSMicrophoneUsageDescription).toMatch(/voice/i);
  });
});
