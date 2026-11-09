import { afterEach, describe, expect, it, vi } from 'vitest';
import { downloadUrl, readSaveFileOutcome, startDownload } from './phoneDownload';

const IOS_APP = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 AASC-Mobile/1.0.1+3';
const ANDROID_APP = 'Mozilla/5.0 (Linux; Android 14) Chrome/130 Mobile Safari/537.36 AASC-Mobile/1.0.1+3';
const SAFARI = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile Safari/604.1';

type W = { webkit?: unknown };

afterEach(() => {
  delete (window as unknown as W).webkit;
  vi.restoreAllMocks();
});

describe('downloadUrl', () => {
  it('asks the stream route for an attachment', () => {
    const url = new URL(downloadUrl('/p/root', 'a b/c.mp4'), 'http://mac');
    expect(url.pathname).toBe('/api/files/stream');
    expect(Object.fromEntries(url.searchParams)).toEqual({ root: '/p/root', path: 'a b/c.mp4', download: '1' });
  });
});

describe('startDownload', () => {
  it('posts to the iOS app when its handler is there', () => {
    const postMessage = vi.fn();
    (window as unknown as W).webkit = { messageHandlers: { aascSaveFile: { postMessage } } };
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click');
    expect(startDownload('/api/x', 'v.mp4', 'id1', IOS_APP)).toBe('native');
    expect(postMessage).toHaveBeenCalledWith({ id: 'id1', url: '/api/x', name: 'v.mp4' });
    expect(click).not.toHaveBeenCalled();
  });

  it('never clicks a link in an older iOS app (it would play the file in place of the page)', () => {
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click');
    expect(startDownload('/api/x', 'v.mp4', 'id1', IOS_APP)).toBe('unsupported');
    expect(click).not.toHaveBeenCalled();
  });

  it.each([['Android app', ANDROID_APP], ['Safari', SAFARI]])('clicks a download link in %s', (_label, ua) => {
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    expect(startDownload('/api/x', 'v.mp4', 'id1', ua)).toBe('browser');
    expect(click).toHaveBeenCalledTimes(1);
    const seen = click.mock.contexts[0] as HTMLAnchorElement;
    expect(seen.getAttribute('href')).toBe('/api/x');
    expect(seen.download).toBe('v.mp4');
    expect(document.body.contains(seen)).toBe(false);
  });
});

describe('readSaveFileOutcome', () => {
  it('reads a valid answer and drops junk', () => {
    expect(readSaveFileOutcome({ id: 'a', state: 'shared' })).toEqual({ id: 'a', state: 'shared' });
    expect(readSaveFileOutcome({ id: 'a', state: 'failed', message: 'x'.repeat(300) })?.message).toHaveLength(200);
    expect(readSaveFileOutcome({ id: 'a', state: 'weird' })).toBeNull();
    expect(readSaveFileOutcome(null)).toBeNull();
  });
});
