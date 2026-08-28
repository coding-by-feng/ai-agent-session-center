import { describe, it, expect } from 'vitest';
import { isInternalAppUrl } from '../electron/internalUrl.js';

const PORT = '3333';

describe('isInternalAppUrl', () => {
  describe('our own origin — must open as a native window', () => {
    it.each([
      ['http://localhost:3333/', 'bare root'],
      ['http://localhost:3333/project-browser?path=%2FUsers%2Fk%2Fp', 'project browser route'],
      ['http://127.0.0.1:3333/?popout=project&path=%2Ftmp', 'loopback IP form'],
      ['http://localhost:3333/a?b=1#frag', 'query + fragment'],
    ])('%s (%s)', (url) => {
      expect(isInternalAppUrl(url, PORT)).toBe(true);
    });

    it('accepts a numeric port argument as well as a string', () => {
      expect(isInternalAppUrl('http://localhost:3333/x', 3333 as unknown as string)).toBe(true);
    });

    it('matches the dev port when that is what the app is serving', () => {
      expect(isInternalAppUrl('http://localhost:3332/x', '3332')).toBe(true);
      expect(isInternalAppUrl('http://localhost:3333/x', '3332')).toBe(false);
    });
  });

  describe('not ours — must keep going to the system browser', () => {
    it('rejects a different localhost port (the user’s own dev server)', () => {
      expect(isInternalAppUrl('http://localhost:3000', PORT)).toBe(false);
      expect(isInternalAppUrl('http://127.0.0.1:8080/x', PORT)).toBe(false);
    });

    it('rejects a bare localhost with no explicit port', () => {
      expect(isInternalAppUrl('http://localhost/', PORT)).toBe(false);
    });

    it('rejects external hosts even on our port number', () => {
      expect(isInternalAppUrl('http://evil.example.com:3333/', PORT)).toBe(false);
      expect(isInternalAppUrl('https://github.com/anthropics/claude-code', PORT)).toBe(false);
    });

    it('rejects a host that merely ends in localhost', () => {
      expect(isInternalAppUrl('http://notlocalhost:3333/', PORT)).toBe(false);
      expect(isInternalAppUrl('http://localhost.evil.com:3333/', PORT)).toBe(false);
    });

    it('rejects non-http protocols (file:, ms-msdt:, javascript:)', () => {
      expect(isInternalAppUrl('file:///etc/passwd', PORT)).toBe(false);
      expect(isInternalAppUrl('ms-msdt:/id', PORT)).toBe(false);
      expect(isInternalAppUrl('javascript:alert(1)', PORT)).toBe(false);
    });

    it('rejects malformed input instead of throwing', () => {
      expect(isInternalAppUrl('', PORT)).toBe(false);
      expect(isInternalAppUrl('not a url', PORT)).toBe(false);
      expect(isInternalAppUrl('/project-browser?path=/x', PORT)).toBe(false);
    });
  });
});
