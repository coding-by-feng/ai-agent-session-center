// accountDevices.test.ts — a device's kind and system in words, for RESOURCES → Machines › Devices on your account.
import { describe, it, expect } from 'vitest';
import { deviceWords } from './accountDevices';

type Parts = Parameters<typeof deviceWords>[0];
const parts = (over: Partial<Parts>): Parts => ({ kind: null, platform: null, edition: null, appVersion: null, ...over });

describe('deviceWords', () => {
  it.each<[string, Partial<Parts>, string]>([
    // The account calls every AASC host `server`, a MacBook included: the system and the edition say what it is.
    ['a Mac running the Full app', { kind: 'server', platform: 'macos', edition: 'full', appVersion: '2.10.80' }, 'Mac · macOS · Full 2.10.80'],
    ['a Mac running Lite', { kind: 'server', platform: 'macos', edition: 'lite', appVersion: '2.10.80' }, 'Mac · macOS · Lite 2.10.80'],
    ['a Windows computer', { kind: 'server', platform: 'windows', edition: 'full', appVersion: '2.10.80' }, 'Computer · Windows · Full 2.10.80'],
    ['a Linux desktop', { kind: 'server', platform: 'linux', edition: 'lite', appVersion: '2.10.80' }, 'Computer · Linux · Lite 2.10.80'],
    // Only the headless edition is a server in a person's words; "Server · Linux · Server 2.10.80" would say it twice.
    ['a headless server', { kind: 'server', platform: 'linux', edition: 'server', appVersion: '2.10.80' }, 'Server · Linux · 2.10.80'],
    ['a headless server on a Mac', { kind: 'server', platform: 'macos', edition: 'server', appVersion: '2.10.80' }, 'Server · macOS · 2.10.80'],
    ['a headless server that says no more', { kind: 'server', edition: 'server' }, 'Server'],
    // An AASC from before it reported its system: it is some computer, and "Server" would mislabel a laptop.
    ['a computer that says nothing else', { kind: 'server' }, 'Computer'],
    ['a computer on a system not known here', { kind: 'server', platform: 'freebsd', edition: 'full' }, 'Computer · freebsd · Full'],
    ['a Client app', { kind: 'server', platform: 'macos', edition: 'client' }, 'Mac · macOS · Client'],
    // `mac` is read the same way, should a backend say it.
    ['kind mac on macOS', { kind: 'mac', platform: 'macos', edition: 'full', appVersion: '2.10.80' }, 'Mac · macOS · Full 2.10.80'],
    ['kind mac on Windows', { kind: 'mac', platform: 'windows', edition: 'full', appVersion: '2.10.80' }, 'Computer · Windows · Full 2.10.80'],
    ['a phone that says nothing else', { kind: 'phone' }, 'Phone'],
    ['a phone with its system and version', { kind: 'phone', platform: 'ios', appVersion: '1.1.0' }, 'Phone · iOS · 1.1.0'],
    ['an Android phone', { kind: 'phone', platform: 'android' }, 'Phone · Android'],
    ['a kind a later backend adds', { kind: 'tablet', platform: 'ipados', edition: 'beta', appVersion: '3.0' }, 'tablet · ipados · beta 3.0'],
    ['a version alone', { appVersion: '2.10.80' }, '2.10.80'],
    ['nothing known', {}, ''],
  ])('%s', (_label, device, words) => {
    expect(deviceWords(parts(device))).toBe(words);
  });
});
