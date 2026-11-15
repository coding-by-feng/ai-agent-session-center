import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, statSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  readVoiceSettings, saveVoiceSettings, publicVoiceSettings, DEFAULT_VOICE,
} from '../../server/voice/voiceSettings.js';

const KEY = 'sk-proj-abcdefghijklmnopqrstuvwxyz0123';

describe('voice settings file', () => {
  let dir: string;
  let file: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'aasc-voice-'));
    file = join(dir, 'nested', 'voice.json');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('reads defaults when there is no file', () => {
    expect(readVoiceSettings(file)).toEqual({ apiKey: null, voice: DEFAULT_VOICE, brainCentralId: null });
  });

  it('reads defaults from a broken file', () => {
    saveVoiceSettings({ voice: 'cedar' }, file);
    writeFileSync(file, '{not json');
    expect(readVoiceSettings(file).voice).toBe(DEFAULT_VOICE);
  });

  it('saves a patch atomically, owner-only, keeping the fields it does not name', () => {
    saveVoiceSettings({ apiKey: KEY, voice: 'cedar' }, file);
    const after = saveVoiceSettings({ brainCentralId: 'c1' }, file);
    expect(after).toEqual({ apiKey: KEY, voice: 'cedar', brainCentralId: 'c1' });
    expect(readVoiceSettings(file)).toEqual(after);
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it('clears the key with null', () => {
    saveVoiceSettings({ apiKey: KEY }, file);
    expect(saveVoiceSettings({ apiKey: null }, file).apiKey).toBeNull();
    expect(readFileSync(file, 'utf8')).not.toContain(KEY);
  });

  it('ignores stored values of the wrong type', () => {
    saveVoiceSettings({}, file);
    writeFileSync(file, JSON.stringify({ apiKey: 42, voice: 'NOT A VOICE!', brainCentralId: {} }));
    expect(readVoiceSettings(file)).toEqual({ apiKey: null, voice: DEFAULT_VOICE, brainCentralId: null });
  });
});

describe('publicVoiceSettings', () => {
  it('never carries the key, only whether one is set and its last four characters', () => {
    const view = publicVoiceSettings({ apiKey: KEY, voice: 'marin', brainCentralId: null });
    expect(JSON.stringify(view)).not.toContain(KEY.slice(0, 20));
    expect(view).toEqual({ configured: true, keyHint: '…0123', voice: 'marin', brainCentralId: null });
  });

  it('says not configured without a key', () => {
    expect(publicVoiceSettings({ apiKey: null, voice: 'marin', brainCentralId: null }).configured).toBe(false);
  });
});
