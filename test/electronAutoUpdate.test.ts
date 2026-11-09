import { describe, it, expect } from 'vitest';
import {
  updateChannel,
  updaterSupported,
  testFeedUrl,
  parseUpdatePrefs,
  serializeUpdatePrefs,
  restartPrompt,
  updaterCacheDirName,
  updatePrefsFile,
  updateConfigYaml,
} from '../electron/autoUpdateRules';

describe('Mac auto-update rules', () => {
  it('reads latest-mac.yml for Full and lite-mac.yml for Lite', () => {
    expect(updateChannel('full')).toBe('latest');
    expect(updateChannel('lite')).toBe('lite');
  });

  it('runs only in a packaged Apple-silicon Mac app', () => {
    expect(updaterSupported(true, 'darwin', 'arm64')).toBe(true);
    expect(updaterSupported(false, 'darwin', 'arm64')).toBe(false);
    expect(updaterSupported(true, 'darwin', 'x64')).toBe(false);
    expect(updaterSupported(true, 'win32', 'x64')).toBe(false);
    expect(updaterSupported(true, 'linux', 'x64')).toBe(false);
  });

  it('keeps Full and Lite apart: own download cache, own setting', () => {
    expect(updaterCacheDirName('full')).not.toBe(updaterCacheDirName('lite'));
    expect(updatePrefsFile('full')).not.toBe(updatePrefsFile('lite'));
    expect(updateConfigYaml('lite')).toContain('updaterCacheDirName: ai-agent-session-center-lite-updater\n');
    expect(updateConfigYaml('full')).toContain('owner: coding-by-feng\nrepo: ai-agent-session-center\n');
  });

  it('accepts a test feed only on a loopback address', () => {
    expect(testFeedUrl({})).toBeNull();
    expect(testFeedUrl({ AASC_UPDATE_FEED_URL: 'http://127.0.0.1:8123/' })).toBe('http://127.0.0.1:8123/');
    expect(testFeedUrl({ AASC_UPDATE_FEED_URL: 'http://localhost:9/feed' })).toBe('http://localhost:9/feed');
    expect(testFeedUrl({ AASC_UPDATE_FEED_URL: 'https://evil.example/' })).toBeNull();
    expect(testFeedUrl({ AASC_UPDATE_FEED_URL: 'http://127.0.0.1.evil.example/' })).toBeNull();
    expect(testFeedUrl({ AASC_UPDATE_FEED_URL: 'file:///tmp/x' })).toBeNull();
    expect(testFeedUrl({ AASC_UPDATE_FEED_URL: 'not a url' })).toBeNull();
  });

  it('checks in the background unless turned off', () => {
    expect(parseUpdatePrefs(null)).toEqual({ autoCheck: true });
    expect(parseUpdatePrefs('{broken')).toEqual({ autoCheck: true });
    expect(parseUpdatePrefs('{}')).toEqual({ autoCheck: true });
    expect(parseUpdatePrefs('{"autoCheck":false}')).toEqual({ autoCheck: false });
    expect(parseUpdatePrefs(serializeUpdatePrefs({ autoCheck: false }))).toEqual({ autoCheck: false });
  });

  it('warns that restarting closes running terminals', () => {
    const { message, detail } = restartPrompt('AI Agent Session Center', '2.10.75');
    expect(message).toContain('2.10.75');
    expect(detail).toMatch(/terminal will close/);
    expect(detail).toMatch(/next time you quit/);
  });
});
