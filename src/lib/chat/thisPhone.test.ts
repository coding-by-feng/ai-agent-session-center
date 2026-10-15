// thisPhone.test.ts — the way from the Mac's page to the phone app's own settings (AASC-47).
import { describe, it, expect } from 'vitest';
import { nativeShellHomeUrl } from './thisPhone';

const IOS = 'Mozilla/5.0 (iPhone) AppleWebKit/605.1.15 Mobile/15E148 AASC-Mobile/1 (ios)';
const ANDROID = 'Mozilla/5.0 (Linux; Android 15) Chrome/130 Mobile AASC-Mobile/1 (android)';

describe('nativeShellHomeUrl', () => {
  it('opens the shell home without reopening the Mac', () => {
    expect(nativeShellHomeUrl(IOS)).toBe('capacitor://localhost/?tap=1');
    expect(nativeShellHomeUrl(ANDROID)).toBe('https://localhost/?tap=1');
  });

  it('is null in a phone browser', () => {
    expect(nativeShellHomeUrl('Mozilla/5.0 (iPhone) Safari/604.1')).toBeNull();
  });
});
